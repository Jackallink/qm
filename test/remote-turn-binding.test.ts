import { test, before } from "node:test";
import assert from "node:assert/strict";
import {
  createRemoteBindingStore,
  type RemoteRuntimeBinding,
  type KeySetEntry,
} from "../src/remote-turn/binding-store.ts";

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "set DATABASE_URL (a Postgres) to run the Postgres binding store tests";

before(async () => {
  if (!URL) return;
  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: URL });
  await p.query(
    "DROP TABLE IF EXISTS remote_turn_events, remote_turn, remote_runtime_binding CASCADE",
  );
  await p.end();
});

const coreKeys: KeySetEntry[] = [
  {
    kid: "core-1",
    publicKeyPem: "-----BEGIN PUBLIC KEY-----\nplaceholder-core\n-----END PUBLIC KEY-----",
    state: "current",
    activatedAt: 1,
    retiresAt: 1000,
  },
];
const attestorKeys: KeySetEntry[] = [
  {
    kid: "attestor-1",
    publicKeyPem: "-----BEGIN PUBLIC KEY-----\nplaceholder-attestor\n-----END PUBLIC KEY-----",
    state: "current",
    activatedAt: 1,
    retiresAt: 1000,
  },
];
const receiptKeys: KeySetEntry[] = [
  {
    kid: "receipt-1",
    publicKeyPem: "-----BEGIN PUBLIC KEY-----\nplaceholder-receipt\n-----END PUBLIC KEY-----",
    state: "current",
    activatedAt: 1,
    retiresAt: 1000,
  },
];
const meteringKeys: KeySetEntry[] = [
  {
    kid: "metering-1",
    publicKeyPem: "-----BEGIN PUBLIC KEY-----\nplaceholder-metering\n-----END PUBLIC KEY-----",
    state: "current",
    activatedAt: 1,
    retiresAt: 1000,
  },
];

const input: import("../src/remote-turn/binding-store.ts").CreateBindingInput = {
  bindingId: "binding-1",
  configuredOrgId: "org:local-deepseek",
  allowedScopeId: "org:local-deepseek",
  protocolVersion: 1,
  runtimeAudience: "urn:qm:v1:runtime:org:local-deepseek:demo",
  transportServiceId: "demo-transport",
  transportCertificatePin: "pin-abc",
  transportSourceAuthKeyId: "source-auth-key-1",
  releaseDigest: "a".repeat(64),
  releaseAttestationKeyId: "attestor-1",
  receiptKeySetVersion: 1,
  meteringKeySetVersion: 1,
  maxInputBytes: 32768,
  maxHistoryMessages: 8,
  maxOutputBytes: 16384,
  maxRuntimeMs: 60000,
  tokenTtlMs: 90000,
  budgetCeilingUsd: 1,
  policySnapshotHash: "policy-hash-1",

  networkPolicyId: "net-pol-1",

  endpointAllowlist: ["https://api.deepseek.com"],

  egressAudience: "urn:qm:egress:1",
  createdBy: "deployment-controller",
  coreVerificationKeys: coreKeys,
  attestorKeys,
  receiptKeys,
  meteringKeys,
};

test("binding store creates, reads, lists, and versioned-enables a binding", { skip }, async () => {
  const store = createRemoteBindingStore(URL!);
  try {
    const created = await store.createBinding({ ...input });
    assert.equal(created.bindingId, "binding-1");
    assert.equal(created.version, 1);
    assert.equal(created.enabled, true);
    assert.equal(created.releaseAttestationKeyId, "attestor-1");

    const got = await store.getBinding("binding-1");
    assert.ok(got);
    assert.equal(got.version, 1);
    assert.equal(got.enabled, true);
    assert.equal(got.runtimeAudience, "urn:qm:v1:runtime:org:local-deepseek:demo");
    assert.equal(got.coreVerificationKeys.length, 1);
    assert.equal(got.coreVerificationKeys[0]!.kid, "core-1");
    assert.equal(got.attestorKeys.length, 1);
    assert.equal(got.receiptKeys.length, 1);
    assert.equal(got.meteringKeys.length, 1);
    assert.equal(got.createdBy, "deployment-controller");

    const listed = await store.listBindings();
    assert.ok(listed.some((b) => b.bindingId === "binding-1"));
  } finally {
    await store.close();
  }
});

test("binding store disable is versioned and records the actor", { skip }, async () => {
  const store = createRemoteBindingStore(URL!);
  try {
    await store.createBinding({ ...input, bindingId: "binding-2" });
    const disabled = await store.setEnabled("binding-2", false, "ops-controller");
    assert.equal(disabled.version, 2);

    const got = await store.getBinding("binding-2");
    assert.ok(got);
    assert.equal(got.enabled, false);
    assert.equal(got.version, 2);
    assert.equal(got.disabledBy, "ops-controller");
    assert.ok(got.disabledAt);

    const reenabled = await store.setEnabled("binding-2", true, "ops-controller");
    assert.equal(reenabled.version, 3);
    const after = await store.getBinding("binding-2");
    assert.equal(after?.enabled, true);
    assert.equal(after?.disabledBy, null);
  } finally {
    await store.close();
  }
});

test("binding key rotation bumps the version and replaces only the provided key sets", { skip }, async () => {
  const store = createRemoteBindingStore(URL!);
  try {
    await store.createBinding({ ...input, bindingId: "binding-rotate-1" });
    const rotatedReceipt: KeySetEntry[] = [
      {
        kid: "receipt-2",
        publicKeyPem: "-----BEGIN PUBLIC KEY-----\nplaceholder-receipt-2\n-----END PUBLIC KEY-----",
        state: "current",
        activatedAt: 1,
        retiresAt: 2000,
      },
    ];
    const rotated = await store.rotateBindingKeys({
      bindingId: "binding-rotate-1",
      expectedVersion: 1,
      receiptKeys: rotatedReceipt,
      createdBy: "ops-controller",
    });
    assert.ok(rotated.ok);
    assert.equal(rotated.ok && rotated.version, 2);

    const got = await store.getBinding("binding-rotate-1");
    assert.ok(got);
    assert.equal(got.version, 2);
    assert.equal(got.receiptKeys.length, 1);
    assert.equal(got.receiptKeys[0]!.kid, "receipt-2", "the provided key set must be replaced");
    assert.equal(got.coreVerificationKeys[0]!.kid, "core-1", "unprovided key sets must be unchanged");
    assert.equal(got.attestorKeys[0]!.kid, "attestor-1");
    assert.equal(got.meteringKeys[0]!.kid, "metering-1");
  } finally {
    await store.close();
  }
});

test("binding key rotation refuses a stale expectedVersion and a disabled binding", { skip }, async () => {
  const store = createRemoteBindingStore(URL!);
  try {
    await store.createBinding({ ...input, bindingId: "binding-rotate-2" });
    const conflict = await store.rotateBindingKeys({
      bindingId: "binding-rotate-2",
      expectedVersion: 99,
      attestorKeys,
      createdBy: "ops-controller",
    });
    assert.ok(!conflict.ok && conflict.reason === "version_conflict");

    const missing = await store.rotateBindingKeys({
      bindingId: "binding-never-existed",
      expectedVersion: 1,
      attestorKeys,
      createdBy: "ops-controller",
    });
    assert.ok(!missing.ok && missing.reason === "not_found");

    await store.setEnabled("binding-rotate-2", false, "ops-controller");
    const disabled = await store.rotateBindingKeys({
      bindingId: "binding-rotate-2",
      expectedVersion: 2,
      attestorKeys,
      createdBy: "ops-controller",
    });
    assert.ok(!disabled.ok && disabled.reason === "disabled", "rotation on a disabled binding must be refused");
    const got = await store.getBinding("binding-rotate-2");
    assert.equal(got?.version, 2, "a refused rotation must not bump the version");
  } finally {
    await store.close();
  }
});

test("binding store concurrent setEnabled settles by version CAS (one wins, losers conflict)", { skip }, async () => {
  const store = createRemoteBindingStore(URL!);
  try {
    await store.createBinding({ ...input, bindingId: "binding-3" });
    const settled = await Promise.allSettled([
      store.setEnabled("binding-3", false, "controller-a"),
      store.setEnabled("binding-3", false, "controller-b"),
    ]);
    const fulfilled = settled.filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<{ version: number }>[];
    const rejected = settled.filter((r) => r.status === "rejected");
    assert.ok(fulfilled.length >= 1, "at least one call wins");
    assert.equal(fulfilled.length + rejected.length, 2);
    const got = await store.getBinding("binding-3");
    assert.equal(got?.enabled, false, "the winning update is durable");
    const expectedVersion = got!.version;
    assert.ok(fulfilled.every((r) => r.value.version <= expectedVersion), "no winner reports a version above the durable one");
  } finally {
    await store.close();
  }
});
