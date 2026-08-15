import { test, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRemoteTurnStore, type AdmitInput, type G0Context } from "../src/remote-turn/store.ts";
import { createRemoteBindingStore, type CreateBindingInput } from "../src/remote-turn/binding-store.ts";
import { computeEnvelopeDigest, computeHistoryDigest, computeInputDigest } from "../src/remote-turn/envelope.ts";
import { deriveWindowAnchorMs } from "../src/remote-turn/budget-ledger.ts";

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "set DATABASE_URL (a Postgres) to run the Remote Turn admission tests";

before(async () => {
  if (!URL) return;
  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: URL });
  await p.query(
    "DROP TABLE IF EXISTS remote_turn_events, remote_turn, remote_runtime_binding, budget_reservations, budget_balances, session_leases, sessions, runs CASCADE",
  );
  await p.end();
});

const bindingInput: CreateBindingInput = {
  bindingId: "binding-admit",
  configuredOrgId: "org-acme",
  allowedScopeId: "scope-acme",
  protocolVersion: 1,
  runtimeAudience: "urn:qm:v1:runtime:org-acme:test",
  transportServiceId: "svc-test",
  transportCertificatePin: "pin-test",
  releaseDigest: "a".repeat(64),
  releaseAttestationKeyId: "attestor-1",
  receiptKeySetVersion: 1,
  meteringKeySetVersion: 1,
  maxInputBytes: 1024,
  maxHistoryMessages: 8,
  maxOutputBytes: 2048,
  maxRuntimeMs: 60_000,
  tokenTtlMs: 90_000,
  budgetCeilingUsd: 1.0,
  policySnapshotHash: "policy-1",
  createdBy: "deploy-ctl",
  coreVerificationKeys: [],
  attestorKeys: [],
  receiptKeys: [],
  meteringKeys: [],
};

function g0(scopeId: string, conversationKey: string, overrides: Partial<G0Context> = {}): G0Context {
  return {
    actorId: "actor-1",
    scopeId,
    conversationKey,
    governanceDecisionId: "dec-1",
    governanceAuthorizationDigest: "authz-1",
    traceId: "trace-1",
    ...overrides,
  };
}

function admitInput(overrides: Partial<AdmitInput> = {}): AdmitInput {
  const scopeId = overrides.scopeId ?? `scope-${randomUUID()}`;
  const conversationKey = overrides.conversationKey ?? `conv-${randomUUID()}`;
  return {
    bindingId: "binding-admit",
    g0: g0(scopeId, conversationKey),
    coreRunId: randomUUID(),
    conversationKey,
    scopeId,
    actorId: "actor-1",
    text: "hello remote",
    history: [],
    threadRef: `web:actor-1:thread-${randomUUID()}`,
    ...overrides,
  };
}

async function freshBinding(bindingId = `binding-${randomUUID()}`, scopeId = `scope-${randomUUID()}`): Promise<{ bindingId: string; scopeId: string }> {
  const bindings = createRemoteBindingStore(URL!);
  await bindings.createBinding({ ...bindingInput, bindingId, allowedScopeId: scopeId });
  return { bindingId, scopeId };
}

test("admission commits run, session, remote_turn, events, reservation, and lease atomically", { skip }, async () => {
  const { bindingId, scopeId } = await freshBinding();
  const store = createRemoteTurnStore(URL!);
  const input = admitInput({ bindingId, scopeId });
  const result = await store.admit(input);
  assert.equal(result.status, "admitted");
  assert.ok(result.status === "admitted" && result.runLeaseToken);

  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: URL! });
  try {
    const run = await p.query("SELECT * FROM runs WHERE id=$1", [input.coreRunId]);
    assert.equal(run.rows.length, 1);
    assert.equal(run.rows[0].delivery_mode, "remote_once");
    assert.equal(run.rows[0].status, "pending");
    assert.equal(run.rows[0].lease_token, result.status === "admitted" ? result.runLeaseToken : null);

    const session = await p.query("SELECT * FROM sessions WHERE thread_ref=$1", [input.threadRef]);
    assert.equal(session.rows.length, 1);
    const sessionId = session.rows[0].id as string;

    const turn = await p.query("SELECT * FROM remote_turn WHERE id=$1", [
      result.status === "admitted" ? result.remoteTurnId : "",
    ]);
    assert.equal(turn.rows.length, 1);
    assert.equal(turn.rows[0].status, "admitted");
    assert.equal(turn.rows[0].version, 3);
    assert.equal(turn.rows[0].qm_session_id, sessionId);
    assert.equal(turn.rows[0].input_digest, computeInputDigest(input.text));
    assert.equal(turn.rows[0].history_digest, computeHistoryDigest(input.history));
    assert.equal(
      turn.rows[0].envelope_digest,
      computeEnvelopeDigest({
        remoteTurnId: result.status === "admitted" ? result.remoteTurnId : "",
        bindingVersion: 1,
        conversationKey: input.conversationKey,
        scopeId: input.scopeId,
        qmSessionId: sessionId,
        coreRunId: input.coreRunId,
        inputDigest: computeInputDigest(input.text),
        historyDigest: computeHistoryDigest(input.history),
      }),
    );

    const events = await p.query("SELECT event_type FROM remote_turn_events WHERE remote_turn_id=$1 ORDER BY seq", [
      result.status === "admitted" ? result.remoteTurnId : "",
    ]);
    assert.deepEqual(
      events.rows.map((r) => r.event_type),
      ["session_bind", "admit"],
    );

    const reservation = await p.query("SELECT * FROM budget_reservations WHERE remote_turn_id=$1", [
      result.status === "admitted" ? result.remoteTurnId : "",
    ]);
    assert.equal(reservation.rows.length, 1);
    assert.equal(reservation.rows[0].status, "reserved");

    const lease = await p.query("SELECT holder FROM session_leases WHERE session_id=$1", [sessionId]);
    assert.equal(lease.rows.length, 1);
    assert.ok(
      (lease.rows[0].holder as string).startsWith("remote_turn:"),
      `expected remote_turn: holder, got ${lease.rows[0].holder}`,
    );
  } finally {
    await p.end();
  }
});

test("governance mismatch refuses admission with a durable denial and no artifacts", { skip }, async () => {
  const { bindingId, scopeId } = await freshBinding();
  const store = createRemoteTurnStore(URL!);
  const input = admitInput({ bindingId, scopeId, g0: g0(scopeId, "conv-1", { actorId: "actor-other" }) });
  const result = await store.admit(input);
  assert.deepEqual(result, { status: "refused", reason: "governance_authorization_required" });

  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: URL! });
  try {
    const run = await p.query("SELECT status FROM runs WHERE id=$1", [input.coreRunId]);
    assert.equal(run.rows[0].status, "failed");
    assert.equal((await p.query("SELECT * FROM sessions WHERE thread_ref=$1", [input.threadRef])).rows.length, 0);
    assert.equal((await p.query("SELECT * FROM remote_turn WHERE core_run_id=$1", [input.coreRunId])).rows.length, 0);
    assert.equal(
      (await p.query("SELECT * FROM budget_reservations WHERE binding_id=$1", [bindingId])).rows.length,
      0,
    );
    const lease = await p.query(
      "SELECT * FROM session_leases WHERE session_id IN (SELECT id FROM sessions WHERE thread_ref=$1)",
      [input.threadRef],
    );
    assert.equal(lease.rows.length, 0);
    const denial = await p.query("SELECT * FROM remote_turn_events WHERE remote_turn_id=$1 AND event_type='refused'", [
      input.coreRunId,
    ]);
    assert.equal(denial.rows.length, 1);
  } finally {
    await p.end();
  }
});

test("insufficient budget refuses admission without a reservation row", { skip }, async () => {
  const { bindingId, scopeId } = await freshBinding();
  const store = createRemoteTurnStore(URL!);
  const pg = (await import("pg")).default;
  const seed = new pg.Pool({ connectionString: URL! });
  const anchor = deriveWindowAnchorMs(Date.now(), 60 * 60_000);
  await seed.query(
    "INSERT INTO budget_balances(scope_id, window_anchor_ms, available_usd) VALUES($1, $2, 0) ON CONFLICT (scope_id, window_anchor_ms) DO NOTHING",
    [scopeId, anchor],
  );
  await seed.end();
  const input = admitInput({ bindingId, scopeId });
  const result = await store.admit(input);
  assert.deepEqual(result, { status: "refused", reason: "budget_insufficient" });
  const p = new pg.Pool({ connectionString: URL! });
  try {
    assert.equal((await p.query("SELECT status FROM runs WHERE id=$1", [input.coreRunId])).rows[0].status, "failed");
    assert.equal((await p.query("SELECT * FROM remote_turn WHERE core_run_id=$1", [input.coreRunId])).rows.length, 0);
    assert.equal(
      (await p.query("SELECT * FROM budget_reservations WHERE remote_turn_id=$1", [input.coreRunId])).rows.length,
      0,
    );
  } finally {
    await p.end();
  }
});

test("concurrent admission on the same thread serializes: one admitted, one remote_turn_active", { skip }, async () => {
  const { bindingId, scopeId } = await freshBinding();
  const store = createRemoteTurnStore(URL!);
  const sharedThread = `web:actor-1:thread-${randomUUID()}`;
  const first = admitInput({ bindingId, scopeId, threadRef: sharedThread });
  const second = admitInput({ bindingId, scopeId, threadRef: sharedThread });
  const [a, b] = await Promise.allSettled([store.admit(first), store.admit(second)]);
  const results = [a, b].map((r) => (r.status === "fulfilled" ? r.value : { status: "rejected", reason: String(r.reason) }));
  const admitted = results.filter((r) => r.status === "admitted");
  const refused = results.find((r) => r.status === "refused") as { status: "refused"; reason: string } | undefined;
  assert.equal(admitted.length, 1, JSON.stringify(results));
  assert.ok(refused && refused.reason === "remote_turn_active", JSON.stringify(results));
});

for (const label of ["session-bound", "remote-turn-insert", "reservation+audit", "pre-commit"] as const) {
  test(`crash at onStep '${label}' leaves no in-transaction artifacts`, { skip }, async () => {
    const { bindingId, scopeId } = await freshBinding();
    const pg = (await import("pg")).default;
    const store = createRemoteTurnStore(URL!, {
      onStep: async (_lbl, tx) => {
        if (_lbl !== label) return;
        await tx.query("SELECT pg_terminate_backend(pg_backend_pid())").catch(() => {});
      },
    });
    const input = admitInput({ bindingId, scopeId, coreRunId: randomUUID() });
    await assert.rejects(() => store.admit(input));
    const p = new pg.Pool({ connectionString: URL! });
    try {
      assert.equal((await p.query("SELECT * FROM sessions WHERE thread_ref=$1", [input.threadRef])).rows.length, 0);
      assert.equal((await p.query("SELECT * FROM remote_turn WHERE core_run_id=$1", [input.coreRunId])).rows.length, 0);
      assert.equal(
        (await p.query("SELECT * FROM remote_turn_events WHERE remote_turn_id=$1", [input.coreRunId])).rows.length,
        0,
      );
      assert.equal(
        (await p.query("SELECT * FROM budget_reservations WHERE binding_id=$1", [bindingId])).rows.length,
        0,
      );
      assert.equal(
        (await p.query(
          "SELECT * FROM session_leases WHERE session_id IN (SELECT id FROM sessions WHERE thread_ref=$1)",
          [input.threadRef],
        )).rows.length,
        0,
      );
      const run = await p.query("SELECT delivery_mode, status FROM runs WHERE id=$1", [input.coreRunId]);
      assert.equal(run.rows.length, 1);
      assert.equal(run.rows[0].delivery_mode, "remote_once");
    } finally {
      await p.end();
    }
  });
}
