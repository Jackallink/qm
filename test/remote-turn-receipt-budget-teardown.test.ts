import { test, before } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, createHash } from "node:crypto";
import { CompactSign, exportSPKI } from "jose";
import { createPgPool } from "../src/persistence/pg-pool.ts";
import { REMOTE_TURN_DDL_ALL, REMOTE_TURN_RUN_DDL, REMOTE_TURN_SESSION_DDL } from "../src/remote-turn/schema.ts";
import { REMOTE_BUDGET_DDL } from "../src/remote-turn/budget-ledger.ts";
import {
  createRemoteTurnStore,
  type AdmitInput,
  type G0Context,
  type DispatchEnvelope,
} from "../src/remote-turn/store.ts";
import { verifyReceipt, type CoreTokenKeySet } from "../src/remote-turn/tokens.ts";
import { computeInputDigest } from "../src/remote-turn/envelope.ts";
import { createRemoteBindingStore, type CreateBindingInput, type KeySetEntry } from "../src/remote-turn/binding-store.ts";
import { createPostgresRunStore } from "../src/runs/postgres-run-store.ts";
import type { TurnResult } from "../src/types.ts";

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "set DATABASE_URL (a Postgres) to run the receipt/teardown tests";

before(async () => {
  if (!URL) return;
  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: URL });
  await p.query(
    "DROP TABLE IF EXISTS remote_turn_events, remote_turn, remote_runtime_binding, budget_reservations, budget_balances, session_leases, sessions, runs CASCADE",
  );
  await p.end();
});

const encoder = new TextEncoder();

interface EdKeyFixture {
  kid: string;
  privateKey: import("node:crypto").KeyObject;
  publicKeyPem: string;
  keySet: KeySetEntry[];
  sign: (payload: Record<string, unknown>, kid?: string) => Promise<string>;
}

async function makeEdKeys(
  kid: string,
  opts: { state?: "current" | "overlap"; activatedAt?: number; retiresAt?: number } = {},
): Promise<EdKeyFixture> {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = await exportSPKI(publicKey);
  const entry: KeySetEntry = {
    kid,
    publicKeyPem,
    state: opts.state ?? "current",
    activatedAt: opts.activatedAt ?? Date.now() - 1000,
    retiresAt: opts.retiresAt ?? Date.now() + 100_000,
  };
  const sign = async (payload: Record<string, unknown>, useKid = kid): Promise<string> =>
    new CompactSign(encoder.encode(JSON.stringify(payload)))
      .setProtectedHeader({ alg: "EdDSA", kid: useKid })
      .sign(privateKey);
  return { kid, privateKey, publicKeyPem, keySet: [entry], sign };
}

const bindingBase: CreateBindingInput = {
  bindingId: "binding-receipt",
  configuredOrgId: "org-acme",
  allowedScopeId: "scope-acme",
  protocolVersion: 1,
  runtimeAudience: "urn:qm:v1:runtime:org-acme:rt",
  transportServiceId: "svc-test",
  transportCertificatePin: "pin-test",
  releaseDigest: "a".repeat(64),
  releaseAttestationKeyId: "attestor-1",
  receiptKeySetVersion: 1,
  meteringKeySetVersion: 1,
  maxInputBytes: 4096,
  maxHistoryMessages: 8,
  maxOutputBytes: 16384,
  maxRuntimeMs: 60_000,
  tokenTtlMs: 90_000,
  budgetCeilingUsd: 2.0,
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

function envelope(): DispatchEnvelope {
  return { turnJti: randomUUID(), attestationNonce: randomUUID() };
}

function validPreClaim(remoteTurnId: string, turnJtiHash: string, nonceHash: string): import("../src/remote-turn/attestation.ts").PreClaimClaims {
  return {
    artifact: "pre_claim_attestation",
    schemaVersion: 1,
    remoteTurnId,
    bindingVersion: 1,
    turnJtiHash,
    attestationNonceHash: nonceHash,
    intendedWorkloadIdentity: "wl-1",
    plannedSandboxId: "sbx-1",
    releaseDigest: "a".repeat(64),
    isolationMode: "isolated",
    policyDigest: "b".repeat(64),
    networkPolicyId: "np-1",
    endpointAllowlist: ["https://api.deepseek.com/v1"],
    egressAudience: "urn:qm:v1:egress:gateway",
    expiry: Math.floor(Date.now() / 1000) + 60,
    singleUse: true,
  };
}

interface Prepared {
  store: ReturnType<typeof createRemoteTurnStore>;
  remoteTurnId: string;
  coreRunId: string;
  runLeaseToken: string;
  bindingId: string;
  scopeId: string;
  turnJtiHash: string;
  executionLeaseHash: string;
  attestor: EdKeyFixture;
  receipt: EdKeyFixture;
  runs: ReturnType<typeof createPostgresRunStore>["runs"];
  terminalEvents: TurnResult[];
}

async function prepareTurn(opts: {
  attestorKeys?: KeySetEntry[];
  receiptKeys?: KeySetEntry[];
  abortEnabled?: boolean;
} = {}): Promise<Prepared> {
  const attestor = await makeEdKeys("attestor-1");
  const receipt = await makeEdKeys("receipt-1");
  const bindingId = `binding-${randomUUID()}`;
  const scopeId = `scope-${randomUUID()}`;
  const bindings = createRemoteBindingStore(URL!);
  await bindings.createBinding({
    ...bindingBase,
    bindingId,
    allowedScopeId: scopeId,
    attestorKeys: opts.attestorKeys ?? attestor.keySet,
    receiptKeys: opts.receiptKeys ?? receipt.keySet,
  });

  const runStore = createPostgresRunStore(URL!);
  const store = createRemoteTurnStore(URL!, {
    runs: runStore.runs,
    ...(opts.abortEnabled ?? true
      ? {
          abortKey: {
            kid: "abort-1",
            privateKeyPem: attestor.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
          },
        }
      : {}),
  });

  const input = admitInput(bindingId, scopeId);
  const admitted = await store.admit(input);
  assert.equal(admitted.status, "admitted");
  assert.ok(admitted.status === "admitted");

  const enc = envelope();
  const turnJtiHash = createHash("sha256").update(enc.turnJti).digest("hex");
  const nonceHash = createHash("sha256").update(enc.attestationNonce).digest("hex");
  const dispatched = await store.prepareDispatch({
    remoteTurnId: admitted.remoteTurnId,
    leaseToken: admitted.runLeaseToken,
    envelope: enc,
  });
  assert.equal(dispatched.ok, true);

  const versionRow = await (async () => {
    const pg = (await import("pg")).default;
    const p = new pg.Pool({ connectionString: URL! });
    try {
      const { rows } = await p.query("SELECT version FROM remote_turn WHERE id=$1", [admitted.remoteTurnId]);
      return Number(rows[0].version);
    } finally {
      await p.end();
    }
  })();

  const claimed = await store.claim({
    remoteTurnId: admitted.remoteTurnId,
    turnJtiHash,
    attestationNonceHash: nonceHash,
    verifiedPreClaim: validPreClaim(admitted.remoteTurnId, turnJtiHash, nonceHash),
    runtimeAudience: "urn:qm:v1:runtime:org-acme:rt",
    version: versionRow,
  });
  assert.equal(claimed.ok, true);
  assert.ok(claimed.ok);
  const { runs } = runStore;
  const run = await runs.claimRemoteOnce(admitted.coreRunId, admitted.runLeaseToken, "dispatch-worker", 60_000);
  assert.ok(run, "the remote run must be claimable");
  assert.equal(run!.deliveryMode, "remote_once");

  const terminalEvents: TurnResult[] = [];
  runs.onTerminal((terminal) => {
    terminalEvents.push(terminal.result ?? { status: "failed", reply: undefined });
  });

  return {
    store,
    remoteTurnId: admitted.remoteTurnId,
    coreRunId: admitted.coreRunId,
    runLeaseToken: admitted.runLeaseToken,
    bindingId,
    scopeId,
    turnJtiHash,
    executionLeaseHash: claimed.ok ? claimed.executionLeaseHash : "e".repeat(64),
    attestor,
    receipt,
    runs,
    terminalEvents,
  };
}

async function startTurn(prepared: Prepared): Promise<void> {
  const startProof = await prepared.attestor.sign({
    artifact: "start_proof",
    schemaVersion: 1,
    remoteTurnId: prepared.remoteTurnId,
    bindingVersion: 1,
    turnJtiHash: prepared.turnJtiHash,
    executionLeaseHash: prepared.executionLeaseHash,
    sandboxId: "sbx-1",
    workloadIdentity: "wl-1",
    releaseDigest: "a".repeat(64),
    networkPolicyId: "np-1",
    egressTokenId: "eg-1",
    startTime: Math.floor(Date.now() / 1000),
    attestorKid: "attestor-1",
  });
  const started = await prepared.store.startExecution({ remoteTurnId: prepared.remoteTurnId, startProofJws: startProof });
  assert.equal(started.ok, true, "startTurn must advance the turn to executing");
}

function receiptPayload(overrides: Record<string, unknown> = {}, inputDigest = "a".repeat(64)): Record<string, unknown> {
  return {
    artifact: "receipt",
    schemaVersion: 1,
    remoteTurnId: "00000000-0000-0000-0000-000000000000",
    bindingVersion: 1,
    executionLeaseHash: "e".repeat(64),
    inputDigest,
    releaseDigest: "a".repeat(64),
    status: "completed",
    reply: "ok",
    outputBytes: 2,
    runtimeMs: 12,
    receivedAt: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}


test("verifyReceipt accepts a schema-valid signed receipt and rejects schema/signature violations", { skip }, async () => {
  const receipt = await makeEdKeys("receipt-1");
  const good = await receipt.sign(receiptPayload());
  const now = Date.now();
  const keys: CoreTokenKeySet = receipt.keySet;
  const expected = {
    remoteTurnId: "00000000-0000-0000-0000-000000000000",
    bindingVersion: 1,
    executionLeaseHash: "e".repeat(64),
    inputDigest: "a".repeat(64),
    releaseDigest: "a".repeat(64),
    now,
  };
  const verified = await verifyReceipt(good, keys, expected);
  assert.ok(verified, "valid receipt must verify");
  assert.equal(verified!.reply, "ok");

  const unknownField = await receipt.sign(receiptPayload({ smuggled: true }));
  assert.equal(await verifyReceipt(unknownField, keys, expected), null, "unknown field must be rejected");

  const oversized = await receipt.sign(receiptPayload({ reply: "x".repeat(17_000) }));
  assert.equal(await verifyReceipt(oversized, keys, expected), null, ">16 KiB reply must be rejected");

  const wrongStatus = await receipt.sign(receiptPayload({ status: "failed" }));
  assert.equal(await verifyReceipt(wrongStatus, keys, expected), null, "non-completed status must be rejected");

  const wrongLease = await receipt.sign(receiptPayload({ executionLeaseHash: "c".repeat(64) }));
  assert.equal(await verifyReceipt(wrongLease, keys, expected), null, "wrong lease hash must be rejected");

  const tampered = await receipt.sign(receiptPayload());
  const dot = tampered.lastIndexOf(".");
  const forged = `${tampered.slice(0, dot)}.${"0".repeat(tampered.length - dot - 1)}`;
  assert.equal(await verifyReceipt(forged, keys, expected), null, "bad signature must be rejected");

  const retired = await receipt.sign(receiptPayload());
  const expiredKeys: CoreTokenKeySet = [
    { ...receipt.keySet[0]!, activatedAt: 0, retiresAt: now - 10 },
  ];
  assert.equal(await verifyReceipt(retired, expiredKeys, expected), null, "retired key must be rejected");
});

test("startExecution consumes start proof and moves claimed to executing; mismatch parks", { skip }, async () => {
  const prepared = await prepareTurn();
  const { store, remoteTurnId, coreRunId, turnJtiHash } = prepared;
  void coreRunId;

  const proof = await prepared.attestor.sign(
    {
      artifact: "start_proof",
      schemaVersion: 1,
      remoteTurnId,
      bindingVersion: 1,
      turnJtiHash,
      executionLeaseHash: prepared.executionLeaseHash,
      sandboxId: "sbx-1",
      workloadIdentity: "wl-1",
      releaseDigest: "a".repeat(64),
      networkPolicyId: "np-1",
      egressTokenId: "eg-1",
      startTime: Math.floor(Date.now() / 1000),
      attestorKid: "attestor-1",
    },
  );
  const started = await store.startExecution({ remoteTurnId, startProofJws: proof });
  assert.equal(started.ok, true);

  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: URL! });
  try {
    const { rows } = await p.query("SELECT status FROM remote_turn WHERE id=$1", [remoteTurnId]);
    assert.equal(rows[0].status, "executing");
  } finally {
    await p.end();
  }

  const mismatch = await prepared.attestor.sign(
    {
      artifact: "start_proof",
      schemaVersion: 1,
      remoteTurnId,
      bindingVersion: 1,
      turnJtiHash,
      executionLeaseHash: "e".repeat(64),
      sandboxId: "sbx-OTHER",
      workloadIdentity: "wl-1",
      releaseDigest: "a".repeat(64),
      networkPolicyId: "np-1",
      egressTokenId: "eg-1",
      startTime: Math.floor(Date.now() / 1000),
      attestorKid: "attestor-1",
    },
  );
  const other = await prepareTurn();
  const startedOther = await other.store.startExecution({ remoteTurnId: other.remoteTurnId, startProofJws: mismatch });
  assert.equal(startedOther.ok, false);
  if (!startedOther.ok) assert.equal(startedOther.reason, "attestation_invalid");
  const p2 = new pg.Pool({ connectionString: URL! });
  try {
    const { rows } = await p2.query("SELECT status FROM remote_turn WHERE id=$1", [other.remoteTurnId]);
    assert.equal(rows[0].status, "parked", "planned-vs-actual mismatch must park");
  } finally {
    await p2.end();
  }
});

test("receiveReceipt moves executing to reply_received; duplicate is ignored; invalid receipt parks", { skip }, async () => {
  const prepared = await prepareTurn();
  const { store, remoteTurnId } = prepared;
  await startTurn(prepared);
  const valid = await prepared.receipt.sign({
    ...receiptPayload({}, computeInputDigest("hello remote")),
    remoteTurnId,
    executionLeaseHash: prepared.executionLeaseHash,
  });
  const received = await store.receiveReceipt({ remoteTurnId, receiptToken: valid });
  assert.equal(received.ok, true);

  const duplicate = await store.receiveReceipt({ remoteTurnId, receiptToken: valid });
  assert.equal(duplicate.ok, false);
  if (!duplicate.ok) assert.equal(duplicate.reason, "not_receivable");

  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: URL! });
  try {
    const { rows } = await p.query("SELECT status FROM remote_turn WHERE id=$1", [remoteTurnId]);
    assert.equal(rows[0].status, "reply_received");
    const events = await p.query("SELECT event_type FROM remote_turn_events WHERE remote_turn_id=$1", [remoteTurnId]);
    const types = events.rows.map((r) => r.event_type);
    assert.ok(types.includes("receipt"));
  } finally {
    await p.end();
  }

  const other = await prepareTurn();
  await startTurn(other);
  const bad = await other.receipt.sign({
    ...receiptPayload({ reply: "x".repeat(17_000) }, computeInputDigest("hello remote")),
    remoteTurnId: other.remoteTurnId,
    executionLeaseHash: other.executionLeaseHash,
  });
  const rejected = await other.store.receiveReceipt({ remoteTurnId: other.remoteTurnId, receiptToken: bad });
  assert.equal(rejected.ok, false);
  const p2 = new pg.Pool({ connectionString: URL! });
  try {
    const { rows } = await p2.query("SELECT status FROM remote_turn WHERE id=$1", [other.remoteTurnId]);
    assert.equal(rows[0].status, "parked", "invalid receipt must park");
  } finally {
    await p2.end();
  }
});

test("beginTeardown with trusted usage moves to teardown_pending and settles the reservation", { skip }, async () => {
  const prepared = await prepareTurn();
  const { store, remoteTurnId } = prepared;
  await startTurn(prepared);
  const receiptToken = await prepared.receipt.sign({
    ...receiptPayload({}, computeInputDigest("hello remote")),
    remoteTurnId,
    executionLeaseHash: prepared.executionLeaseHash,
  });
  await store.receiveReceipt({ remoteTurnId, receiptToken });
  const teardown = await store.beginTeardown({ remoteTurnId, trustedUsageUsd: 0.1, invalidMetering: false });
  assert.equal(teardown, "teardown_pending");

  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: URL! });
  try {
    const { rows } = await p.query("SELECT status FROM remote_turn WHERE id=$1", [remoteTurnId]);
    assert.equal(rows[0].status, "teardown_pending");
    const res = await p.query("SELECT status FROM budget_reservations WHERE remote_turn_id=$1", [remoteTurnId]);
    assert.equal(res.rows[0].status, "released", "trusted usage must release the reservation");
  } finally {
    await p.end();
  }
});

test("beginTeardown with missing trusted usage charges the full reservation", { skip }, async () => {
  const prepared = await prepareTurn();
  const { store, remoteTurnId } = prepared;
  await startTurn(prepared);
  const receiptToken = await prepared.receipt.sign({
    ...receiptPayload({}, computeInputDigest("hello remote")),
    remoteTurnId,
    executionLeaseHash: prepared.executionLeaseHash,
  });
  await store.receiveReceipt({ remoteTurnId, receiptToken });
  const teardown = await store.beginTeardown({ remoteTurnId, trustedUsageUsd: null, invalidMetering: false });
  assert.equal(teardown, "teardown_pending");

  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: URL! });
  try {
    const res = await p.query("SELECT status FROM budget_reservations WHERE remote_turn_id=$1", [remoteTurnId]);
    assert.equal(res.rows[0].status, "charged", "missing trusted usage must charge the full reservation");
  } finally {
    await p.end();
  }
});

test("beginTeardown with invalid metering parks the turn", { skip }, async () => {
  const prepared = await prepareTurn();
  const { store, remoteTurnId } = prepared;
  await startTurn(prepared);
  const receiptToken = await prepared.receipt.sign({
    ...receiptPayload({}, computeInputDigest("hello remote")),
    remoteTurnId,
    executionLeaseHash: prepared.executionLeaseHash,
  });
  await store.receiveReceipt({ remoteTurnId, receiptToken });
  const teardown = await store.beginTeardown({ remoteTurnId, trustedUsageUsd: null, invalidMetering: true });
  assert.equal(teardown, "parked");

  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: URL! });
  try {
    const { rows } = await p.query("SELECT status FROM remote_turn WHERE id=$1", [remoteTurnId]);
    assert.equal(rows[0].status, "parked");
  } finally {
    await p.end();
  }
});

test("completeTeardown with valid evidence completes, flips the run to done, and fires onTerminal", { skip }, async () => {
  const prepared = await prepareTurn();
  const { store, remoteTurnId, coreRunId, runs, terminalEvents } = prepared;
  await startTurn(prepared);
  const receiptToken = await prepared.receipt.sign({
    ...receiptPayload({}, computeInputDigest("hello remote")),
    remoteTurnId,
    executionLeaseHash: prepared.executionLeaseHash,
  });
  await store.receiveReceipt({ remoteTurnId, receiptToken });
  await store.beginTeardown({ remoteTurnId, trustedUsageUsd: 0.1, invalidMetering: false });

  const completed = await store.completeTeardown({
    remoteTurnId,
    evidence: {
      sandboxDeleted: true,
      egressRevoked: true,
      proofDigest: "d".repeat(64),
    },
  });
  assert.equal(completed, "completed");

  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: URL! });
  try {
    const { rows } = await p.query("SELECT status, result FROM runs WHERE id=$1", [coreRunId]);
    assert.equal(rows[0].status, "done", "the run row must be done");
    const result = JSON.parse(rows[0].result) as TurnResult;
    assert.equal(result.reply, "ok");
  } finally {
    await p.end();
  }
  assert.equal(terminalEvents.length, 1, "onTerminal must fire exactly once");
  void runs;
});

test("completeTeardown without valid evidence parks the turn", { skip }, async () => {
  const prepared = await prepareTurn();
  const { store, remoteTurnId, coreRunId } = prepared;
  await startTurn(prepared);
  const receiptToken = await prepared.receipt.sign({
    ...receiptPayload({}, computeInputDigest("hello remote")),
    remoteTurnId,
    executionLeaseHash: prepared.executionLeaseHash,
  });
  await store.receiveReceipt({ remoteTurnId, receiptToken });
  await store.beginTeardown({ remoteTurnId, trustedUsageUsd: 0.1, invalidMetering: false });

  const parked = await store.completeTeardown({
    remoteTurnId,
    evidence: { sandboxDeleted: false, egressRevoked: true, proofDigest: "d".repeat(64) },
  });
  assert.equal(parked, "parked");

  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: URL! });
  try {
    const { rows } = await p.query("SELECT status FROM remote_turn WHERE id=$1", [remoteTurnId]);
    assert.equal(rows[0].status, "parked");
    const run = await p.query("SELECT status FROM runs WHERE id=$1", [coreRunId]);
    assert.equal(run.rows[0].status, "running", "a parked turn must not flip the run terminal");
  } finally {
    await p.end();
  }
});

test("start proof claiming an unissued or wrong lease is denied", { skip }, async () => {
  const prepared = await prepareTurn();
  const wrongLease = await prepared.attestor.sign({
    artifact: "start_proof",
    schemaVersion: 1,
    remoteTurnId: prepared.remoteTurnId,
    bindingVersion: 1,
    turnJtiHash: prepared.turnJtiHash,
    executionLeaseHash: "c".repeat(64),
    sandboxId: "sbx-1",
    workloadIdentity: "wl-1",
    releaseDigest: "a".repeat(64),
    networkPolicyId: "np-1",
    egressTokenId: "eg-1",
    startTime: Math.floor(Date.now() / 1000),
    attestorKid: "attestor-1",
  });
  const result = await prepared.store.startExecution({ remoteTurnId: prepared.remoteTurnId, startProofJws: wrongLease });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "attestation_invalid");
});

test("cross-instance: two pools share the receipt and teardown chain", { skip }, async () => {
  const { bindingId, scopeId } = (() => {
    const b = `binding-x-${randomUUID()}`;
    const s = `scope-x-${randomUUID()}`;
    return { bindingId: b, scopeId: s };
  })();
  const attestor = await makeEdKeys("attestor-1");
  const receipt = await makeEdKeys("receipt-1");
  const bindings = createRemoteBindingStore(URL!);
  await bindings.createBinding({
    ...bindingBase,
    bindingId,
    allowedScopeId: scopeId,
    attestorKeys: attestor.keySet,
    receiptKeys: receipt.keySet,
  });

  const DDL = [...REMOTE_TURN_RUN_DDL, ...REMOTE_TURN_SESSION_DDL, ...REMOTE_TURN_DDL_ALL, ...REMOTE_BUDGET_DDL];
  const poolA = createPgPool(URL!, DDL);
  const poolB = createPgPool(URL!, DDL);
  const storeA = createRemoteTurnStore(URL!, {
    pool: poolA,
    abortKey: { kid: "abort-1", privateKeyPem: attestor.privateKey.export({ type: "pkcs8", format: "pem" }).toString() },
  });
  const storeB = createRemoteTurnStore(URL!, { pool: poolB });

  const input = admitInput(bindingId, scopeId);
  const admitted = await storeA.admit(input);
  assert.equal(admitted.status, "admitted");
  assert.ok(admitted.status === "admitted");
  const enc = envelope();
  const turnJtiHash = createHash("sha256").update(enc.turnJti).digest("hex");
  const nonceHash = createHash("sha256").update(enc.attestationNonce).digest("hex");
  await storeA.prepareDispatch({ remoteTurnId: admitted.remoteTurnId, leaseToken: admitted.runLeaseToken, envelope: enc });
  const versionRow = await (async () => {
    const pg = (await import("pg")).default;
    const p = new pg.Pool({ connectionString: URL! });
    try {
      const { rows } = await p.query("SELECT version FROM remote_turn WHERE id=$1", [admitted.remoteTurnId]);
      return Number(rows[0].version);
    } finally {
      await p.end();
    }
  })();
  const claimed = await storeA.claim({
    remoteTurnId: admitted.remoteTurnId,
    turnJtiHash,
    attestationNonceHash: nonceHash,
    verifiedPreClaim: validPreClaim(admitted.remoteTurnId, turnJtiHash, nonceHash),
    runtimeAudience: "urn:qm:v1:runtime:org-acme:rt",
    version: versionRow,
  });
  assert.equal(claimed.ok, true);

  const proof = await attestor.sign({
    artifact: "start_proof",
    schemaVersion: 1,
    remoteTurnId: admitted.remoteTurnId,
    bindingVersion: 1,
    turnJtiHash,
    executionLeaseHash: claimed.ok ? claimed.executionLeaseHash : "e".repeat(64),
    sandboxId: "sbx-1",
    workloadIdentity: "wl-1",
    releaseDigest: "a".repeat(64),
    networkPolicyId: "np-1",
    egressTokenId: "eg-1",
    startTime: Math.floor(Date.now() / 1000),
    attestorKid: "attestor-1",
  });
  const started = await storeB.startExecution({ remoteTurnId: admitted.remoteTurnId, startProofJws: proof });
  assert.equal(started.ok, true, "a second instance must see and advance the shared chain");

  const receiptToken = await receipt.sign({
    ...receiptPayload({}, computeInputDigest("hello remote")),
    remoteTurnId: admitted.remoteTurnId,
    executionLeaseHash: claimed.ok ? claimed.executionLeaseHash : "e".repeat(64),
  });
  const received = await storeB.receiveReceipt({ remoteTurnId: admitted.remoteTurnId, receiptToken });
  assert.equal(received.ok, true);
  await storeA.close();
  await storeB.close();
});
