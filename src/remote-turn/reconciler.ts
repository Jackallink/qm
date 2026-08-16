import { createSweeper, type Sweeper } from "../util/sweeper.ts";
import { createNoopLeaderLease, type LeaderLease } from "../persistence/leader-lease.ts";
import type { ErrorLog } from "../admin/error-log.ts";
import type { ScopeId } from "../types.ts";
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
  errors?: ErrorLog;
}

export function createRemoteTurnReconciler(opts: ReconcileOptions): RemoteTurnReconciler {
  const leaderLease = opts.leaderLease ?? createNoopLeaderLease();
  const clock = opts.clock ?? Date.now;
  const parkedAlertMs = opts.parkedAlertMs ?? 24 * 60 * 60 * 1000;

  function evidenceDigestFor(remoteTurnId: string, state: SandboxState): string {
    const canonical = [
      remoteTurnId,
      state.exists ? "1" : "0",
      state.running ? "1" : "0",
      state.startProofSeen ? "1" : "0",
      state.terminationSeen ? "1" : "0",
    ].join(":");
    return sha256Hex(canonical);
  }

  function outcomeFor(turn: ParkedTurnRecord, state: SandboxState): ReconcileOutcome | null {
    if (!state.exists && !state.startProofSeen) return "failed";
    if (state.startProofSeen && turn.reply !== null && !state.running) return "completed";
    if (state.terminationSeen) return "cancelled";
    return null;
  }

  async function reconcileSweep(): Promise<{ reconciled: number; alerts: string[] }> {
    const nowMs = clock();
    const parked: ParkedTurnRecord[] = await opts.store.listParked();
    const expiredActive = await opts.store.listExpiredActive();
    const expiredDispatching = await opts.store.listExpiredDispatching(nowMs);
    const cancelRequested = await opts.store.listCancelRequested();
    for (const turn of [...parked, ...expiredActive, ...cancelRequested]) {
      await opts.store.renewRemoteLease(turn.remoteTurnId);
    }
    let reconciled = 0;
    const alerts: string[] = [];
    for (const turn of parked) {
      const state = await opts.attestor.querySandboxState(turn.remoteTurnId);
      if (turn.parkedAt !== null && nowMs - turn.parkedAt > parkedAlertMs) {
        const alert = `remote_turn:${turn.remoteTurnId} parked > ${parkedAlertMs}ms (reservation held, no auto-charge)`;
        alerts.push(alert);
        opts.errors?.record({
          category: "remote-turn",
          code: "remote_turn_parked_long",
          message: alert,
          scopeLabel: RECONCILE_LEASE_KEY as ScopeId,
        });
      }
      const outcome = outcomeFor(turn, state);
      if (!outcome) continue;
      const result = await opts.store.reconcile({
        remoteTurnId: turn.remoteTurnId,
        outcome,
        evidenceDigest: evidenceDigestFor(turn.remoteTurnId, state),
      });
      if (result.ok && result.outcome === outcome) reconciled += 1;
    }
    for (const turn of expiredActive) {
      const expired = await opts.store.expireActiveTurn(turn.remoteTurnId);
      if (expired) reconciled += 1;
    }
    for (const turn of expiredDispatching) {
      const result = await opts.store.expirePreClaim(turn.remoteTurnId, nowMs);
      if (result === "expired") reconciled += 1;
    }
    for (const turn of cancelRequested) {
      const state = await opts.attestor.querySandboxState(turn.remoteTurnId);
      if (!state.terminationSeen) continue;
      const result = await opts.store.terminateTurn({ remoteTurnId: turn.remoteTurnId, actor: "remote-turn-reconciler" });
      if (result.ok && result.status === "cancelled") reconciled += 1;
    }
    for (const orphan of await opts.store.listOrphanRuns()) {
      const failed = await opts.store.failOrphanRun(orphan.coreRunId, orphan.leaseToken);
      if (failed) reconciled += 1;
    }
    return { reconciled, alerts };
  }

  async function sweep(): Promise<{ reconciled: number; alerts: string[] }> {
    const result = await leaderLease.hold(RECONCILE_LEASE_KEY, reconcileSweep);
    return result ?? { reconciled: 0, alerts: [] };
  }

  const sweeper: Sweeper = createSweeper(
    () => leaderLease.hold(RECONCILE_LEASE_KEY, reconcileSweep),
    opts.intervalMs ?? 15_000,
    { label: "remote-turn-reconciler" },
  );

  return {
    start: () => sweeper.start(),
    stop: () => sweeper.stop(),
    sweep,
  };
}
