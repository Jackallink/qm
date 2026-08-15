import { createSweeper, type Sweeper } from "../util/sweeper.ts";
import { createNoopLeaderLease, type LeaderLease } from "../persistence/leader-lease.ts";
import { sha256Hex } from "./tokens.ts";
import type { ParkedTurnRecord, RemoteTurnStore, ReconcileOutcome } from "./store.ts";

export const RECONCILE_LEASE_KEY = "remote-turn:reconcile";

export interface SandboxState {
  exists: boolean;
  running: boolean;
  startProofSeen: boolean;
  terminationSeen: boolean;
}

export interface AttestorGateway {
  querySandboxState(remoteTurnId: string): Promise<SandboxState>;
}

export interface RemoteTurnReconciler {
  start(): void;
  stop(): void;
  sweep(): Promise<{ reconciled: number; alerts: string[] }>;
}

export interface ReconcileOptions {
  store: RemoteTurnStore;
  attestor: AttestorGateway;
  leaderLease?: LeaderLease;
  clock?: () => number;
  intervalMs?: number;
  parkedAlertMs?: number;
}

export function createRemoteTurnReconciler(opts: ReconcileOptions): RemoteTurnReconciler {
  const leaderLease = opts.leaderLease ?? createNoopLeaderLease();
  const clock = opts.clock ?? Date.now;
  const parkedAlertMs = opts.parkedAlertMs ?? 24 * 60 * 60 * 1000;

  function outcomeFor(state: SandboxState): ReconcileOutcome | null {
    if (!state.exists && !state.startProofSeen) return "failed";
    if (state.terminationSeen) return "cancelled";
    return null;
  }

  async function sweepInner(): Promise<{ reconciled: number; alerts: string[] }> {
    const parked: ParkedTurnRecord[] = await opts.store.listParked();
    let reconciled = 0;
    const alerts: string[] = [];
    for (const turn of parked) {
      const state = await opts.attestor.querySandboxState(turn.remoteTurnId);
      if (turn.parkedAt !== null && clock() - turn.parkedAt > parkedAlertMs) {
        alerts.push(
          `remote_turn:${turn.remoteTurnId} parked > ${parkedAlertMs}ms (reservation held, no auto-charge)`,
        );
      }
      const outcome = outcomeFor(state);
      if (!outcome) continue;
      const evidenceDigest = sha256Hex(`${turn.remoteTurnId}:${outcome}`);
      const result = await opts.store.reconcile({
        remoteTurnId: turn.remoteTurnId,
        outcome,
        evidenceDigest,
      });
      if (result.ok && result.outcome === outcome) reconciled += 1;
    }
    return { reconciled, alerts };
  }

  const sweeper: Sweeper = createSweeper(
    () => leaderLease.hold(RECONCILE_LEASE_KEY, sweepInner),
    opts.intervalMs ?? 15_000,
    { label: "remote-turn-reconciler" },
  );

  return {
    start: () => sweeper.start(),
    stop: () => sweeper.stop(),
    sweep: sweepInner,
  };
}
