import { test, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  createRemoteTurnStore,
  type AdmitInput,
  type G0Context,
} from "../src/remote-turn/store.ts";
import { createRemoteBindingStore, type CreateBindingInput } from "../src/remote-turn/binding-store.ts";

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "set DATABASE_URL (a Postgres) to run the Remote Turn audit-read tests";

before(async () => {
  if (!URL) return;
  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: URL });
  await p.query(
    "DROP TABLE IF EXISTS remote_turn_audit_reads, remote_turn_events, remote_turn, remote_runtime_binding, budget_reservations, budget_balances, session_leases, sessions, runs CASCADE",
  );
  await p.end();
});

const bindingInput: CreateBindingInput = {
  bindingId: "binding-audit",
  configuredOrgId: "org-acme",
  allowedScopeId: "scope-audit",
  protocolVersion: 1,
  runtimeAudience: "urn:qm:v1:runtime:org-acme:audit",
  transportServiceId: "audit-transport",
  transportCertificatePin: "sha256:testpin",
  releaseDigest: "d".repeat(64),
  releaseAttestationKeyId: "attestor-audit",
  receiptKeySetVersion: 1,
  meteringKeySetVersion: 1,
  maxInputBytes: 32_768,
  maxHistoryMessages: 8,
  maxOutputBytes: 16_384,
  maxRuntimeMs: 60_000,
  tokenTtlMs: 90_000,
  budgetCeilingUsd: 100,
  coreVerificationKeys: [],
  attestorKeys: [],
  receiptKeys: [],
  meteringKeys: [],
  policySnapshotHash: "p".repeat(64),
  createdBy: "deployment-controller",
};

function g0(scopeId: string, conversationKey: string): G0Context {
  return {
    actorId: "actor-1",
    scopeId,
    conversationKey,
    governanceDecisionId: "gov-1",
    governanceAuthorizationDigest: "g".repeat(64),
    traceId: "trace-1",
  };
}

function admitInput(scopeId: string, bindingId: string): AdmitInput {
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

async function seedTurn(store: ReturnType<typeof createRemoteTurnStore>, scopeId: string): Promise<string> {
  const bindings = createRemoteBindingStore(URL!);
  const bindingId = `binding-${randomUUID()}`;
  await bindings.createBinding({ ...bindingInput, bindingId, allowedScopeId: scopeId });
  const result = await store.admit(admitInput(scopeId, bindingId));
  if (result.status !== "admitted") throw new Error(`seed admit refused: ${JSON.stringify(result)}`);
  assert.equal(result.status, "admitted");
  return result.status === "admitted" ? result.remoteTurnId : "";
}

test("refused admission records a durable denial event keyed by the run id", { skip }, async () => {
  const authorized: Array<[string, string]> = [["scope-a", "operator-a"]];
  const store = createRemoteTurnStore(URL!, {
    authorizedOperators: async (scopeId, operatorId) =>
      authorized.some(([s, o]) => s === scopeId && o === operatorId),
  });
  const bindings = createRemoteBindingStore(URL!);
  const bindingId = `binding-deny-${randomUUID()}`;
  await bindings.createBinding({ ...bindingInput, bindingId, allowedScopeId: "scope-a" });
  const input = admitInput("scope-a", bindingId);
  const denied = await store.admit({
    ...input,
    g0: { ...input.g0, actorId: "actor-other" },
  });
  assert.equal(denied.status, "refused");

  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: URL! });
  try {
    const denial = await p.query(
      "SELECT payload FROM remote_turn_events WHERE remote_turn_id=$1 AND event_type='refused'",
      [input.coreRunId],
    );
    assert.equal(denial.rows.length, 1, "the refused admission must leave a durable denial event");
    const payload = denial.rows[0].payload as Record<string, unknown>;
    assert.equal(payload.reason, "governance_authorization_required");
  } finally {
    await p.end();
  }
});

test("authorized operator reads only its own scope chain; cross-scope gets not_found with no ID leak and records denied read", { skip }, async () => {
  const authorized: Array<[string, string]> = [["scope-a", "operator-a"]];
  const store = createRemoteTurnStore(URL!, {
    authorizedOperators: async (scopeId, operatorId) =>
      authorized.some(([s, o]) => s === scopeId && o === operatorId),
  });

  await seedTurn(store, "scope-a");

  const own = await store.readAuditChain("scope-a", "operator-a");
  assert.equal(own.status, "ok");
  assert.ok(own.status === "ok" && own.events.length >= 1, "authorized read returns the chain");
  assert.ok(
    own.status === "ok" && own.events.every((e) => typeof e.remoteTurnId === "string" && e.seq >= 1),
    "events carry remoteTurnId and seq",
  );

  const cross = await store.readAuditChain("scope-b", "operator-a");
  assert.equal(cross.status, "not_found", "cross-scope read is not_found");

  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: URL! });
  try {
    const reads = await p.query("SELECT outcome FROM remote_turn_audit_reads WHERE operator_id='operator-a'");
    const outcomes = (reads.rows as Array<{ outcome: string }>).map((r) => r.outcome);
    assert.ok(outcomes.includes("granted"), "authorized read recorded");
    assert.ok(outcomes.includes("denied"), "cross-scope denied read recorded");
  } finally {
    await p.end();
  }
});

test("authorized audit read survives a store restart (durability)", { skip }, async () => {
  const storeA = createRemoteTurnStore(URL!, {
    authorizedOperators: async (scopeId) => scopeId === "scope-c",
  });
  const turnId = await seedTurn(storeA, "scope-c");
  await storeA.close();

  const storeB = createRemoteTurnStore(URL!, {
    authorizedOperators: async (scopeId) => scopeId === "scope-c",
  });
  const after = await storeB.readAuditChain("scope-c", "operator-b");
  assert.equal(after.status, "ok");
  assert.ok(after.status === "ok" && after.events.some((e) => e.remoteTurnId === turnId));
  await storeB.close();
});

test("operator with no authorization hook is always denied (fail closed)", { skip }, async () => {
  const store = createRemoteTurnStore(URL!);
  await seedTurn(store, "scope-d");
  const result = await store.readAuditChain("scope-d", "unknown-operator");
  assert.equal(result.status, "not_found", "no hook means no operator is authorized");
});
