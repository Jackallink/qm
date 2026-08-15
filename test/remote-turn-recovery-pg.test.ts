import { test, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createPgPool } from "../src/persistence/pg-pool.ts";
import {
  REMOTE_TURN_DDL_ALL,
  REMOTE_TURN_RUN_DDL,
  REMOTE_TURN_SESSION_DDL,
} from "../src/remote-turn/schema.ts";
import { REMOTE_BUDGET_DDL } from "../src/remote-turn/budget-ledger.ts";
import {
  createRemoteTurnStore,
  type AdmitInput,
  type G0Context,
  type DispatchEnvelope,
} from "../src/remote-turn/store.ts";
import { createRemoteBindingStore, type CreateBindingInput } from "../src/remote-turn/binding-store.ts";
import { createPostgresRunStore } from "../src/runs/postgres-run-store.ts";

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "set DATABASE_URL (a Postgres) to run the Remote Turn recovery tests";

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
  bindingId: "binding-recovery",
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

function g0(scopeId: string, conversationKey: string): G0Context {
  return {
    actorId: "actor-1",
    scopeId,
    conversationKey,
    governanceDecisionId: "dec-1",
    governanceAuthorizationDigest: "authz-1",
    traceId: "trace-1",
  };
}

function admitInput(bindingId: string, scopeId: string): AdmitInput {
  const conversationKey = `conv-${randomUUID()}`;
  return {
    bindingId,
    g0: g0(scopeId, conversationKey),
    coreRunId: randomUUID(),
    conversationKey,
    scopeId,
    actorId: "actor-1",
    text: "hello remote",
    history: [],
    threadRef: `web:actor-1:thread-${randomUUID()}`,
  };
}

async function freshBinding(bindingId = `binding-${randomUUID()}`, scopeId = `scope-${randomUUID()}`): Promise<{ bindingId: string; scopeId: string }> {
  const bindings = createRemoteBindingStore(URL!);
  await bindings.createBinding({ ...bindingInput, bindingId, allowedScopeId: scopeId });
  return { bindingId, scopeId };
}

async function admittedTurn(now = Date.now()): Promise<{ remoteTurnId: string; coreRunId: string; runLeaseToken: string; scopeId: string }> {
  const { bindingId, scopeId } = await freshBinding();
  const store = createRemoteTurnStore(URL!);
  const input = admitInput(bindingId, scopeId);
  const result = await store.admit(input);
  assert.equal(result.status, "admitted");
  assert.ok(result.status === "admitted");
  return { remoteTurnId: result.remoteTurnId, coreRunId: result.coreRunId, runLeaseToken: result.runLeaseToken, scopeId };
}

function envelope(turnJti = randomUUID(), attestationNonce = randomUUID()): DispatchEnvelope {
  return { turnJti, attestationNonce };
}

test("prepareDispatch persists JTI and nonce hashes and moves admitted to dispatching", { skip }, async () => {
  const { remoteTurnId, coreRunId, runLeaseToken } = await admittedTurn();
  const store = createRemoteTurnStore(URL!);
  const enc = envelope();
  const result = await store.prepareDispatch({ remoteTurnId, leaseToken: runLeaseToken, envelope: enc });
  assert.equal(result.ok, true);
  assert.ok(result.ok && result.dispatchAttempt >= 1);
  assert.ok(result.ok && result.preClaimExpiresAt > 0);

  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: URL! });
  try {
    const turn = await p.query("SELECT status, turn_jti_hash, attestation_nonce_hash, dispatch_owner, dispatch_attempt, pre_claim_expires_at FROM remote_turn WHERE id=$1", [remoteTurnId]);
    assert.equal(turn.rows.length, 1);
    assert.equal(turn.rows[0].status, "dispatching");
    assert.ok(turn.rows[0].turn_jti_hash, "turn JTI hash must be persisted");
    assert.ok(turn.rows[0].attestation_nonce_hash, "attestation nonce hash must be persisted");
    assert.ok(turn.rows[0].turn_jti_hash !== enc.turnJti, "only the hash is stored, never the raw JTI");
    assert.ok(turn.rows[0].attestation_nonce_hash !== enc.attestationNonce);
    assert.equal(turn.rows[0].dispatch_attempt, 1);
    const run = await p.query("SELECT status FROM runs WHERE id=$1", [coreRunId]);
    assert.equal(run.rows[0].status, "pending");
  } finally {
    await p.end();
  }
});

test("restart resends the same persisted envelope without regenerating JTI or nonce", { skip }, async () => {
  const { remoteTurnId, runLeaseToken } = await admittedTurn();
  const store = createRemoteTurnStore(URL!);
  const enc = envelope();
  const first = await store.prepareDispatch({ remoteTurnId, leaseToken: runLeaseToken, envelope: enc });
  assert.equal(first.ok, true);

  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: URL! });
  let jtiHashBefore: string;
  let nonceHashBefore: string;
  try {
    const turn = await p.query("SELECT turn_jti_hash, attestation_nonce_hash FROM remote_turn WHERE id=$1", [remoteTurnId]);
    jtiHashBefore = turn.rows[0].turn_jti_hash as string;
    nonceHashBefore = turn.rows[0].attestation_nonce_hash as string;
  } finally {
    await p.end();
  }

  const resumed = await store.prepareDispatch({ remoteTurnId, leaseToken: runLeaseToken, envelope: enc });
  assert.equal(resumed.ok, true);
  assert.ok(resumed.ok && resumed.dispatchAttempt >= 2);

  const p2 = new pg.Pool({ connectionString: URL! });
  try {
    const turn = await p2.query("SELECT turn_jti_hash, attestation_nonce_hash, status FROM remote_turn WHERE id=$1", [remoteTurnId]);
    assert.equal(turn.rows[0].status, "dispatching");
    assert.equal(turn.rows[0].turn_jti_hash, jtiHashBefore, "JTI hash must not be regenerated on resume");
    assert.equal(turn.rows[0].attestation_nonce_hash, nonceHashBefore, "nonce hash must not be regenerated on resume");
  } finally {
    await p2.end();
  }
});

test("a regenerated JTI or nonce on resume is rejected with no state change", { skip }, async () => {
  const { remoteTurnId, runLeaseToken } = await admittedTurn();
  const store = createRemoteTurnStore(URL!);
  const enc = envelope();
  await store.prepareDispatch({ remoteTurnId, leaseToken: runLeaseToken, envelope: enc });

  const regenerated = envelope(randomUUID(), randomUUID());
  const result = await store.prepareDispatch({ remoteTurnId, leaseToken: runLeaseToken, envelope: regenerated });
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.reason === "envelope_mismatch");

  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: URL! });
  try {
    const turn = await p.query("SELECT status FROM remote_turn WHERE id=$1", [remoteTurnId]);
    assert.equal(turn.rows[0].status, "dispatching");
  } finally {
    await p.end();
  }
});

test("a stale lease token cannot resume or dispatch", { skip }, async () => {
  const { remoteTurnId } = await admittedTurn();
  const store = createRemoteTurnStore(URL!);
  const result = await store.prepareDispatch({ remoteTurnId, leaseToken: randomUUID(), envelope: envelope() });
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.reason === "no_lease");
});

test("claimRemoteOnce moves a remote_once run from pending to running with the same lease", { skip }, async () => {
  const { remoteTurnId, coreRunId, runLeaseToken } = await admittedTurn();
  const { runs } = createPostgresRunStore(URL!);
  const claimed = await runs.claimRemoteOnce(coreRunId, runLeaseToken, "dispatch-worker", 60_000);
  assert.ok(claimed, "claimRemoteOnce must return the claimed run");
  assert.equal(claimed!.id, coreRunId);
  assert.equal(claimed!.status, "running");
  assert.equal(claimed!.deliveryMode, "remote_once");
  assert.equal(claimed!.leaseToken, runLeaseToken, "the run lease must stay the same token");

  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: URL! });
  try {
    const run = await p.query("SELECT status, worker_id FROM runs WHERE id=$1", [coreRunId]);
    assert.equal(run.rows[0].status, "running");
    assert.equal(run.rows[0].worker_id, "dispatch-worker");
  } finally {
    await p.end();
  }
  void remoteTurnId;
});

test("claimRemoteOnce is refused for a non-remote or mismatched-lease run", { skip }, async () => {
  const { runs } = createPostgresRunStore(URL!);
  const { rows } = await (async () => {
    const pg = (await import("pg")).default;
    const p = new pg.Pool({ connectionString: URL! });
    try {
      return await p.query(
        "INSERT INTO runs(id, session_id, status, request, delivery_mode, lease_token, created_at) VALUES($1,$2,'pending',$3,'local',$4,$5) RETURNING id",
        [randomUUID(), `sess-${randomUUID()}`, JSON.stringify({ text: "x" }), null, Date.now()],
      );
    } finally {
      await p.end();
    }
  })();
  const localRunId = rows[0].id as string;
  const remoteStore = createRemoteTurnStore(URL!);
  await remoteStore.admit(
    admitInput((await freshBinding()).bindingId, (await freshBinding()).scopeId),
  );
  const result = await runs.claimRemoteOnce(localRunId, randomUUID(), "worker", 60_000);
  assert.equal(result, null, "local runs and wrong lease must be refused");
});

test("expirePreClaim releases reservation and session lease and writes failed_pre_dispatch", { skip }, async () => {
  const { remoteTurnId, coreRunId, runLeaseToken, scopeId } = await admittedTurn();
  const store = createRemoteTurnStore(URL!);
  await store.prepareDispatch({ remoteTurnId, leaseToken: runLeaseToken, envelope: envelope() });

  const expiredAt = Date.now() + 100_000;
  const result = await store.expirePreClaim(remoteTurnId, expiredAt);
  assert.equal(result, "expired");

  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: URL! });
  try {
    const turn = await p.query("SELECT status FROM remote_turn WHERE id=$1", [remoteTurnId]);
    assert.equal(turn.rows[0].status, "failed_pre_dispatch");
    const reservation = await p.query("SELECT status FROM budget_reservations WHERE remote_turn_id=$1", [remoteTurnId]);
    assert.equal(reservation.rows.length, 1);
    assert.equal(reservation.rows[0].status, "released", "reservation must be settled as released (budget returned)");
    const lease = await p.query("SELECT * FROM session_leases WHERE holder=$1", [`remote_turn:${remoteTurnId}`]);
    assert.equal(lease.rows.length, 0, "session lease must be released");
    const run = await p.query("SELECT status FROM runs WHERE id=$1", [coreRunId]);
    assert.equal(run.rows[0].status, "failed");
  } finally {
    await p.end();
  }
  void scopeId;
});

test("expirePreClaim on a non-expired or wrong-state turn is a no-op", { skip }, async () => {
  const { remoteTurnId, runLeaseToken } = await admittedTurn();
  const store = createRemoteTurnStore(URL!);
  await store.prepareDispatch({ remoteTurnId, leaseToken: runLeaseToken, envelope: envelope() });
  const result = await store.expirePreClaim(remoteTurnId, Date.now() - 1000);
  assert.equal(result, "not_expired");

  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: URL! });
  try {
    const turn = await p.query("SELECT status FROM remote_turn WHERE id=$1", [remoteTurnId]);
    assert.equal(turn.rows[0].status, "dispatching");
  } finally {
    await p.end();
  }
});

test("cross-instance: two independent pools see the persisted dispatch and cannot mint a second JTI", { skip }, async () => {
  const { bindingId, scopeId } = await freshBinding();
  const input = admitInput(bindingId, scopeId);

  const DDL = [...REMOTE_TURN_RUN_DDL, ...REMOTE_TURN_SESSION_DDL, ...REMOTE_TURN_DDL_ALL, ...REMOTE_BUDGET_DDL];
  const poolA = createPgPool(URL!, DDL);
  const poolB = createPgPool(URL!, DDL);
  const storeA = createRemoteTurnStore(URL!, { pool: poolA });
  const storeB = createRemoteTurnStore(URL!, { pool: poolB });

  const admitted = await storeA.admit(input);
  assert.equal(admitted.status, "admitted");
  assert.ok(admitted.status === "admitted");

  const enc = envelope();
  const first = await storeA.prepareDispatch({ remoteTurnId: admitted.remoteTurnId, leaseToken: admitted.runLeaseToken, envelope: enc });
  assert.equal(first.ok, true);

  const second = await storeB.prepareDispatch({ remoteTurnId: admitted.remoteTurnId, leaseToken: admitted.runLeaseToken, envelope: envelope() });
  assert.equal(second.ok, false);
  assert.ok(!second.ok && second.reason === "envelope_mismatch");

  await storeA.close();
  await storeB.close();
});
