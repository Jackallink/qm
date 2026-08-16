import { test, beforeEach } from "node:test";
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
  type PreClaimClaims,
} from "../src/remote-turn/store.ts";
import { createRemoteBindingStore, type CreateBindingInput, type KeySetEntry } from "../src/remote-turn/binding-store.ts";
import { createPostgresRunStore } from "../src/runs/postgres-run-store.ts";
import { createRemoteTurnReconciler, type AttestorGateway, type SandboxState } from "../src/remote-turn/reconciler.ts";
import { createErrorLog } from "../src/admin/error-log.ts";
import type { TurnResult } from "../src/types.ts";

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "set DATABASE_URL (a Postgres) to run the reconciler tests";

beforeEach(async () => {
  if (!URL) return;
  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: URL });
  await p.query(
    "DROP TABLE IF EXISTS remote_turn_events, remote_turn, remote_runtime_binding, budget_reservations, budget_balances, session_leases, sessions, runs CASCADE",
  );
  await p.end();
  const ddl = [...REMOTE_TURN_RUN_DDL, ...REMOTE_TURN_SESSION_DDL, ...REMOTE_TURN_DDL_ALL, ...REMOTE_BUDGET_DDL];
  const pp = createPgPool(URL, ddl);
  await pp.pool();
  await pp.close();
});

const encoder = new TextEncoder();

interface EdKeyFixture {
  kid: string;
  privateKey: import("node:crypto").KeyObject;
  keySet: KeySetEntry[];
  sign: (payload: Record<string, unknown>, kid?: string) => Promise<string>;
}

async function makeEdKeys(kid: string): Promise<EdKeyFixture> {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = await exportSPKI(publicKey);
  const sign = async (payload: Record<string, unknown>, useKid = kid): Promise<string> =>
    new CompactSign(encoder.encode(JSON.stringify(payload)))
      .setProtectedHeader({ alg: "EdDSA", kid: useKid })
      .sign(privateKey);
  return {
    kid,
    privateKey,
    keySet: [{ kid, publicKeyPem, state: "current", activatedAt: Date.now() - 1000, retiresAt: Date.now() + 100_000 }],
    sign,
  };
}

const bindingBase: CreateBindingInput = {
  bindingId: "binding-reconciler",
  configuredOrgId: "org-acme",
  allowedScopeId: "scope-acme",
  protocolVersion: 1,
  runtimeAudience: "urn:qm:v1:runtime:org-acme:rt",
  transportServiceId: "svc-test",
  transportCertificatePin: "pin-test",
  transportSourceAuthKeyId: "source-auth-key-1",
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

  networkPolicyId: "net-pol-1",

  endpointAllowlist: ["https://api.deepseek.com"],

  egressAudience: "urn:qm:egress:1",
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
    governanceDecisionId: `dec-${randomUUID()}`,
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
    surface: "web",
    deliveryTarget: "web:actor-1:thread",
  };
}

function envelope(): DispatchEnvelope {
  return { turnJti: randomUUID(), attestationNonce: randomUUID() };
}

function validPreClaim(remoteTurnId: string, turnJtiHash: string, nonceHash: string): PreClaimClaims {
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
  runs: ReturnType<typeof createPostgresRunStore>["runs"];
  terminalEvents: TurnResult[];
}

async function prepareTurn(opts: { bindingId?: string; scopeId?: string } = {}): Promise<Prepared> {
  const attestor = await makeEdKeys("attestor-1");
  const bindingId = opts.bindingId ?? `binding-${randomUUID()}`;
  const scopeId = opts.scopeId ?? `scope-${randomUUID()}`;
  const bindings = createRemoteBindingStore(URL!);
  if (!opts.bindingId) {
    await bindings.createBinding({
      ...bindingBase,
      bindingId,
      allowedScopeId: scopeId,
      attestorKeys: attestor.keySet,
    });
  }

  const runStore = createPostgresRunStore(URL!);
  const store = createRemoteTurnStore(URL!, {
    runs: runStore.runs,
    abortKey: { kid: "abort-1", privateKeyPem: attestor.privateKey.export({ type: "pkcs8", format: "pem" }).toString() },
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

  const run = await runStore.runs.claimRemoteOnce(admitted.coreRunId, admitted.runLeaseToken, "dispatch-worker", 60_000);
  assert.ok(run, "the remote run must be claimable");

  const terminalEvents: TurnResult[] = [];
  runStore.runs.onTerminal((terminal) => {
    terminalEvents.push(terminal.result ?? { status: "failed", reply: undefined });
  });

  return {
    store,
    remoteTurnId: admitted.remoteTurnId,
    coreRunId: admitted.coreRunId,
    runLeaseToken: admitted.runLeaseToken,
    bindingId,
    scopeId,
    runs: runStore.runs,
    terminalEvents,
  };
}

async function parkTurn(prepared: Prepared, attestor: EdKeyFixture): Promise<void> {
  const versionRow = await (async () => {
    const pg = (await import("pg")).default;
    const p = new pg.Pool({ connectionString: URL! });
    try {
      const { rows } = await p.query("SELECT version FROM remote_turn WHERE id=$1", [prepared.remoteTurnId]);
      return Number(rows[0].version);
    } finally {
      await p.end();
    }
  })();
  const turn = await (async () => {
    const pg = (await import("pg")).default;
    const p = new pg.Pool({ connectionString: URL! });
    try {
      const { rows } = await p.query(
        "SELECT turn_jti_hash, execution_lease_hash FROM remote_turn WHERE id=$1",
        [prepared.remoteTurnId],
      );
      return rows[0] as { turn_jti_hash: string; execution_lease_hash: string };
    } finally {
      await p.end();
    }
  })();
  const badProof = await attestor.sign({
    artifact: "start_proof",
    schemaVersion: 1,
    remoteTurnId: prepared.remoteTurnId,
    bindingVersion: 1,
    turnJtiHash: turn.turn_jti_hash,
    executionLeaseHash: turn.execution_lease_hash,
    sandboxId: "sbx-WRONG",
    workloadIdentity: "wl-WRONG",
    releaseDigest: "a".repeat(64),
    networkPolicyId: "np-1",
    egressTokenId: "eg-1",
    startTime: Math.floor(Date.now() / 1000),
    attestorKid: "attestor-1",
  });
  const started = await prepared.store.startExecution({ remoteTurnId: prepared.remoteTurnId, startProofJws: badProof });
  assert.equal(started.ok, false);
  const status = await (async () => {
    const pg = (await import("pg")).default;
    const p = new pg.Pool({ connectionString: URL! });
    try {
      const { rows } = await p.query("SELECT status FROM remote_turn WHERE id=$1", [prepared.remoteTurnId]);
      return rows[0].status;
    } finally {
      await p.end();
    }
  })();
  assert.equal(status, "parked");
  void versionRow;
}

test("abort during dispatching revokes JTI and refuses a later claim", { skip }, async () => {
  const attestor = await makeEdKeys("attestor-1");
  const bindingId = `binding-${randomUUID()}`;
  const scopeId = `scope-${randomUUID()}`;
  const bindings = createRemoteBindingStore(URL!);
  await bindings.createBinding({ ...bindingBase, bindingId, allowedScopeId: scopeId, attestorKeys: attestor.keySet });
  const runStore = createPostgresRunStore(URL!);
  const store = createRemoteTurnStore(URL!, {
    runs: runStore.runs,
    abortKey: { kid: "abort-1", privateKeyPem: attestor.privateKey.export({ type: "pkcs8", format: "pem" }).toString() },
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

  const aborted = await store.abort({ remoteTurnId: admitted.remoteTurnId, actor: "actor-1" });
  assert.equal(aborted.ok, true);
  assert.ok(aborted.ok && aborted.status === "cancel_requested");

  const versionRow = await (async () => {
    const pg = (await import("pg")).default;
    const p = new pg.Pool({ connectionString: URL! });
    try {
      const { rows } = await p.query("SELECT version, abort_requested_at FROM remote_turn WHERE id=$1", [
        admitted.remoteTurnId,
      ]);
      return { version: Number(rows[0].version), abortRequestedAt: rows[0].abort_requested_at };
    } finally {
      await p.end();
    }
  })();
  assert.ok(versionRow.abortRequestedAt !== null, "abort must persist abort_requested_at");

  const claim = await store.claim({
    remoteTurnId: admitted.remoteTurnId,
    turnJtiHash,
    attestationNonceHash: nonceHash,
    verifiedPreClaim: validPreClaim(admitted.remoteTurnId, turnJtiHash, nonceHash),
    runtimeAudience: "urn:qm:v1:runtime:org-acme:rt",
    version: versionRow.version,
  });
  assert.equal(claim.ok, false, "the pending claim must be refused after abort");
  assert.ok(!claim.ok && claim.reason === "no_lease");

  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: URL! });
  try {
    const lease = await p.query("SELECT * FROM session_leases WHERE holder=$1", [
      `remote_turn:${admitted.remoteTurnId}`,
    ]);
    assert.equal(lease.rows.length, 1, "abort must HOLD the session lease until termination proof");
    const reservation = await p.query("SELECT status FROM budget_reservations WHERE remote_turn_id=$1", [
      admitted.remoteTurnId,
    ]);
    assert.equal(reservation.rows[0].status, "reserved", "abort must HOLD the budget reservation until termination proof");
    const run = await p.query("SELECT status FROM runs WHERE id=$1", [admitted.coreRunId]);
    assert.notEqual(run.rows[0].status, "failed", "abort must leave the run unfailed until termination proof");
  } finally {
    await p.end();
  }

  const terminated = await store.terminateTurn({
    remoteTurnId: admitted.remoteTurnId,
    actor: "attestor-ctl",
    evidence: { sandboxDeleted: true, egressRevoked: true, proofDigest: "e".repeat(64) },
  });
  assert.equal(terminated.ok, true);
  assert.ok(terminated.ok && terminated.status === "cancelled");
  const p2 = new pg.Pool({ connectionString: URL! });
  try {
    const lease = await p2.query("SELECT * FROM session_leases WHERE holder=$1", [
      `remote_turn:${admitted.remoteTurnId}`,
    ]);
    assert.equal(lease.rows.length, 0, "termination proof must release the session lease");
    const reservation = await p2.query("SELECT status FROM budget_reservations WHERE remote_turn_id=$1", [
      admitted.remoteTurnId,
    ]);
    assert.equal(reservation.rows[0].status, "charged", "termination proof must settle the reservation; a dispatched turn without trusted usage is charged in full");
    const run = await p2.query("SELECT status FROM runs WHERE id=$1", [admitted.coreRunId]);
    assert.equal(run.rows[0].status, "failed", "termination proof must fail the run");
    const turn = await p2.query("SELECT status FROM remote_turn WHERE id=$1", [admitted.remoteTurnId]);
    assert.equal(turn.rows[0].status, "cancelled");
  } finally {
    await p2.end();
  }
});

test("disable enumerates active turns and parks or cancels each target with typed results", { skip }, async () => {
  const attestor = await makeEdKeys("attestor-1");
  const bindingId = `binding-${randomUUID()}`;
  const scopeId = `scope-${randomUUID()}`;
  const bindings = createRemoteBindingStore(URL!);
  await bindings.createBinding({
    ...bindingBase,
    bindingId,
    allowedScopeId: scopeId,
    attestorKeys: attestor.keySet,
    budgetCeilingUsd: 100.0,
  });
  const seedPg = (await import("pg")).default;
  const seedPool = new seedPg.Pool({ connectionString: URL! });
  try {
    const windowAnchor = Math.floor(Date.now() / 3_600_000) * 3_600_000;
    await seedPool.query(
      "INSERT INTO budget_balances(scope_id, window_anchor_ms, available_usd) VALUES($1,$2,$3) ON CONFLICT (scope_id, window_anchor_ms) DO NOTHING",
      [scopeId, windowAnchor, 200.0],
    );
  } finally {
    await seedPool.end();
  }
  const a = await prepareTurn({ bindingId, scopeId });
  const b = await prepareTurn({ bindingId, scopeId });

  const disabled = await a.store.disable({ bindingId: a.bindingId, actor: "deploy-ctl" });
  assert.equal(disabled.ok, true);
  assert.ok(disabled.ok);
  assert.ok(disabled.bindingVersion >= 2, "disable must bump the binding version");
  const ids = new Set(disabled.targets.map((t) => t.remoteTurnId));
  assert.ok(ids.has(a.remoteTurnId));
  assert.ok(ids.has(b.remoteTurnId));
  for (const target of disabled.targets) {
    assert.ok(["cancelled", "parked", "failed"].includes(target.outcome), `unexpected outcome ${target.outcome}`);
  }

  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: URL! });
  try {
    const { rows } = await p.query("SELECT enabled FROM remote_runtime_binding WHERE id=$1", [a.bindingId]);
    assert.equal(rows[0].enabled, false);
  } finally {
    await p.end();
  }
});

test("reconciliation moves a parked turn to failed when the attestor proves no sandbox ever started", { skip }, async () => {
  const attestor = await makeEdKeys("attestor-1");
  const prepared = await prepareTurn();
  await parkTurn(prepared, attestor);

  const gateway: AttestorGateway = {
    async querySandboxState(_remoteTurnId): Promise<SandboxState> {
      return { exists: false, running: false, startProofSeen: false, terminationSeen: false, egressRevoked: false, terminationProofDigest: null };
    },
  };
  const reconciler = createRemoteTurnReconciler({ store: prepared.store, attestor: gateway });
  const result = await reconciler.sweep();
  assert.equal(result.reconciled, 1);
  assert.deepEqual(result.alerts, []);

  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: URL! });
  try {
    const { rows } = await p.query("SELECT status FROM remote_turn WHERE id=$1", [prepared.remoteTurnId]);
    assert.equal(rows[0].status, "failed");
    const { rows: runRows } = await p.query("SELECT status FROM runs WHERE id=$1", [prepared.coreRunId]);
    assert.equal(runRows[0].status, "failed");
    const { rows: reservationRows } = await p.query(
      "SELECT status FROM budget_reservations WHERE remote_turn_id=$1",
      [prepared.remoteTurnId],
    );
    assert.equal(reservationRows.length, 1, "the reservation must be settled for failed reconciliation");
    assert.equal(reservationRows[0].status, "charged", "a claimed turn reconciled without trusted usage must be charged in full");
    const { rows: balanceRows } = await p.query(
      "SELECT available_usd FROM budget_balances WHERE scope_id=$1",
      [prepared.scopeId],
    );
    assert.equal(Number(balanceRows[0].available_usd), 0, "no top-up may be released without trusted usage");
  } finally {
    await p.end();
  }
  assert.equal(prepared.terminalEvents.length, 1, "onTerminal must fire for the reconciled run");
});

test("reconciliation cannot rewrite a terminal record", { skip }, async () => {
  const attestor = await makeEdKeys("attestor-1");
  const prepared = await prepareTurn();
  await parkTurn(prepared, attestor);

  const gateway: AttestorGateway = {
    async querySandboxState(_remoteTurnId): Promise<SandboxState> {
      return { exists: false, running: false, startProofSeen: false, terminationSeen: false, egressRevoked: false, terminationProofDigest: null };
    },
  };
  const reconciler = createRemoteTurnReconciler({ store: prepared.store, attestor: gateway });
  await reconciler.sweep();

  const second = await reconciler.sweep();
  assert.equal(second.reconciled, 0, "a terminal record must never be reconciled again");
});

test("reconciliation emits a 24h operator alert without auto-charging or releasing the lease", { skip }, async () => {
  const attestor = await makeEdKeys("attestor-1");
  const prepared = await prepareTurn();
  await parkTurn(prepared, attestor);

  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: URL! });
  try {
    const { rows } = await p.query("SELECT parked_at FROM remote_turn WHERE id=$1", [prepared.remoteTurnId]);
    assert.ok(rows[0].parked_at !== null, "parked_at must be stamped by the park transition, not by the test");
    await p.query("UPDATE remote_turn SET parked_at=$1 WHERE id=$2", [Date.now() - 25 * 60 * 60 * 1000, prepared.remoteTurnId]);
  } finally {
    await p.end();
  }

  const gateway: AttestorGateway = {
    async querySandboxState(_remoteTurnId): Promise<SandboxState> {
      return { exists: true, running: true, startProofSeen: true, terminationSeen: false, egressRevoked: false, terminationProofDigest: null };
    },
  };
  const errors = createErrorLog();
  const reconciler = createRemoteTurnReconciler({ store: prepared.store, attestor: gateway, errors });
  const result = await reconciler.sweep();
  assert.equal(result.reconciled, 0);
  assert.equal(result.alerts.length, 1, "a parked turn older than 24h must alert");
  const events = await errors.list();
  assert.equal(events.length, 1, "the alert must be recorded durably in the error log");
  assert.equal(events[0]!.code, "remote_turn_parked_long");

  const p2 = new pg.Pool({ connectionString: URL! });
  try {
    const { rows } = await p2.query("SELECT status FROM budget_reservations WHERE remote_turn_id=$1", [
      prepared.remoteTurnId,
    ]);
    assert.equal(rows.length, 1, "no auto-charge: the reservation must be held");
    assert.equal(rows[0].status, "reserved");
  } finally {
    await p2.end();
  }
});

test("concurrent reconciliation CAS lets only one sweeper win", { skip }, async () => {
  const attestor = await makeEdKeys("attestor-1");
  const prepared = await prepareTurn();
  await parkTurn(prepared, attestor);

  const gateway: AttestorGateway = {
    async querySandboxState(_remoteTurnId): Promise<SandboxState> {
      return { exists: false, running: false, startProofSeen: false, terminationSeen: false, egressRevoked: false, terminationProofDigest: null };
    },
  };
  const reconcilerA = createRemoteTurnReconciler({ store: prepared.store, attestor: gateway });
  const reconcilerB = createRemoteTurnReconciler({ store: prepared.store, attestor: gateway });
  const [ra, rb] = await Promise.all([reconcilerA.sweep(), reconcilerB.sweep()]);
  assert.equal(ra.reconciled + rb.reconciled, 1, "exactly one sweeper must win the reconcile CAS");

  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: URL! });
  try {
    const { rows } = await p.query("SELECT status FROM remote_turn WHERE id=$1", [prepared.remoteTurnId]);
    assert.equal(rows[0].status, "failed");
  } finally {
    await p.end();
  }
});

test("reconciliation moves a parked turn to completed when the sandbox ran and a reply is stored", { skip }, async () => {
  const attestor = await makeEdKeys("attestor-1");
  const receipt = await makeEdKeys("receipt-1");
  const bindingId = `binding-${randomUUID()}`;
  const scopeId = `scope-${randomUUID()}`;
  const bindings = createRemoteBindingStore(URL!);
  await bindings.createBinding({
    ...bindingBase,
    bindingId,
    allowedScopeId: scopeId,
    attestorKeys: attestor.keySet,
    receiptKeys: receipt.keySet,
  });
  const runStore = createPostgresRunStore(URL!);
  const store = createRemoteTurnStore(URL!, {
    runs: runStore.runs,
    abortKey: { kid: "abort-1", privateKeyPem: attestor.privateKey.export({ type: "pkcs8", format: "pem" }).toString() },
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
  assert.ok(claimed.ok);
  const run = await runStore.runs.claimRemoteOnce(admitted.coreRunId, admitted.runLeaseToken, "dispatch-worker", 60_000);
  assert.ok(run);

  const startProof = await attestor.sign({
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
  const started = await store.startExecution({ remoteTurnId: admitted.remoteTurnId, startProofJws: startProof });
  assert.equal(started.ok, true);

  const receiptToken = await receipt.sign({
    artifact: "receipt",
    schemaVersion: 1,
    remoteTurnId: admitted.remoteTurnId,
    bindingVersion: 1,
    executionLeaseHash: claimed.ok ? claimed.executionLeaseHash : "e".repeat(64),
    inputDigest: createHash("sha256").update(input.text).digest("hex"),
    releaseDigest: "a".repeat(64),
    status: "completed",
    reply: "final answer",
    outputBytes: 12,
    runtimeMs: 30,
    receivedAt: Math.floor(Date.now() / 1000),
  });
  const received = await store.receiveReceipt({ remoteTurnId: admitted.remoteTurnId, receiptToken });
  assert.equal(received.ok, true);

  const teardown = await store.beginTeardown({
    remoteTurnId: admitted.remoteTurnId,
    trustedUsageUsd: null,
    invalidMetering: true,
  });
  assert.equal(teardown, "parked", "invalid metering parks the turn with the reply still stored");

  const gateway: AttestorGateway = {
    async querySandboxState(_remoteTurnId): Promise<SandboxState> {
      return { exists: true, running: false, startProofSeen: true, terminationSeen: false, egressRevoked: false, terminationProofDigest: null };
    },
  };
  const reconciler = createRemoteTurnReconciler({ store, attestor: gateway });
  const result = await reconciler.sweep();
  assert.equal(result.reconciled, 1);
  assert.equal(result.alerts.length, 0);

  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: URL! });
  try {
    const { rows } = await p.query("SELECT status, reply, reconciliation_evidence_ref FROM remote_turn WHERE id=$1", [
      admitted.remoteTurnId,
    ]);
    assert.equal(rows[0].status, "completed", "a ran-and-replied parked turn must reconcile to completed");
    assert.equal(rows[0].reply, "final answer", "the stored reply must be preserved through reconciliation");
    assert.match(rows[0].reconciliation_evidence_ref ?? "", /^[a-f0-9]{64}$/);
    const { rows: runRows } = await p.query("SELECT status, result FROM runs WHERE id=$1", [admitted.coreRunId]);
    assert.equal(runRows[0].status, "done");
    const resultJson = JSON.parse(runRows[0].result);
    assert.equal(resultJson.reply, "final answer", "the run result must carry the reconciled reply");
  } finally {
    await p.end();
  }
});

test("reconciliation moves a parked turn to cancelled when the attestor reports termination", { skip }, async () => {
  const attestor = await makeEdKeys("attestor-1");
  const prepared = await prepareTurn();
  await parkTurn(prepared, attestor);

  const gateway: AttestorGateway = {
    async querySandboxState(_remoteTurnId): Promise<SandboxState> {
      return { exists: true, running: false, startProofSeen: true, terminationSeen: true, egressRevoked: true, terminationProofDigest: "d".repeat(64) };
    },
  };
  const reconciler = createRemoteTurnReconciler({ store: prepared.store, attestor: gateway });
  const result = await reconciler.sweep();
  assert.equal(result.reconciled, 1);

  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: URL! });
  try {
    const { rows } = await p.query("SELECT status FROM remote_turn WHERE id=$1", [prepared.remoteTurnId]);
    assert.equal(rows[0].status, "cancelled");
    const { rows: runRows } = await p.query("SELECT status FROM runs WHERE id=$1", [prepared.coreRunId]);
    assert.equal(runRows[0].status, "failed");
  } finally {
    await p.end();
  }
  assert.equal(prepared.terminalEvents.length, 1, "onTerminal must fire for the cancelled run");
});

test("reconcile never issues a second execution lease", { skip }, async () => {
  const attestor = await makeEdKeys("attestor-1");
  const prepared = await prepareTurn();
  await parkTurn(prepared, attestor);

  const gateway: AttestorGateway = {
    async querySandboxState(_remoteTurnId): Promise<SandboxState> {
      return { exists: false, running: false, startProofSeen: false, terminationSeen: false, egressRevoked: false, terminationProofDigest: null };
    },
  };
  const reconciler = createRemoteTurnReconciler({ store: prepared.store, attestor: gateway });
  await reconciler.sweep();

  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: URL! });
  try {
    const { rows } = await p.query("SELECT execution_lease_hash FROM remote_turn WHERE id=$1", [
      prepared.remoteTurnId,
    ]);
    const existingLease = rows[0].execution_lease_hash;
    const claim = await prepared.store.claim({
      remoteTurnId: prepared.remoteTurnId,
      turnJtiHash: "a".repeat(64),
      attestationNonceHash: "b".repeat(64),
      verifiedPreClaim: validPreClaim(prepared.remoteTurnId, "a".repeat(64), "b".repeat(64)),
      runtimeAudience: "urn:qm:v1:runtime:org-acme:rt",
      version: 999,
    });
    assert.equal(claim.ok, false, "a terminal reconciled turn must never hand out another lease");
    assert.equal(rows[0].execution_lease_hash, existingLease);
  } finally {
    await p.end();
  }
});

test("abort on a pre-dispatch state returns a typed refusal instead of throwing", { skip }, async () => {
  const attestor = await makeEdKeys("attestor-1");
  const bindingId = `binding-${randomUUID()}`;
  const scopeId = `scope-${randomUUID()}`;
  const bindings = createRemoteBindingStore(URL!);
  await bindings.createBinding({ ...bindingBase, bindingId, allowedScopeId: scopeId, attestorKeys: attestor.keySet });
  const runStore = createPostgresRunStore(URL!);
  const store = createRemoteTurnStore(URL!, {
    runs: runStore.runs,
    abortKey: { kid: "abort-1", privateKeyPem: attestor.privateKey.export({ type: "pkcs8", format: "pem" }).toString() },
  });
  const input = admitInput(bindingId, scopeId);
  const admitted = await store.admit(input);
  assert.equal(admitted.status, "admitted");
  assert.ok(admitted.status === "admitted");

  const aborted = await store.abort({ remoteTurnId: admitted.remoteTurnId, actor: "actor-1" });
  assert.equal(aborted.ok, false, "abort before dispatch must not succeed");
  assert.ok(!aborted.ok && aborted.reason === "not_abortable");

  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: URL! });
  try {
    const { rows } = await p.query("SELECT status, abort_requested_at FROM remote_turn WHERE id=$1", [
      admitted.remoteTurnId,
    ]);
    assert.equal(rows[0].status, "admitted", "the turn must stay admitted");
    assert.ok(rows[0].abort_requested_at !== null, "abort intent must still be recorded");
  } finally {
    await p.end();
  }
});

test("reconciler sweeps expired dispatching turns to failed_pre_dispatch", { skip }, async () => {
  const attestor = await makeEdKeys("attestor-1");
  const bindingId = `binding-${randomUUID()}`;
  const scopeId = `scope-${randomUUID()}`;
  const bindings = createRemoteBindingStore(URL!);
  await bindings.createBinding({ ...bindingBase, bindingId, allowedScopeId: scopeId, attestorKeys: attestor.keySet });
  const runStore = createPostgresRunStore(URL!);
  const store = createRemoteTurnStore(URL!, {
    runs: runStore.runs,
    abortKey: { kid: "abort-1", privateKeyPem: attestor.privateKey.export({ type: "pkcs8", format: "pem" }).toString() },
  });
  const input = admitInput(bindingId, scopeId);
  const admitted = await store.admit(input);
  assert.equal(admitted.status, "admitted");
  assert.ok(admitted.status === "admitted");
  const dispatched = await store.prepareDispatch({
    remoteTurnId: admitted.remoteTurnId,
    leaseToken: admitted.runLeaseToken,
    envelope: envelope(),
  });
  assert.equal(dispatched.ok, true);

  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: URL! });
  try {
    await p.query("UPDATE remote_turn SET pre_claim_expires_at=$1 WHERE id=$2", [
      Math.floor(Date.now() / 1000) - 10,
      admitted.remoteTurnId,
    ]);
  } finally {
    await p.end();
  }

  const gateway: AttestorGateway = {
    async querySandboxState(_remoteTurnId): Promise<SandboxState> {
      return { exists: false, running: false, startProofSeen: false, terminationSeen: false, egressRevoked: false, terminationProofDigest: null };
    },
  };
  const reconciler = createRemoteTurnReconciler({ store, attestor: gateway });
  const result = await reconciler.sweep();
  assert.equal(result.reconciled, 1, "the expired dispatching turn must be reconciled");

  const p2 = new pg.Pool({ connectionString: URL! });
  try {
    const { rows } = await p2.query("SELECT status FROM remote_turn WHERE id=$1", [admitted.remoteTurnId]);
    assert.equal(rows[0].status, "failed_pre_dispatch");
    const { rows: runRows } = await p2.query("SELECT status FROM runs WHERE id=$1", [admitted.coreRunId]);
    assert.equal(runRows[0].status, "failed");
  } finally {
    await p2.end();
  }
});

test("runtime ceiling sweep times out a claimed turn into cancel_requested and terminates it on proof", { skip }, async () => {
  const attestor = await makeEdKeys("attestor-1");
  const prepared = await prepareTurn();
  const { store, remoteTurnId } = prepared;

  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: URL! });
  try {
    await p.query("UPDATE remote_turn SET claim_expires_at=$1 WHERE id=$2", [
      Math.floor(Date.now() / 1000) - 10,
      remoteTurnId,
    ]);
  } finally {
    await p.end();
  }

  const gateway: AttestorGateway = {
    async querySandboxState(_remoteTurnId): Promise<SandboxState> {
      return { exists: true, running: true, startProofSeen: true, terminationSeen: false, egressRevoked: false, terminationProofDigest: null };
    },
  };
  const reconciler = createRemoteTurnReconciler({ store, attestor: gateway });
  const result = await reconciler.sweep();
  assert.equal(result.reconciled, 1, "the claimed turn past its ceiling must be reconciled");

  const p2 = new pg.Pool({ connectionString: URL! });
  try {
    const { rows } = await p2.query("SELECT status FROM remote_turn WHERE id=$1", [remoteTurnId]);
    assert.equal(rows[0].status, "cancel_requested", "ceiling timeout must move the turn to cancel_requested");
    const lease = await p2.query("SELECT * FROM session_leases WHERE holder=$1", [`remote_turn:${remoteTurnId}`]);
    assert.equal(lease.rows.length, 1, "the session lease must be held while cancellation is pending");
  } finally {
    await p2.end();
  }
  void attestor;
});

test("reconciler fails orphaned remote_once runs that never admitted", { skip }, async () => {
  const attestor = await makeEdKeys("attestor-1");
  const prepared = await prepareTurn();
  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: URL! });
  const orphanRunId = `orphan-${randomUUID()}`;
  const pendingOrphanRunId = `orphan-pending-${randomUUID()}`;
  try {
    await p.query(
      "INSERT INTO runs(id, session_id, status, request, attempts, max_attempts, delivery_mode, lease_token, lease_expires_at, created_at) VALUES($1,$2,'running','{}',1,3,'remote_once',$3,$4,$5)",
      [orphanRunId, "session-orphan", randomUUID(), Math.floor(Date.now()) - 1000, Math.floor(Date.now())],
    );
    await p.query(
      "INSERT INTO runs(id, session_id, status, request, attempts, max_attempts, delivery_mode, lease_token, lease_expires_at, created_at) VALUES($1,$2,'pending','{}',1,3,'remote_once',$3,$4,$5)",
      [pendingOrphanRunId, "session-orphan", randomUUID(), Math.floor(Date.now()) - 1000, Math.floor(Date.now())],
    );
  } finally {
    await p.end();
  }
  const gateway: AttestorGateway = {
    async querySandboxState(_remoteTurnId): Promise<SandboxState> {
      return { exists: false, running: false, startProofSeen: false, terminationSeen: false, egressRevoked: false, terminationProofDigest: null };
    },
  };
  const reconciler = createRemoteTurnReconciler({ store: prepared.store, attestor: gateway });
  const result = await reconciler.sweep();
  assert.ok(result.reconciled >= 1, "the orphaned remote_once run must be failed by the sweep");
  const p2 = new pg.Pool({ connectionString: URL! });
  try {
    const { rows } = await p2.query("SELECT status FROM runs WHERE id=$1", [orphanRunId]);
    assert.equal(rows[0].status, "failed", "the orphaned running run must be failed");
    const { rows: pendingRows } = await p2.query("SELECT status FROM runs WHERE id=$1", [pendingOrphanRunId]);
    assert.equal(pendingRows[0].status, "failed", "the orphaned pending run must be failed");
  } finally {
    await p2.end();
  }
  void attestor;
});

test("renewRemoteLease keeps a parked turn's remote session lease alive past its TTL", { skip }, async () => {
  const attestor = await makeEdKeys("attestor-1");
  const prepared = await prepareTurn();
  await parkTurn(prepared, attestor);
  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: URL! });
  try {
    const holder = `remote_turn:${prepared.remoteTurnId}`;
    await p.query("UPDATE session_leases SET expires_at=$1 WHERE holder=$2", [Math.floor(Date.now()) - 1000, holder]);
    const renewed = await prepared.store.renewRemoteLease(prepared.remoteTurnId);
    assert.equal(renewed, true, "the parked turn's lease must be renewable");
    const { rows } = await p.query("SELECT expires_at, holder FROM session_leases WHERE holder=$1", [holder]);
    assert.equal(rows.length, 1);
    assert.ok(Number(rows[0].expires_at) > Date.now(), "the lease expiry must be extended past now");
  } finally {
    await p.end();
  }
});

test("acquireLease cannot steal an expired remote_turn: holder lease", { skip }, async () => {
  const attestor = await makeEdKeys("attestor-1");
  const prepared = await prepareTurn();
  await parkTurn(prepared, attestor);
  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: URL! });
  const sessionId = (await (async () => {
    const { rows } = await p.query("SELECT qm_session_id FROM remote_turn WHERE id=$1", [prepared.remoteTurnId]);
    return rows[0].qm_session_id as string;
  })());
  try {
    const holder = `remote_turn:${prepared.remoteTurnId}`;
    await p.query("UPDATE session_leases SET expires_at=$1 WHERE holder=$2", [Math.floor(Date.now()) - 1000, holder]);
    const { createPostgresSessionStore } = await import("../src/sessions/postgres-session-store.ts");
    const sessions = createPostgresSessionStore(URL!);
    const attempt = await sessions.acquireLease(sessionId, "local-turn" as never);
    assert.equal(attempt.lease, null, "a remote_turn: holder lease must not be stealable even when expired");
    const { rows } = await p.query("SELECT holder FROM session_leases WHERE session_id=$1", [sessionId]);
    assert.equal(rows[0].holder, holder, "the remote holder must still own the lease");
  } finally {
    await p.end();
  }
});

test("deleteSession succeeds for a session whose remote turn completed", { skip }, async () => {
  const attestor = await makeEdKeys("attestor-1");
  const prepared = await prepareTurn();
  await parkTurn(prepared, attestor);
  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: URL! });
  const sessionId = (await (async () => {
    const { rows } = await p.query("SELECT qm_session_id FROM remote_turn WHERE id=$1", [prepared.remoteTurnId]);
    return rows[0].qm_session_id as string;
  })());
  try {
    const reconcile = await prepared.store.reconcile({
      remoteTurnId: prepared.remoteTurnId,
      outcome: "cancelled",
      evidenceDigest: "f".repeat(64),
    });
    assert.equal(reconcile.ok, true);
    const { createPostgresSessionStore } = await import("../src/sessions/postgres-session-store.ts");
    const sessions = createPostgresSessionStore(URL!);
    await sessions.deleteSession(sessionId);
    const { rows } = await p.query("SELECT id FROM sessions WHERE id=$1", [sessionId]);
    assert.equal(rows.length, 0, "the session must be deleted after its remote turn is terminal");
  } finally {
    await p.end();
  }
});

test("reconciler refuses to cancel without attestor-reported egress revocation evidence", { skip }, async () => {
  const prepared = await prepareTurn();
  const { store, remoteTurnId } = prepared;
  const abortResult = await store.abort({ remoteTurnId, actor: "actor-1" });
  assert.ok(abortResult.ok && abortResult.status === "cancel_requested");

  const gateway: AttestorGateway = {
    async querySandboxState(_remoteTurnId): Promise<SandboxState> {
      return { exists: false, running: false, startProofSeen: true, terminationSeen: true, egressRevoked: false, terminationProofDigest: null };
    },
  };
  const reconciler = createRemoteTurnReconciler({ store, attestor: gateway });
  const result = await reconciler.sweep();
  assert.equal(result.reconciled, 0, "termination without egress revocation evidence must not cancel");

  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: URL! });
  try {
    const { rows } = await p.query("SELECT status FROM remote_turn WHERE id=$1", [remoteTurnId]);
    assert.equal(rows[0].status, "cancel_requested", "the turn must stay cancel_requested awaiting revocation evidence");
  } finally {
    await p.end();
  }
});

test("reconciler cancels on attestor-reported termination plus revocation and records the attestor proof digest", { skip }, async () => {
  const prepared = await prepareTurn();
  const { store, remoteTurnId } = prepared;
  const abortResult = await store.abort({ remoteTurnId, actor: "actor-1" });
  assert.ok(abortResult.ok && abortResult.status === "cancel_requested");

  const attestorDigest = createHash("sha256").update("attestor-termination-proof").digest("hex");
  const gateway: AttestorGateway = {
    async querySandboxState(_remoteTurnId): Promise<SandboxState> {
      return { exists: false, running: false, startProofSeen: true, terminationSeen: true, egressRevoked: true, terminationProofDigest: attestorDigest };
    },
  };
  const reconciler = createRemoteTurnReconciler({ store, attestor: gateway });
  const result = await reconciler.sweep();
  assert.equal(result.reconciled, 1);

  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: URL! });
  try {
    const { rows } = await p.query("SELECT status FROM remote_turn WHERE id=$1", [remoteTurnId]);
    assert.equal(rows[0].status, "cancelled");
    const { rows: eventRows } = await p.query(
      "SELECT payload FROM remote_turn_events WHERE remote_turn_id=$1 AND event_type='complete'",
      [remoteTurnId],
    );
    const payload = typeof eventRows[0].payload === "string" ? JSON.parse(eventRows[0].payload) : eventRows[0].payload;
    assert.equal(payload.proofDigest, createHash("sha256").update(attestorDigest).digest("hex"), "the recorded digest must be the hash of the attestor-reported digest, never a synthetic one");
  } finally {
    await p.end();
  }
});

test("terminateTurn charges the full reservation when no trusted usage exists", { skip }, async () => {
  const prepared = await prepareTurn();
  const { store, remoteTurnId, scopeId } = prepared;
  const abortResult = await store.abort({ remoteTurnId, actor: "actor-1" });
  assert.ok(abortResult.ok && abortResult.status === "cancel_requested");
  const result = await store.terminateTurn({
    remoteTurnId,
    actor: "attestor-ctl",
    evidence: { sandboxDeleted: true, egressRevoked: true, proofDigest: "f".repeat(64) },
  });
  assert.ok(result.ok && result.status === "cancelled");
  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: URL! });
  try {
    const { rows } = await p.query("SELECT status FROM remote_turn WHERE id=$1", [remoteTurnId]);
    assert.equal(rows[0].status, "cancelled");
    const { rows: reservationRows } = await p.query(
      "SELECT status FROM budget_reservations WHERE remote_turn_id=$1",
      [remoteTurnId],
    );
    assert.equal(reservationRows[0].status, "charged", "post-claim cancellation without trusted usage must charge in full");
    const { rows: balanceRows } = await p.query(
      "SELECT available_usd FROM budget_balances WHERE scope_id=$1",
      [scopeId],
    );
    assert.equal(Number(balanceRows[0].available_usd), 0, "no top-up may be released on cancellation without trusted usage");
  } finally {
    await p.end();
  }
});

test("terminateTurn refuses without termination evidence", { skip }, async () => {
  const attestor = await makeEdKeys("attestor-1");
  const prepared = await prepareTurn();
  const { store, remoteTurnId } = prepared;
  const abortResult = await store.abort({ remoteTurnId, actor: "actor-1" });
  assert.ok(abortResult.ok);
  const refused = await store.terminateTurn({
    remoteTurnId,
    actor: "attestor-ctl",
    evidence: { sandboxDeleted: false, egressRevoked: false, proofDigest: "0".repeat(64) },
  });
  assert.equal(refused.ok, false, "termination without verified evidence must be refused");
  assert.ok(!refused.ok && refused.reason === "not_abortable");
  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: URL! });
  try {
    const { rows } = await p.query("SELECT status FROM remote_turn WHERE id=$1", [remoteTurnId]);
    assert.equal(rows[0].status, "cancel_requested", "the turn must stay cancel_requested awaiting proof");
  } finally {
    await p.end();
  }
  void attestor;
});

test("reconciler resends the persisted envelope to dispatching turns via the transport", { skip }, async () => {
  const attestor = await makeEdKeys("attestor-1");
  const bindingId = `binding-${randomUUID()}`;
  const scopeId = `scope-${randomUUID()}`;
  const bindings = createRemoteBindingStore(URL!);
  const binding = await bindings.createBinding({
    ...bindingBase,
    bindingId,
    allowedScopeId: scopeId,
    attestorKeys: attestor.keySet,
    transportServiceId: "svc-resend",
  });
  const store = createRemoteTurnStore(URL!, {
    abortKey: { kid: attestor.kid, privateKeyPem: attestor.privateKey.export({ type: "pkcs8", format: "pem" }).toString() },
  });
  const input = admitInput(bindingId, scopeId);
  const admitted = await store.admit(input);
  assert.equal(admitted.status, "admitted");
  if (admitted.status !== "admitted") return;
  const enc = envelope();
  const dispatched = await store.prepareDispatch({
    remoteTurnId: admitted.remoteTurnId,
    leaseToken: admitted.runLeaseToken,
    envelope: enc,
  });
  assert.equal(dispatched.ok, true);

  const sent: Array<Record<string, unknown>> = [];
  const transport = {
    resolveService: (id: string) => (id === "svc-resend" ? "https://runtime.test" : null),
    async sendTurn(payload: { remoteTurnId: string }, _serviceId: string, _baseUrl: string) {
      sent.push(payload as unknown as Record<string, unknown>);
      return { ok: true as const };
    },
  };
  const reconciler = createRemoteTurnReconciler({
    store,
    attestor: { querySandboxState: async () => ({ exists: false, running: false, startProofSeen: false, terminationSeen: false, egressRevoked: false, terminationProofDigest: null }) },
    transport: transport as never,
    bindings,
  });
  const result = await reconciler.sweep();
  assert.equal(sent.length, 1, "the dispatching turn must be resent");
  assert.equal(sent[0]!["remoteTurnId"], admitted.remoteTurnId);
  assert.ok(typeof sent[0]!["turnToken"] === "string" && sent[0]!["turnToken"].length > 0, "the persisted turn token must be sent");
  assert.equal(result.reconciled >= 1, true);

  await bindings.close();
});

test("reconciler first-dispatches admitted turns via prepareDispatch and the transport", { skip }, async () => {
  const attestor = await makeEdKeys("attestor-1");
  const bindingId = `binding-${randomUUID()}`;
  const scopeId = `scope-${randomUUID()}`;
  const bindings = createRemoteBindingStore(URL!);
  await bindings.createBinding({
    ...bindingBase,
    bindingId,
    allowedScopeId: scopeId,
    attestorKeys: attestor.keySet,
    transportServiceId: "svc-first",
  });
  const store = createRemoteTurnStore(URL!, {
    abortKey: { kid: attestor.kid, privateKeyPem: attestor.privateKey.export({ type: "pkcs8", format: "pem" }).toString() },
  });
  const input = admitInput(bindingId, scopeId);
  const admitted = await store.admit(input);
  assert.equal(admitted.status, "admitted");
  if (admitted.status !== "admitted") return;

  const sent: Array<Record<string, unknown>> = [];
  const transport = {
    resolveService: (id: string) => (id === "svc-first" ? "https://runtime.test" : null),
    async sendTurn(payload: Record<string, unknown>, _serviceId: string, _baseUrl: string) {
      sent.push(payload);
      return { ok: true as const };
    },
  };
  const reconciler = createRemoteTurnReconciler({
    store,
    attestor: { querySandboxState: async () => ({ exists: false, running: false, startProofSeen: false, terminationSeen: false, egressRevoked: false, terminationProofDigest: null }) },
    transport: transport as never,
    bindings,
  });
  const result = await reconciler.sweep();
  assert.equal(sent.length, 1, "the admitted turn must be first-dispatched");
  assert.equal(sent[0]!["remoteTurnId"], admitted.remoteTurnId);
  assert.ok(typeof sent[0]!["turnToken"] === "string" && sent[0]!["turnToken"].length > 0, "a turn token must be minted at dispatch");
  assert.equal(result.reconciled >= 1, true);

  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: URL! });
  try {
    const { rows } = await p.query("SELECT status FROM remote_turn WHERE id=$1", [admitted.remoteTurnId]);
    assert.equal(rows[0].status, "dispatching", "the turn must reach dispatching");
  } finally {
    await p.end();
  }
  await bindings.close();
});
