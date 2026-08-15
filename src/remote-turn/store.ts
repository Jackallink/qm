import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { sharedPgPool, withPgTransaction, type PgPool } from "../persistence/pg-pool.ts";
import { REMOTE_TURN_DDL_ALL, REMOTE_TURN_RUN_DDL, REMOTE_TURN_SESSION_DDL } from "./schema.ts";
import { nextState, type RemoteTurnEvent, type RemoteTurnStatus } from "./state-machine.ts";
import { deriveWindowAnchorMs, createRemoteBudgetLedger, type RemoteBudgetLedger } from "./budget-ledger.ts";
import { computeEnvelopeDigest, computeHistoryDigest, computeInputDigest, type RemoteTurnHistoryMessage } from "./envelope.ts";
import { getOrCreateByThreadOn } from "../sessions/postgres-session-store.ts";
import { createPostgresRunStore } from "../runs/postgres-run-store.ts";
import type { RunStore } from "../runs/run-store.ts";
import type { TurnResult } from "../types.ts";
import { csprngHex, mintAbortToken, sha256Hex, verifyReceipt } from "./tokens.ts";
import { createAttestationVerifier, type PreClaimClaims, type StartProofClaims } from "./attestation.ts";
export type { PreClaimClaims };
import { createRemoteBindingStore, type KeySetEntry } from "./binding-store.ts";

export interface G0Context {
  actorId: string;
  scopeId: string;
  conversationKey: string;
  governanceDecisionId: string;
  governanceAuthorizationDigest: string;
  traceId: string;
}

export interface AdmitInput {
  bindingId: string;
  g0: G0Context;
  coreRunId: string;
  conversationKey: string;
  scopeId: string;
  actorId: string;
  text: string;
  history: readonly RemoteTurnHistoryMessage[];
  threadRef: string;
}

export type RefusalReason =
  | "governance_authorization_required"
  | "runtime_not_enabled"
  | "remote_input_invalid"
  | "remote_turn_active"
  | "budget_insufficient"
  | "remote_run_exists";

export type AdmitResult =
  | { status: "admitted"; remoteTurnId: string; coreRunId: string; runLeaseToken: string }
  | { status: "refused"; reason: RefusalReason };

export type OnStep = (label: OnStepLabel, client: PoolClient) => void | Promise<void>;

export type OnStepLabel = "session-bound" | "remote-turn-insert" | "reservation+audit" | "pre-commit";

export interface RemoteTurnStoreOptions {
  pool?: PgPool;
  now?: () => number;
  onStep?: OnStep;
  leaseTtlMs?: number;
  abortKey?: { kid: string; privateKeyPem: string };
  runs?: RunStore;
}

export interface ClaimInput {
  remoteTurnId: string;
  turnJtiHash: string;
  attestationNonceHash: string;
  verifiedPreClaim: PreClaimClaims | null;
  runtimeAudience: string;
  version: number;
}

export interface DispatchEnvelope {
  turnJti: string;
  attestationNonce: string;
}

export type DispatchResult =
  | { ok: true; dispatchAttempt: number; preClaimExpiresAt: number }
  | { ok: false; reason: "no_lease" | "not_dispatchable" | "envelope_mismatch" | "pre_claim_expired" };

export type ExpirePreClaimResult = "expired" | "not_expired" | "not_dispatchable";

export type LeaseResult =
  | { ok: true; executionLeaseHash: string; abortToken: string }
  | { ok: false; reason: "no_lease" | "attestation_invalid" };

export interface StartExecutionInput {
  remoteTurnId: string;
  startProofJws: string;
}

export type StartExecutionResult =
  | { ok: true }
  | { ok: false; reason: "not_startable" | "attestation_invalid" };

export interface ReceiveReceiptInput {
  remoteTurnId: string;
  receiptToken: string;
}

export type ReceiveReceiptResult =
  | { ok: true }
  | { ok: false; reason: "not_receivable" | "receipt_invalid" };

export interface BeginTeardownInput {
  remoteTurnId: string;
  trustedUsageUsd: number | null;
  invalidMetering: boolean;
}

export interface TerminationEvidence {
  sandboxDeleted: boolean;
  egressRevoked: boolean;
  proofDigest: string;
}

export interface AbortInput {
  remoteTurnId: string;
  actor: string;
}

export type AbortResult =
  | { ok: true; status: "cancel_requested" }
  | { ok: false; reason: "not_found" | "not_abortable" | "already_cancelled" | "parked" };

export type DisableTargetOutcome = "cancelled" | "parked" | "failed";

export interface DisableTargetResult {
  remoteTurnId: string;
  outcome: DisableTargetOutcome;
}

export type DisableResult =
  | { ok: true; bindingVersion: number; targets: DisableTargetResult[] }
  | { ok: false; reason: "binding_not_found" };

export type ReconcileOutcome = "completed" | "cancelled" | "failed";

export type ReconcileResult =
  | { ok: true; outcome: ReconcileOutcome }
  | { ok: false; reason: "not_reconciliable" | "not_found" };

export interface ParkedTurnRecord {
  remoteTurnId: string;
  coreRunId: string;
  bindingId: string;
  parkedAt: number | null;
  reply: string | null;
}

export interface ExpiredDispatchingRecord {
  remoteTurnId: string;
  coreRunId: string;
}

export interface RemoteTurnStore {
  admit(input: AdmitInput): Promise<AdmitResult>;
  claim(input: ClaimInput): Promise<LeaseResult>;
  prepareDispatch(input: { remoteTurnId: string; leaseToken: string; envelope: DispatchEnvelope }): Promise<DispatchResult>;
  expirePreClaim(remoteTurnId: string, now: number): Promise<ExpirePreClaimResult>;
  expireAdmissions(now: number): Promise<number>;
  startExecution(input: StartExecutionInput): Promise<StartExecutionResult>;
  receiveReceipt(input: ReceiveReceiptInput): Promise<ReceiveReceiptResult>;
  beginTeardown(input: BeginTeardownInput): Promise<"teardown_pending" | "parked" | "not_ready">;
  completeTeardown(input: {
    remoteTurnId: string;
    evidence: TerminationEvidence;
  }): Promise<"completed" | "parked" | "not_ready">;
  abort(input: AbortInput): Promise<AbortResult>;
  disable(input: { bindingId: string; actor: string }): Promise<DisableResult>;
  listParked(): Promise<ParkedTurnRecord[]>;
  listExpiredDispatching(now: number): Promise<ExpiredDispatchingRecord[]>;
  reconcile(input: { remoteTurnId: string; outcome: ReconcileOutcome; evidenceDigest: string }): Promise<ReconcileResult>;
  close(): Promise<void>;
}

const ADMISSION_WINDOW_SEC = 5 * 60;
const ADMISSION_WINDOW_MS = ADMISSION_WINDOW_SEC * 1000;
const PRE_CLAIM_WINDOW_SEC = 90;

const errorGuardedClients = new WeakSet<PoolClient>();

function guardClientErrors(client: PoolClient): void {
  if (errorGuardedClients.has(client)) return;
  errorGuardedClients.add(client);
  client.on("error", () => {});
}


function refusal(reason: RefusalReason): never {
  throw new Error(`remote admission refused: ${reason}`);
}

export function createRemoteTurnStore(connectionString: string, opts: RemoteTurnStoreOptions = {}): RemoteTurnStore {
  const pool: PgPool = opts.pool ?? sharedPgPool(connectionString, [
    ...REMOTE_TURN_RUN_DDL,
    ...REMOTE_TURN_SESSION_DDL,
    ...REMOTE_TURN_DDL_ALL,
  ]);
  const now = opts.now ?? (() => Date.now());
  const leaseTtlMs = opts.leaseTtlMs ?? 5 * 60_000;
  const ledger: RemoteBudgetLedger = createRemoteBudgetLedger(connectionString);
  const runs: RunStore = opts.runs ?? createPostgresRunStore(connectionString).runs;
  const bindingStore = createRemoteBindingStore(connectionString);
  const attestation = createAttestationVerifier({ now });

  const onStep = opts.onStep ?? (() => {});
  const leaseHolder = (remoteTurnId: string): string => `remote_turn:${remoteTurnId}`;

  async function markRunFailed(runId: string): Promise<void> {
    await pool.q(
      "UPDATE runs SET status='failed', finished_at=$2 WHERE id=$1 AND delivery_mode='remote_once' AND status='pending'",
      [runId, now()],
    );
  }

  async function recordDenial(remoteTurnId: string, reason: RefusalReason): Promise<void> {
    await pool.q(
      "INSERT INTO remote_turn_events(remote_turn_id, seq, event_type, payload, created_at) VALUES($1, 1, 'refused', $2, $3)",
      [remoteTurnId, JSON.stringify({ reason }), now()],
    );
  }

  async function admit(input: AdmitInput): Promise<AdmitResult> {
    const remoteTurnId = randomUUID();
    const runLeaseToken = randomUUID();
    const t0 = now();

    const { rowCount: runInserted } = await pool.query(
      `INSERT INTO runs(id, session_id, status, request, idempotency_key, attempts, max_attempts, delivery_mode, lease_token, lease_expires_at, created_at)
       VALUES ($1,$2,'pending',$3,NULL,0,3,'remote_once',$4,$5,$6)
       ON CONFLICT (id) DO NOTHING`,
      [input.coreRunId, input.threadRef, JSON.stringify({ text: input.text }), runLeaseToken, t0 + ADMISSION_WINDOW_MS, t0],
    );
    if (runInserted !== 1) {
      return { status: "refused", reason: "remote_run_exists" };
    }

    let refusalReason: RefusalReason | null = null;
    try {
      await withPgTransaction(await pool.pool(), async (client) => {
        guardClientErrors(client);
        const { rows: bindingRows } = await client.query<Record<string, unknown>>(
          `SELECT id, version, enabled, allowed_scope_id, max_input_bytes, max_history_messages, budget_ceiling_usd, release_digest, key_sets
           FROM remote_runtime_binding WHERE id=$1 FOR UPDATE`,
          [input.bindingId],
        );
        const binding = bindingRows[0];
        if (!binding || !binding.enabled) refusal("runtime_not_enabled");
        if (binding!.allowed_scope_id !== input.scopeId) refusal("runtime_not_enabled");
        const keySets = (binding!.key_sets as Record<string, KeySetEntry[]> | null) ?? {};
        const receiptKeySnapshot = keySets.receipt ?? [];

        if (
          input.g0.actorId !== input.actorId ||
          input.g0.scopeId !== input.scopeId ||
          input.g0.conversationKey !== input.conversationKey ||
          !input.g0.governanceDecisionId ||
          !input.g0.governanceAuthorizationDigest ||
          !input.g0.traceId
        ) {
          refusal("governance_authorization_required");
        }

        const textBytes = Buffer.byteLength(input.text, "utf8");
        if (!input.text.trim() || textBytes > Number(binding!.max_input_bytes)) refusal("remote_input_invalid");
        if (input.history.length > Number(binding!.max_history_messages)) refusal("remote_input_invalid");

        const session = await getOrCreateByThreadOn(
          client,
          input.threadRef,
          "dm",
          input.scopeId,
          undefined,
          "web",
        );
        await onStep("session-bound", client);

        const holder = leaseHolder(remoteTurnId);
        const { rowCount: leaseAcquired } = await client.query(
          `INSERT INTO session_leases(session_id, token, expires_at, holder, acquired_at)
             VALUES ($1,$2,$3,$5,$4)
           ON CONFLICT (session_id) DO UPDATE
             SET token = $2, expires_at = $3, holder = $5, acquired_at = $4
             WHERE session_leases.expires_at <= $4
           RETURNING token`,
          [session.id, randomUUID(), now() + leaseTtlMs, now(), holder],
        );
        if (leaseAcquired !== 1) refusal("remote_turn_active");

        const bindingVersion = Number(binding!.version);
        const inputDigest = computeInputDigest(input.text);
        const historyDigest = computeHistoryDigest(input.history);
        const envelopeDigest = computeEnvelopeDigest({
          remoteTurnId,
          bindingVersion,
          conversationKey: input.conversationKey,
          scopeId: input.scopeId,
          qmSessionId: session.id,
          coreRunId: input.coreRunId,
          inputDigest,
          historyDigest,
        });

        const admissionKey = sha256Hex(
          [input.coreRunId, String(bindingVersion), input.scopeId, input.conversationKey, inputDigest].join("|"),
        );
        const createdAt = now();
        await client.query(
          `INSERT INTO remote_turn(
            id, core_run_id, admission_key, conversation_key, scope_id, actor_id, qm_session_id,
            governance_authorization_digest, governance_decision_id, binding_id, binding_version,
            input_digest, envelope_digest, history_digest, release_digest, receipt_key_snapshot, status, version,
            pre_admission_expires_at, correlation_id, created_at, updated_at
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,1,
            (SELECT extract(epoch from transaction_timestamp())) + $18, $19, $20, $20)`,
          [
            remoteTurnId, input.coreRunId, admissionKey, input.conversationKey, input.scopeId, input.actorId,
            session.id, input.g0.governanceAuthorizationDigest, input.g0.governanceDecisionId,
            input.bindingId, bindingVersion, inputDigest, envelopeDigest, historyDigest,
            binding!.release_digest as string, JSON.stringify(receiptKeySnapshot), "created", ADMISSION_WINDOW_SEC, input.g0.traceId, createdAt,
          ],
        );
        await onStep("remote-turn-insert", client);

        const advance = async (from: RemoteTurnStatus, event: Parameters<typeof nextState>[1]): Promise<void> => {
          const to = nextState(from, event);
          const { rowCount } = await client.query(
            "UPDATE remote_turn SET status=$2, version=version+1, updated_at=$3 WHERE id=$1 AND status=$4",
            [remoteTurnId, to, now(), from],
          );
          if (rowCount !== 1) throw new Error(`remote turn ${remoteTurnId} lost a state transition ${from}->${to}`);
        };
        await advance("created", "session_bind");
        await advance("session_bound", "admit");

        await client.query(
          "INSERT INTO remote_turn_events(remote_turn_id, seq, event_type, payload, created_at) VALUES($1,1,$2,$3,$4)",
          [remoteTurnId, "session_bind", JSON.stringify({ sessionId: session.id }), now()],
        );
        await client.query(
          "INSERT INTO remote_turn_events(remote_turn_id, seq, event_type, payload, created_at) VALUES($1,2,$2,$3,$4)",
          [remoteTurnId, "admit", JSON.stringify({}), now()],
        );

        const reservation = await ledger.reserveBudget(client, {
          scopeId: input.scopeId,
          bindingId: input.bindingId,
          remoteTurnId,
          ceilingUsd: Number(binding!.budget_ceiling_usd),
          seedUsd: Number(binding!.budget_ceiling_usd),
          windowAnchorMs: deriveWindowAnchorMs(now(), 60 * 60_000),
        });
        if (reservation.status === "insufficient") refusal("budget_insufficient");
        await onStep("reservation+audit", client);
        await onStep("pre-commit", client);
        return true;
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const reason = (["governance_authorization_required", "runtime_not_enabled", "remote_input_invalid", "remote_turn_active", "budget_insufficient"] as const).find(
        (r) => message.includes(r),
      );
      if (!reason) throw error;
      refusalReason = reason;
    }

    if (refusalReason) {
      await markRunFailed(input.coreRunId);
      await recordDenial(input.coreRunId, refusalReason);
      return { status: "refused", reason: refusalReason };
    }

    return { status: "admitted", remoteTurnId, coreRunId: input.coreRunId, runLeaseToken };
  }

  const abortKey = opts.abortKey ?? null;

  async function claim(input: ClaimInput): Promise<LeaseResult> {
    await pool.pool();
    if (!abortKey) return { ok: false, reason: "attestation_invalid" };
    if (!input.verifiedPreClaim) return { ok: false, reason: "attestation_invalid" };
    const verified = input.verifiedPreClaim;
    if (
      verified.turnJtiHash !== input.turnJtiHash ||
      verified.attestationNonceHash !== input.attestationNonceHash ||
      verified.remoteTurnId !== input.remoteTurnId
    ) {
      await recordAttestationDenial(input.remoteTurnId);
      return { ok: false, reason: "attestation_invalid" };
    }

    const executionLease = csprngHex();
    const executionLeaseHash = sha256Hex(executionLease);
    const claimedAt = now();
    const claimedAtSec = Math.floor(claimedAt / 1000);

    const result = await withPgTransaction(await pool.pool(), async (client) => {
      guardClientErrors(client);
      const { rows } = await client.query(
        `UPDATE remote_turn SET status='claimed', execution_lease_hash=$2, workload_identity=$3, planned_sandbox_id=$4,
           version=version+1, updated_at=$5
         WHERE id=$1 AND status='dispatching' AND turn_jti_hash=$6 AND abort_requested_at IS NULL AND version=$7 AND binding_version=$8
         RETURNING core_run_id, binding_id, binding_version, turn_jti_hash`,
        [input.remoteTurnId, executionLeaseHash, verified.intendedWorkloadIdentity, verified.plannedSandboxId, claimedAt, input.turnJtiHash, input.version, verified.bindingVersion],
      );
      const row = rows[0];
      if (!row) return { ok: false as const, reason: "no_lease" as const };

      await client.query(
        "INSERT INTO remote_turn_events(remote_turn_id, seq, event_type, payload, created_at) VALUES($1,$2,$3,$4,$5)",
        [input.remoteTurnId, await nextEventSeq(client, input.remoteTurnId), "claim", JSON.stringify({ executionLeaseHash }), claimedAt],
      );

      const abortToken = await mintAbortToken(
        {
          kid: abortKey.kid,
          iss: "urn:qm:core",
          aud: input.runtimeAudience,
          iat: claimedAtSec,
          nbf: claimedAtSec,
          exp: claimedAtSec + 90,
          jti: csprngHex(),
          capability: "abort",
          remoteTurnId: input.remoteTurnId,
          bindingVersion: Number(row.binding_version),
          turnJtiHash: input.turnJtiHash,
          protocolVersion: 1,
          executionLeaseHash,
          coreRunId: row.core_run_id as string,
        },
        abortKey,
      );
      return { ok: true as const, executionLeaseHash, abortToken };
    });
    return result;
  }

  async function prepareDispatch(input: {
    remoteTurnId: string;
    leaseToken: string;
    envelope: DispatchEnvelope;
  }): Promise<DispatchResult> {
    const turnJtiHash = sha256Hex(input.envelope.turnJti);
    const nonceHash = sha256Hex(input.envelope.attestationNonce);

    return withPgTransaction(await pool.pool(), async (client) => {
      guardClientErrors(client);
      const { rows: runRows } = await client.query<{ lease_token: string | null }>(
        "SELECT lease_token FROM runs WHERE id=(SELECT core_run_id FROM remote_turn WHERE id=$1)",
        [input.remoteTurnId],
      );
      const runLease = runRows[0]?.lease_token ?? null;
      if (runLease !== input.leaseToken) return { ok: false as const, reason: "no_lease" as const };

      const { rows: turnRows } = await client.query<Record<string, unknown>>(
        `SELECT status, turn_jti_hash, attestation_nonce_hash, version, pre_claim_expires_at
         FROM remote_turn WHERE id=$1 FOR UPDATE`,
        [input.remoteTurnId],
      );
      const turn = turnRows[0];
      if (!turn) return { ok: false as const, reason: "no_lease" as const };

      const status = turn.status as string;
      const storedJtiHash = (turn.turn_jti_hash as string | null) ?? null;
      const storedNonceHash = (turn.attestation_nonce_hash as string | null) ?? null;
      const nowMs = now();

      if (status === "admitted" && storedJtiHash === null) {
        const { rows: updated } = await client.query<Record<string, unknown>>(
          `UPDATE remote_turn
           SET status='dispatching', turn_jti_hash=$2, attestation_nonce_hash=$3,
               dispatch_owner=$4, dispatch_attempt=1, dispatch_started_at=$5,
               pre_claim_expires_at=(SELECT extract(epoch from transaction_timestamp())) + $6,
               version=version+1, updated_at=$5
           WHERE id=$1 AND status='admitted' AND turn_jti_hash IS NULL AND version=$7
           RETURNING version, pre_claim_expires_at, dispatch_attempt`,
          [
            input.remoteTurnId, turnJtiHash, nonceHash, "dispatch-coordinator",
            nowMs,
            PRE_CLAIM_WINDOW_SEC,
            Number(turn.version),
          ],
        );
        const row = updated[0];
        if (!row) return { ok: false as const, reason: "not_dispatchable" as const };
        await client.query(
          "INSERT INTO remote_turn_events(remote_turn_id, seq, event_type, payload, created_at) VALUES($1,$2,'prepare_dispatch',$3,$4)",
          [input.remoteTurnId, await nextEventSeq(client, input.remoteTurnId), JSON.stringify({ dispatchAttempt: 1 }), nowMs],
        );
        return {
          ok: true as const,
          dispatchAttempt: 1,
          preClaimExpiresAt: Number(row.pre_claim_expires_at),
        };
      }

      if (status === "dispatching") {
        if (storedJtiHash !== turnJtiHash || storedNonceHash !== nonceHash) {
          return { ok: false as const, reason: "envelope_mismatch" as const };
        }
        const { rows: bumped } = await client.query<{ dispatch_attempt: number; pre_claim_expires_at: number }>(
          `UPDATE remote_turn SET dispatch_attempt=dispatch_attempt+1, updated_at=$2
           WHERE id=$1 AND status='dispatching'
             AND (SELECT extract(epoch from transaction_timestamp())) <= pre_claim_expires_at
           RETURNING dispatch_attempt, pre_claim_expires_at`,
          [input.remoteTurnId, nowMs],
        );
        const row = bumped[0];
        if (!row) return { ok: false as const, reason: "pre_claim_expired" as const };
        return {
          ok: true as const,
          dispatchAttempt: row.dispatch_attempt,
          preClaimExpiresAt: Number(row.pre_claim_expires_at),
        };
      }

      return { ok: false as const, reason: "not_dispatchable" as const };
    });
  }

  async function expirePreClaim(remoteTurnId: string, now: number): Promise<ExpirePreClaimResult> {
    return withPgTransaction(await pool.pool(), async (client) => {
      guardClientErrors(client);
      const { rows } = await client.query<Record<string, unknown>>(
        "SELECT status, version, core_run_id, pre_claim_expires_at FROM remote_turn WHERE id=$1 FOR UPDATE",
        [remoteTurnId],
      );
      const turn = rows[0];
      if (!turn) return "not_dispatchable";
      if (turn.status !== "dispatching") return "not_dispatchable";
      const expiresAt = Number(turn.pre_claim_expires_at);
      const nowSec = Math.floor(now / 1000);
      if (nowSec < expiresAt) return "not_expired";

      await client.query(
        "UPDATE remote_turn SET status='failed_pre_dispatch', version=version+1, updated_at=$2 WHERE id=$1 AND status='dispatching'",
        [remoteTurnId, now],
      );
      await client.query(
        "INSERT INTO remote_turn_events(remote_turn_id, seq, event_type, payload, created_at) VALUES($1,$2,'expire_pre_dispatch',$3,$4)",
        [remoteTurnId, await nextEventSeq(client, remoteTurnId), JSON.stringify({}), now],
      );

      const { rows: reservationRows } = await client.query<{ id: string }>(
        "SELECT id FROM budget_reservations WHERE remote_turn_id=$1",
        [remoteTurnId],
      );
      if (reservationRows[0]) {
        await ledger.settleReservation(client, { remoteTurnId, trustedUsageUsd: 0, invalidMetering: false });
      }
      await client.query(
        "DELETE FROM session_leases WHERE holder=$1",
        [`remote_turn:${remoteTurnId}`],
      );
      const coreRunId = turn.core_run_id as string;
      await markRunFailedOnClient(client, coreRunId, now);
      return "expired";
    });
  }

  async function expireAdmissions(now: number): Promise<number> {
    return withPgTransaction(await pool.pool(), async (client) => {
      guardClientErrors(client);
      const { rows } = await client.query<Record<string, unknown>>(
        `SELECT id, core_run_id FROM remote_turn
         WHERE status IN ('created','session_bound','admitted')
           AND pre_admission_expires_at IS NOT NULL
           AND pre_admission_expires_at <= $1
         FOR UPDATE SKIP LOCKED`,
        [Math.floor(now / 1000)],
      );
      for (const turn of rows) {
        const remoteTurnId = turn.id as string;
        const coreRunId = turn.core_run_id as string;
        await client.query(
          "UPDATE remote_turn SET status='rejected', version=version+1, updated_at=$2 WHERE id=$1 AND status IN ('created','session_bound','admitted')",
          [remoteTurnId, now],
        );
        await client.query(
          "INSERT INTO remote_turn_events(remote_turn_id, seq, event_type, payload, created_at) VALUES($1,$2,'reject_deadline',$3,$4)",
          [remoteTurnId, await nextEventSeq(client, remoteTurnId), JSON.stringify({}), now],
        );
        const { rows: reservationRows } = await client.query<{ id: string }>(
          "SELECT id FROM budget_reservations WHERE remote_turn_id=$1",
          [remoteTurnId],
        );
        if (reservationRows[0]) {
          await ledger.settleReservation(client, { remoteTurnId, trustedUsageUsd: 0, invalidMetering: false });
        }
        await client.query(
          "DELETE FROM session_leases WHERE holder=$1",
          [`remote_turn:${remoteTurnId}`],
        );
        await markRunFailedOnClient(client, coreRunId, now);
      }
      return rows.length;
    });
  }

  async function markRunFailedOnClient(client: PoolClient, coreRunId: string, finishedAt: number): Promise<void> {
    const { rowCount } = await client.query(
      "UPDATE runs SET status='failed', finished_at=$2 WHERE id=$1 AND delivery_mode='remote_once' AND status='pending'",
      [coreRunId, finishedAt],
    );
    if (rowCount !== 1) {
      await client.query(
        "UPDATE runs SET status='failed', finished_at=$2 WHERE id=$1 AND delivery_mode='remote_once' AND status='running'",
        [coreRunId, finishedAt],
      );
    }
  }

  async function recordAttestationDenial(remoteTurnId: string): Promise<void> {
    try {
      await withPgTransaction(await pool.pool(), async (client) => {
        guardClientErrors(client);
        await client.query(
          "INSERT INTO remote_turn_events(remote_turn_id, seq, event_type, payload, created_at) VALUES($1,$2,$3,$4,$5)",
          [remoteTurnId, await nextEventSeq(client, remoteTurnId), "attestation_invalid", JSON.stringify({ reason: "attestation_mismatch" }), now()],
        );
      });
    } catch {
      void 0;
    }
  }

  async function nextEventSeq(client: PoolClient, remoteTurnId: string): Promise<number> {
    const { rows } = await client.query<{ max_seq: number | null }>(
      "SELECT COALESCE(MAX(seq), 0) + 1 AS max_seq FROM remote_turn_events WHERE remote_turn_id=$1",
      [remoteTurnId],
    );
    return Number(rows[0]?.max_seq ?? 1);
  }

  async function advanceState(
    client: PoolClient,
    remoteTurnId: string,
    from: RemoteTurnStatus,
    event: Parameters<typeof nextState>[1],
  ): Promise<boolean> {
    const to = nextState(from, event);
    if (to === "parked") {
      const { rowCount } = await client.query(
        "UPDATE remote_turn SET status=$2, version=version+1, updated_at=$3, parked_at=$3 WHERE id=$1 AND status=$4",
        [remoteTurnId, to, now(), from],
      );
      return rowCount === 1;
    }
    const { rowCount } = await client.query(
      "UPDATE remote_turn SET status=$2, version=version+1, updated_at=$3 WHERE id=$1 AND status=$4",
      [remoteTurnId, to, now(), from],
    );
    return rowCount === 1;
  }

  async function writeEvent(
    client: PoolClient,
    remoteTurnId: string,
    eventType: string,
    payload: unknown,
  ): Promise<void> {
    await client.query(
      "INSERT INTO remote_turn_events(remote_turn_id, seq, event_type, payload, created_at) VALUES($1,$2,$3,$4,$5)",
      [remoteTurnId, await nextEventSeq(client, remoteTurnId), eventType, JSON.stringify(payload ?? {}), now()],
    );
  }

  async function readTurn(
    client: PoolClient,
    remoteTurnId: string,
  ): Promise<Record<string, unknown> | null> {
    const { rows } = await client.query<Record<string, unknown>>(
      `SELECT id, status, version, core_run_id, qm_session_id, binding_id, binding_version, turn_jti_hash, execution_lease_hash,
              input_digest, release_digest, workload_identity, planned_sandbox_id, reply, output_bytes, receipt_key_snapshot
       FROM remote_turn WHERE id=$1 FOR UPDATE`,
      [remoteTurnId],
    );
    return rows[0] ?? null;
  }

  async function bindingAttestorKeys(bindingId: string): Promise<KeySetEntry[]> {
    const binding = await bindingStore.getBinding(bindingId);
    return binding?.attestorKeys ?? [];
  }

  async function bindingReceiptKeysSnapshot(turn: Record<string, unknown>): Promise<KeySetEntry[]> {
    const snapshot = turn.receipt_key_snapshot as unknown;
    if (Array.isArray(snapshot)) return snapshot as KeySetEntry[];
    const binding = await bindingStore.getBinding(turn.binding_id as string);
    return binding?.receiptKeys ?? [];
  }

  async function parkTurn(client: PoolClient, remoteTurnId: string, reason: string): Promise<void> {
    const advanced = await advanceState(client, remoteTurnId, "claimed", "attestation_invalid");
    if (!advanced) throw new Error(`remote turn ${remoteTurnId} could not park from claimed`);
    await writeEvent(client, remoteTurnId, "attestation_invalid", { reason });
  }

  async function startExecution(input: StartExecutionInput): Promise<StartExecutionResult> {
    return withPgTransaction(await pool.pool(), async (client) => {
      guardClientErrors(client);
      const turn = await readTurn(client, input.remoteTurnId);
      if (!turn || turn.status !== "claimed") return { ok: false as const, reason: "not_startable" as const };
      const attestorKeys = await bindingAttestorKeys(turn.binding_id as string);
      const verified = await attestation.verifyStartProof(input.startProofJws, {
        attestationKeySet: attestorKeys,
        expected: {
          executionLeaseHash: turn.execution_lease_hash as string,
          plannedSandboxId: turn.planned_sandbox_id as string,
          intendedWorkloadIdentity: turn.workload_identity as string,
          turnJtiHash: turn.turn_jti_hash as string,
        },
      });
      if (!verified) {
        await parkTurn(client, input.remoteTurnId, "runtime_attestation_invalid");
        return { ok: false as const, reason: "attestation_invalid" as const };
      }
      const advanced = await advanceState(client, input.remoteTurnId, "claimed", "start");
      if (!advanced) return { ok: false as const, reason: "not_startable" as const };
      await writeEvent(client, input.remoteTurnId, "start", { sandboxId: verified.sandboxId });
      return { ok: true as const };
    });
  }

  async function receiveReceipt(input: ReceiveReceiptInput): Promise<ReceiveReceiptResult> {
    return withPgTransaction(await pool.pool(), async (client) => {
      guardClientErrors(client);
      const turn = await readTurn(client, input.remoteTurnId);
      if (!turn) return { ok: false as const, reason: "not_receivable" as const };
      if (turn.status !== "executing") {
        const late = turn.status === "completed" || turn.status === "cancelled";
        await writeEvent(client, input.remoteTurnId, "duplicate_receipt", {
          reason: late ? "late_post_terminal" : "out_of_order",
        });
        return { ok: false as const, reason: "not_receivable" as const };
      }
      const receiptKeys = await bindingReceiptKeysSnapshot(turn);
      const verified = await verifyReceipt(input.receiptToken, receiptKeys, {
        remoteTurnId: input.remoteTurnId,
        bindingVersion: Number(turn.binding_version),
        executionLeaseHash: turn.execution_lease_hash as string,
        inputDigest: turn.input_digest as string,
        releaseDigest: (turn.release_digest as string | null) ?? "",
        now: now(),
      });
      if (!verified) {
        const parked = await advanceState(client, input.remoteTurnId, "executing", "park");
        if (parked) await writeEvent(client, input.remoteTurnId, "park", { reason: "receipt_unverified" });
        return { ok: false as const, reason: "receipt_invalid" as const };
      }
      const advanced = await advanceState(client, input.remoteTurnId, "executing", "receipt");
      if (!advanced) return { ok: false as const, reason: "not_receivable" as const };
      await client.query(
        "UPDATE remote_turn SET reply=$2, output_bytes=$3, receipt_digest=$4 WHERE id=$1",
        [input.remoteTurnId, verified.reply, verified.outputBytes, sha256Hex(input.receiptToken)],
      );
      await writeEvent(client, input.remoteTurnId, "receipt", { outputBytes: verified.outputBytes });
      return { ok: true as const };
    });
  }

  async function beginTeardown(input: BeginTeardownInput): Promise<"teardown_pending" | "parked" | "not_ready"> {
    return withPgTransaction(await pool.pool(), async (client) => {
      guardClientErrors(client);
      const turn = await readTurn(client, input.remoteTurnId);
      if (!turn || turn.status !== "reply_received") return "not_ready" as const;
      const settlement = await ledger.settleReservation(client, {
        remoteTurnId: input.remoteTurnId,
        trustedUsageUsd: input.trustedUsageUsd,
        invalidMetering: input.invalidMetering,
      });
      if (input.invalidMetering || settlement === "parked") {
        const parked = await advanceState(client, input.remoteTurnId, "reply_received", "park");
        if (parked) await writeEvent(client, input.remoteTurnId, "park", { reason: "metering_invalid" });
        return "parked" as const;
      }
      const advanced = await advanceState(client, input.remoteTurnId, "reply_received", "teardown");
      if (!advanced) return "not_ready" as const;
      await writeEvent(client, input.remoteTurnId, "teardown", { settlement });
      return "teardown_pending" as const;
    });
  }

  async function completeTeardown(input: {
    remoteTurnId: string;
    evidence: TerminationEvidence;
  }): Promise<"completed" | "parked" | "not_ready"> {
    if (!input.evidence.sandboxDeleted || !input.evidence.egressRevoked) {
      await withPgTransaction(await pool.pool(), async (client) => {
        guardClientErrors(client);
        const parked = await advanceState(client, input.remoteTurnId, "teardown_pending", "park");
        if (parked) await writeEvent(client, input.remoteTurnId, "park", { reason: "termination_unverified" });
      });
      return "parked";
    }
    const result = await withPgTransaction(await pool.pool(), async (client) => {
      guardClientErrors(client);
      const turn = await readTurn(client, input.remoteTurnId);
      if (!turn || turn.status !== "teardown_pending") return "not_ready" as const;
      const runId = turn.core_run_id as string;
      const reply = (turn.reply as string | null) ?? "";
      const sessionId = (turn.qm_session_id as string | null) ?? undefined;
      await client.query(
        "UPDATE remote_turn SET status='completed', termination_proof_digest=$2, version=version+1, updated_at=$3 WHERE id=$1 AND status='teardown_pending'",
        [input.remoteTurnId, sha256Hex(input.evidence.proofDigest), now()],
      );
      await writeEvent(client, input.remoteTurnId, "complete", { proofDigest: sha256Hex(input.evidence.proofDigest) });
      const { rows } = await client.query<{ lease_token: string | null }>(
        "SELECT lease_token FROM runs WHERE id=$1",
        [runId],
      );
      const runLeaseToken = rows[0]?.lease_token ?? null;
      if (!runLeaseToken) throw new Error(`remote turn ${input.remoteTurnId} completed but no run lease was found`);
      const completed = await runs.completeOn(client, runId, runLeaseToken, {
        status: "ok",
        reply,
        ...(sessionId ? { sessionId } : {}),
      } as TurnResult);
      if (!completed) {
        throw new Error(
          `remote turn ${input.remoteTurnId} completed but its run ${runId} could not be completed (lease/status mismatch)`,
        );
      }
      await client.query(
        "DELETE FROM session_leases WHERE holder=$1",
        [`remote_turn:${input.remoteTurnId}`],
      );
      return "completed" as const;
    });
    return result;
  }

  async function abortTurnOnClient(client: PoolClient, remoteTurnId: string, actor: string): Promise<AbortResult> {
    const turn = await readTurn(client, remoteTurnId);
    if (!turn) return { ok: false as const, reason: "not_found" as const };
    const status = turn.status as RemoteTurnStatus;
    const terminal = new Set<RemoteTurnStatus>([
      "completed",
      "rejected",
      "failed_pre_dispatch",
      "failed",
      "cancelled",
    ]);
    if (terminal.has(status)) return { ok: false as const, reason: "not_abortable" as const };
    if (status === "cancel_requested") return { ok: false as const, reason: "already_cancelled" as const };
    if (status === "parked") {
      await client.query("UPDATE remote_turn SET abort_requested_at=$2, updated_at=$3 WHERE id=$1", [
        remoteTurnId,
        now(),
        now(),
      ]);
      await writeEvent(client, remoteTurnId, "abort", { actor, parked: true });
      return { ok: false as const, reason: "parked" as const };
    }
    if (status === "created" || status === "session_bound" || status === "admitted") {
      await client.query("UPDATE remote_turn SET abort_requested_at=$2, updated_at=$3 WHERE id=$1", [
        remoteTurnId,
        now(),
        now(),
      ]);
      await writeEvent(client, remoteTurnId, "abort", { actor, pre_dispatch: true });
      return { ok: false as const, reason: "not_abortable" as const };
    }
    const event: Parameters<typeof nextState>[1] = status === "dispatching" ? "abort_pre_claim" : "abort";
    const advanced = await advanceState(client, remoteTurnId, status, event);
    if (!advanced) return { ok: false as const, reason: "not_abortable" as const };
    const abortJtiHash = sha256Hex(csprngHex());
    await client.query(
      "UPDATE remote_turn SET abort_jti_hash=$2, abort_requested_at=$3, updated_at=$4 WHERE id=$1",
      [remoteTurnId, abortJtiHash, now(), now()],
    );
    await writeEvent(client, remoteTurnId, event, { actor });
    await releaseTurnResources(client, remoteTurnId);
    await failRemoteRunOnClient(client, turn.core_run_id as string, `remote turn aborted by ${actor}`);
    return { ok: true as const, status: "cancel_requested" as const };
  }

  async function releaseTurnResources(client: PoolClient, remoteTurnId: string): Promise<void> {
    const { rows: reservationRows } = await client.query<{ id: string }>(
      "SELECT id FROM budget_reservations WHERE remote_turn_id=$1",
      [remoteTurnId],
    );
    if (reservationRows[0]) {
      await ledger.settleReservation(client, { remoteTurnId, trustedUsageUsd: 0, invalidMetering: false });
    }
    await client.query("DELETE FROM session_leases WHERE holder=$1", [`remote_turn:${remoteTurnId}`]);
  }

  async function failRemoteRunOnClient(client: PoolClient, coreRunId: string, error: string): Promise<void> {
    const { rows } = await client.query<{ lease_token: string | null }>(
      "SELECT lease_token FROM runs WHERE id=$1",
      [coreRunId],
    );
    const leaseToken = rows[0]?.lease_token ?? null;
    if (leaseToken) await runs.failOn(client, coreRunId, leaseToken, error);
  }

  async function abort(input: AbortInput): Promise<AbortResult> {
    return withPgTransaction(await pool.pool(), async (client) => {
      guardClientErrors(client);
      return abortTurnOnClient(client, input.remoteTurnId, input.actor);
    });
  }

  async function disable(input: { bindingId: string; actor: string }): Promise<DisableResult> {
    return withPgTransaction(await pool.pool(), async (client) => {
      guardClientErrors(client);
      let version: number;
      try {
        version = (await bindingStore.setEnabledOn(client, input.bindingId, false, input.actor)).version;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("does not exist")) {
          return { ok: false as const, reason: "binding_not_found" as const };
        }
        if (message.includes("version conflict")) {
          return { ok: false as const, reason: "binding_not_found" as const };
        }
        throw error;
      }
      const { rows } = await client.query<{ id: string }>(
        `SELECT id FROM remote_turn
         WHERE binding_id=$1 AND status IN ('dispatching','claimed','executing','reply_received','teardown_pending','cancel_requested','parked')
         FOR UPDATE`,
        [input.bindingId],
      );
      const targets: DisableTargetResult[] = [];
      for (const row of rows) {
        const result = await abortTurnOnClient(client, row.id, input.actor);
        const status = await readTurn(client, row.id);
        const turnStatus = status ? (status.status as RemoteTurnStatus) : null;
        let outcome: DisableTargetOutcome;
        if (result.ok) {
          outcome = "cancelled";
        } else if (turnStatus === "cancelled") {
          outcome = "cancelled";
        } else if (turnStatus === "cancel_requested") {
          outcome = "cancelled";
        } else if (turnStatus === "parked") {
          outcome = "parked";
        } else {
          outcome = "failed";
        }
        targets.push({ remoteTurnId: row.id, outcome });
      }
      return { ok: true as const, bindingVersion: version, targets };
    });
  }

  async function listParked(): Promise<ParkedTurnRecord[]> {
    const { rows } = await pool.query(
      "SELECT id, core_run_id, binding_id, parked_at, reply FROM remote_turn WHERE status='parked'",
    );
    return rows.map((row) => ({
      remoteTurnId: row.id as string,
      coreRunId: row.core_run_id as string,
      bindingId: row.binding_id as string,
      parkedAt: (row.parked_at as number | null) ?? null,
      reply: (row.reply as string | null) ?? null,
    }));
  }

  async function listExpiredDispatching(nowMs: number): Promise<ExpiredDispatchingRecord[]> {
    const nowSec = Math.floor(nowMs / 1000);
    const { rows } = await pool.query(
      "SELECT id, core_run_id FROM remote_turn WHERE status='dispatching' AND pre_claim_expires_at IS NOT NULL AND pre_claim_expires_at <= $1",
      [nowSec],
    );
    return rows.map((row) => ({
      remoteTurnId: row.id as string,
      coreRunId: row.core_run_id as string,
    }));
  }

  async function reconcile(input: {
    remoteTurnId: string;
    outcome: ReconcileOutcome;
    evidenceDigest: string;
  }): Promise<ReconcileResult> {
    return withPgTransaction(await pool.pool(), async (client) => {
      guardClientErrors(client);
      const turn = await readTurn(client, input.remoteTurnId);
      if (!turn) return { ok: false as const, reason: "not_found" as const };
      if (turn.status !== "parked") return { ok: false as const, reason: "not_reconciliable" as const };
      const event: RemoteTurnEvent =
        input.outcome === "completed"
          ? "reconcile_completed"
          : input.outcome === "cancelled"
            ? "reconcile_cancelled"
            : "reconcile_failed";
      const to = nextState("parked", event);
      const { rowCount } = await client.query(
        `UPDATE remote_turn SET status=$2, reconciled_from_state='parked', reconciliation_evidence_ref=$3,
           version=version+1, updated_at=$4
         WHERE id=$1 AND status='parked' AND version=$5`,
        [input.remoteTurnId, to, input.evidenceDigest, now(), Number(turn.version)],
      );
      if (rowCount !== 1) return { ok: false as const, reason: "not_reconciliable" as const };
      await writeEvent(client, input.remoteTurnId, event, { evidenceDigest: input.evidenceDigest });
      await releaseTurnResources(client, input.remoteTurnId);
      if (input.outcome === "completed") {
        const runId = turn.core_run_id as string;
        const reply = (turn.reply as string | null) ?? "";
        const sessionId = (turn.qm_session_id as string | null) ?? undefined;
        const { rows } = await client.query<{ lease_token: string | null }>(
          "SELECT lease_token FROM runs WHERE id=$1",
          [runId],
        );
        const leaseToken = rows[0]?.lease_token ?? null;
        if (!leaseToken) throw new Error(`remote turn ${input.remoteTurnId} reconciled completed but no run lease found`);
        const completed = await runs.completeOn(client, runId, leaseToken, {
          status: "ok",
          reply,
          ...(sessionId ? { sessionId } : {}),
        } as TurnResult);
        if (!completed) throw new Error(`remote turn ${input.remoteTurnId} could not complete its run`);
      } else {
        await failRemoteRunOnClient(client, turn.core_run_id as string, `reconciled ${input.outcome}`);
      }
      return { ok: true as const, outcome: input.outcome };
    });
  }

  return {
    admit,
    claim,
    prepareDispatch,
    expirePreClaim,
    expireAdmissions,
    startExecution,
    receiveReceipt,
    beginTeardown,
    completeTeardown,
    abort,
    disable,
    listParked,
    listExpiredDispatching,
    reconcile,
    async close(): Promise<void> {
      await pool.close();
    },
  };
}
