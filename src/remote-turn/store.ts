import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { sharedPgPool, withPgTransaction, type PgPool, type Rows } from "../persistence/pg-pool.ts";
import { REMOTE_TURN_DDL_ALL, REMOTE_TURN_RUN_DDL, REMOTE_TURN_SESSION_DDL } from "./schema.ts";
import { nextState, type RemoteTurnStatus } from "./state-machine.ts";
import { deriveWindowAnchorMs, createRemoteBudgetLedger, type RemoteBudgetLedger } from "./budget-ledger.ts";
import { computeEnvelopeDigest, computeHistoryDigest, computeInputDigest } from "./envelope.ts";
import { getOrCreateByThreadOn } from "../sessions/postgres-session-store.ts";

export interface G0Context {
  actorId: string;
  scopeId: string;
  conversationKey: string;
  governanceDecisionId: string;
  governanceAuthorizationDigest: string;
  traceId: string;
}

export interface RemoteTurnHistoryMessage {
  role: "user" | "assistant";
  text: string;
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
  | "budget_insufficient";

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
}

export interface RemoteTurnStore {
  admit(input: AdmitInput): Promise<AdmitResult>;
  close(): Promise<void>;
}

const ADMISSION_WINDOW_MS = 5 * 60_000;

const errorGuardedClients = new WeakSet<PoolClient>();

function guardClientErrors(client: PoolClient): void {
  if (errorGuardedClients.has(client)) return;
  errorGuardedClients.add(client);
  client.on("error", () => {});
}


function refusal(reason: RefusalReason): never {
  throw new Error(`remote admission refused: ${reason}`);
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
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
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [input.coreRunId, input.threadRef, JSON.stringify({ text: input.text }), runLeaseToken, t0 + ADMISSION_WINDOW_MS, t0],
    );
    if (runInserted !== 1) {
      throw new Error(`remote run row already exists for ${input.coreRunId}`);
    }

    let refusalReason: RefusalReason | null = null;
    let admitted = false;
    try {
      admitted = await withPgTransaction(await pool.pool(), async (client) => {
        guardClientErrors(client);
        const { rows: bindingRows } = await client.query<Record<string, unknown>>(
          `SELECT id, version, enabled, allowed_scope_id, max_input_bytes, max_history_messages, budget_ceiling_usd
           FROM remote_runtime_binding WHERE id=$1 FOR UPDATE`,
          [input.bindingId],
        );
        const binding = bindingRows[0];
        if (!binding || !binding.enabled) refusal("runtime_not_enabled");
        if (binding!.allowed_scope_id !== input.scopeId) refusal("runtime_not_enabled");

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
          input.scopeId as never,
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
            input_digest, envelope_digest, history_digest, status, version,
            pre_admission_expires_at, correlation_id, created_at, updated_at
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,1,$16,$17,$18,$18)`,
          [
            remoteTurnId, input.coreRunId, admissionKey, input.conversationKey, input.scopeId, input.actorId,
            session.id, input.g0.governanceAuthorizationDigest, input.g0.governanceDecisionId,
            input.bindingId, bindingVersion, inputDigest, envelopeDigest, historyDigest,
            "created", t0 + ADMISSION_WINDOW_MS, input.g0.traceId, createdAt,
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

  return {
    admit,
    async close(): Promise<void> {
      await pool.close();
      await ledger.touch();
    },
  };
}
