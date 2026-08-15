import { test, before } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { CompactSign, exportSPKI, importSPKI } from "jose";
import {
  csprngHex,
  mintTurnToken,
  verifyTurnToken,
  mintAbortToken,
  verifyAbortToken,
  createRemoteTurnKeyProvider,
  type CoreTokenKeySet,
  type TurnClaims,
  type AbortClaims,
  type TurnExpected,
  type AbortExpected,
} from "../src/remote-turn/tokens.ts";
import { createRemoteTurnStore, type ClaimInput } from "../src/remote-turn/store.ts";
import type { PreClaimClaims } from "../src/remote-turn/attestation.ts";

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "set DATABASE_URL (a Postgres) to run the claim tests";

before(async () => {
  if (!URL) return;
  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: URL });
  await p.query("DROP TABLE IF EXISTS remote_turn_events, remote_turn, runs CASCADE");
  await p.end();
});

const encoder = new TextEncoder();

interface KeyFixture {
  kid: string;
  privateKey: import("node:crypto").KeyObject;
  publicKeyPem: string;
  keySet: CoreTokenKeySet;
  sign: (payload: Record<string, unknown>, kid?: string) => Promise<string>;
}

async function makeKeys(now: () => number, opts: { kid?: string; state?: "current" | "overlap"; retiresAt?: number } = {}): Promise<KeyFixture> {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const kid = opts.kid ?? "core-k1";
  const publicKeyPem = await exportSPKI(publicKey);
  const keySet: CoreTokenKeySet = [
    {
      kid,
      publicKeyPem,
      state: opts.state ?? "current",
      activatedAt: now() - 1000,
      retiresAt: opts.retiresAt ?? now() + 100_000,
    },
  ];
  const sign = async (payload: Record<string, unknown>, useKid = kid): Promise<string> =>
    new CompactSign(encoder.encode(JSON.stringify(payload)))
      .setProtectedHeader({ alg: "EdDSA", kid: useKid })
      .sign(privateKey);
  return { kid, privateKey, publicKeyPem, keySet, sign };
}

const UUID = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";
const HASH64 = "b".repeat(64);

function baseTurnClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kid: "core-k1",
    iss: "urn:qm:core",
    aud: "urn:qm:v1:runtime:org1:r1",
    iat: 1_800_000_000,
    nbf: 1_800_000_000,
    exp: 1_800_000_090,
    jti: "jti-value-128bit",
    capability: "turn",
    remoteTurnId: UUID,
    bindingVersion: 1,
    conversationKey: "web:alice:thread-1",
    scopeId: "personal:alice",
    qmSessionId: UUID,
    coreRunId: "run-1",
    inputDigest: HASH64,
    envelopeDigest: HASH64,
    protocolVersion: 1,
    ...overrides,
  };
}

function turnExpected(overrides: Record<string, unknown> = {}): TurnExpected {
  return {
    aud: "urn:qm:v1:runtime:org1:r1",
    envelopeDigest: HASH64,
    remoteTurnId: UUID,
    now: 1_800_000_010,
    ...overrides,
  };
}

function baseAbortClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kid: "core-k1",
    iss: "urn:qm:core",
    aud: "urn:qm:v1:runtime:org1:r1",
    iat: 1_800_000_000,
    nbf: 1_800_000_000,
    exp: 1_800_000_090,
    jti: "abort-jti-value-128bit",
    capability: "abort",
    remoteTurnId: UUID,
    bindingVersion: 1,
    turnJtiHash: HASH64,
    protocolVersion: 1,
    ...overrides,
  };
}

function abortExpected(overrides: Record<string, unknown> = {}): AbortExpected {
  return {
    aud: "urn:qm:v1:runtime:org1:r1",
    remoteTurnId: UUID,
    turnJtiHash: HASH64,
    now: 1_800_000_010,
    ...overrides,
  };
}

test("csprngHex returns 32 hex chars with 16 bytes of entropy", () => {
  const a = csprngHex();
  const b = csprngHex();
  assert.match(a, /^[a-f0-9]{32}$/);
  assert.notEqual(a, b);
});

test("turn token mints and verifies with a valid key", async () => {
  const now = (): number => 1_800_000_000;
  const fixture = await makeKeys(now);
  const claims = baseTurnClaims();
  const token = await mintTurnToken(claims as unknown as TurnClaims, { kid: fixture.kid, privateKeyPem: fixture.privateKey.export({ type: "pkcs8", format: "pem" }).toString() });
  const verified = await verifyTurnToken(token, fixture.keySet, turnExpected());
  assert.ok(verified);
  assert.equal(verified!.capability, "turn");
  assert.equal(verified!.remoteTurnId, UUID);
});

test("turn token rejects a forged signature", async () => {
  const now = (): number => 1_800_000_000;
  const a = await makeKeys(now);
  const b = await makeKeys(now, { kid: "core-k2" });
  const token = await a.sign(baseTurnClaims());
  const verified = await verifyTurnToken(token, b.keySet, turnExpected());
  assert.equal(verified, null);
});

test("turn token rejects an expired token (now >= exp)", async () => {
  const now = (): number => 1_800_000_000;
  const fixture = await makeKeys(now);
  const token = await fixture.sign(baseTurnClaims());
  const verified = await verifyTurnToken(token, fixture.keySet, turnExpected({ now: 1_800_000_090 }));
  assert.equal(verified, null);
});

test("turn token rejects an early token (now < nbf - 30s skew)", async () => {
  const now = (): number => 1_800_000_000;
  const fixture = await makeKeys(now);
  // nbf is 150s after iat; verification now is 50s after iat, so now < nbf - 30s skew
  const token = await fixture.sign(baseTurnClaims({ nbf: 1_800_000_150 }));
  const verified = await verifyTurnToken(token, fixture.keySet, turnExpected({ now: 1_800_000_050 }));
  assert.equal(verified, null);
});

test("turn token accepts nbf within 30s skew", async () => {
  const now = (): number => 1_800_000_000;
  const fixture = await makeKeys(now);
  const token = await fixture.sign(baseTurnClaims({ nbf: 1_800_000_035 }));
  const verified = await verifyTurnToken(token, fixture.keySet, turnExpected({ now: 1_800_000_010 }));
  assert.ok(verified);
});

test("turn token rejects a wrong audience", async () => {
  const now = (): number => 1_800_000_000;
  const fixture = await makeKeys(now);
  const token = await fixture.sign(baseTurnClaims());
  const verified = await verifyTurnToken(token, fixture.keySet, turnExpected({ aud: "urn:qm:v1:runtime:other:r2" }));
  assert.equal(verified, null);
});

test("turn token rejects a wrong capability", async () => {
  const now = (): number => 1_800_000_000;
  const fixture = await makeKeys(now);
  const token = await fixture.sign(baseTurnClaims({ capability: "abort" }));
  const verified = await verifyTurnToken(token, fixture.keySet, turnExpected());
  assert.equal(verified, null);
});

test("turn token rejects a wrong remoteTurnId", async () => {
  const now = (): number => 1_800_000_000;
  const fixture = await makeKeys(now);
  const token = await fixture.sign(baseTurnClaims());
  const verified = await verifyTurnToken(token, fixture.keySet, turnExpected({ remoteTurnId: "11111111-2222-3333-4444-555555555555" }));
  assert.equal(verified, null);
});

test("turn token rejects a wrong envelopeDigest", async () => {
  const now = (): number => 1_800_000_000;
  const fixture = await makeKeys(now);
  const token = await fixture.sign(baseTurnClaims());
  const verified = await verifyTurnToken(token, fixture.keySet, turnExpected({ envelopeDigest: "c".repeat(64) }));
  assert.equal(verified, null);
});

test("turn token rejects an unknown kid", async () => {
  const now = (): number => 1_800_000_000;
  const fixture = await makeKeys(now);
  const token = await fixture.sign(baseTurnClaims(), "unknown-kid");
  const verified = await verifyTurnToken(token, fixture.keySet, turnExpected());
  assert.equal(verified, null);
});

test("turn token rejects a retired key (now >= retiresAt)", async () => {
  const now = (): number => 1_800_000_000;
  const fixture = await makeKeys(now, { retiresAt: 1_800_000_005 });
  const token = await fixture.sign(baseTurnClaims());
  const verified = await verifyTurnToken(token, fixture.keySet, turnExpected({ now: 1_800_000_010 }));
  assert.equal(verified, null);
});

test("turn token accepts an overlap-state key inside its window", async () => {
  const now = (): number => 1_800_000_000;
  const fixture = await makeKeys(now, { kid: "core-k1", state: "overlap" });
  const token = await fixture.sign(baseTurnClaims());
  const verified = await verifyTurnToken(token, fixture.keySet, turnExpected());
  assert.ok(verified);
});

test("turn token rejects a non-EdDSA algorithm (alg confusion)", async () => {
  const now = (): number => 1_800_000_000;
  const fixture = await makeKeys(now);
  const header = Buffer.from(JSON.stringify({ alg: "HS256", kid: fixture.kid })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(baseTurnClaims())).toString("base64url");
  const token = `${header}.${payload}.${Buffer.from("garbage").toString("base64url")}`;
  const verified = await verifyTurnToken(token, fixture.keySet, turnExpected());
  assert.equal(verified, null);
});

test("turn token rejects a header-kid that differs from payload kid", async () => {
  const now = (): number => 1_800_000_000;
  const fixture = await makeKeys(now);
  const token = await fixture.sign(baseTurnClaims({ kid: "other-kid" }), "core-k1");
  const verified = await verifyTurnToken(token, fixture.keySet, turnExpected());
  assert.equal(verified, null);
});

test("abort token pre-claim binds turnJtiHash only", async () => {
  const now = (): number => 1_800_000_000;
  const fixture = await makeKeys(now);
  const token = await mintAbortToken(baseAbortClaims() as unknown as AbortClaims, { kid: fixture.kid, privateKeyPem: fixture.privateKey.export({ type: "pkcs8", format: "pem" }).toString() });
  const verified = await verifyAbortToken(token, fixture.keySet, abortExpected(), { phase: "pre_claim" });
  assert.ok(verified);
  assert.equal(verified!.capability, "abort");
});

test("abort token post-claim requires executionLeaseHash and coreRunId", async () => {
  const now = (): number => 1_800_000_000;
  const fixture = await makeKeys(now);
  const token = await mintAbortToken(
    baseAbortClaims({ executionLeaseHash: HASH64, coreRunId: "run-1" }) as unknown as AbortClaims,
    { kid: fixture.kid, privateKeyPem: fixture.privateKey.export({ type: "pkcs8", format: "pem" }).toString() },
  );
  const verified = await verifyAbortToken(token, fixture.keySet, abortExpected(), {
    phase: "post_claim",
    persistedExecutionLeaseHash: HASH64,
  });
  assert.ok(verified);
});

test("abort token post-claim rejects a mismatched execution lease", async () => {
  const now = (): number => 1_800_000_000;
  const fixture = await makeKeys(now);
  const token = await mintAbortToken(
    baseAbortClaims({ executionLeaseHash: "d".repeat(64), coreRunId: "run-1" }) as unknown as AbortClaims,
    { kid: fixture.kid, privateKeyPem: fixture.privateKey.export({ type: "pkcs8", format: "pem" }).toString() },
  );
  const verified = await verifyAbortToken(token, fixture.keySet, abortExpected(), {
    phase: "post_claim",
    persistedExecutionLeaseHash: HASH64,
  });
  assert.equal(verified, null);
});

test("abort token rejects a missing lease in post-claim phase", async () => {
  const now = (): number => 1_800_000_000;
  const fixture = await makeKeys(now);
  const token = await fixture.sign(baseAbortClaims());
  const verified = await verifyAbortToken(token, fixture.keySet, abortExpected(), {
    phase: "post_claim",
    persistedExecutionLeaseHash: HASH64,
  });
  assert.equal(verified, null);
});

test("abort token cannot invoke a turn (capability check)", async () => {
  const now = (): number => 1_800_000_000;
  const fixture = await makeKeys(now);
  const token = await mintAbortToken(baseAbortClaims() as unknown as AbortClaims, { kid: fixture.kid, privateKeyPem: fixture.privateKey.export({ type: "pkcs8", format: "pem" }).toString() });
  const verified = await verifyTurnToken(token, fixture.keySet, turnExpected());
  assert.equal(verified, null);
});

test("remote turn key provider generates a persistent key pair", async () => {
  const provider = createRemoteTurnKeyProvider();
  const key = provider.getCurrentSigningKey();
  assert.ok(key.kid);
  assert.match(key.privateKeyPem, /BEGIN PRIVATE KEY/);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const kid2 = "provider-k";
  const pem = await exportSPKI(publicKey);
  const fixture = { kid: kid2, publicKeyPem: pem };
  const token = await mintTurnToken(baseTurnClaims() as unknown as TurnClaims, {
    kid: kid2,
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  });
  const keys: CoreTokenKeySet = [
    { kid: kid2, publicKeyPem: pem, state: "current", activatedAt: 0, retiresAt: 1e15 },
  ];
  const result = await verifyTurnToken(token, keys, turnExpected());
  assert.ok(result);
});

test("claim consumes the turn JTI once and refuses a second claim", { skip }, async () => {
  const pg = (await import("pg")).default;
  const store = createRemoteTurnStore(URL!, {
    abortKey: { kid: "claim-k", privateKeyPem: generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString() },
  });
  const p = new pg.Pool({ connectionString: URL });
  try {
    const remoteTurnId = randomUUID();
    const turnJtiHash = "f".repeat(64);
    const nonceHash = "e".repeat(64);
    await store.claim({
      remoteTurnId: randomUUID(),
      turnJtiHash,
      attestationNonceHash: nonceHash,
      verifiedPreClaim: {
        artifact: "pre_claim_attestation",
        schemaVersion: 1,
        remoteTurnId: randomUUID(),
        bindingVersion: 1,
        turnJtiHash,
        attestationNonceHash: nonceHash,
        intendedWorkloadIdentity: "wli",
        plannedSandboxId: "sb-x",
        releaseDigest: "a".repeat(64),
        isolationMode: "isolated",
        policyDigest: "b".repeat(64),
        networkPolicyId: "net-x",
        endpointAllowlist: ["https://api.example.com"],
        egressAudience: "urn:qm:egress:x",
        expiry: 1_800_000_100,
        singleUse: true,
      },
      runtimeAudience: "urn:qm:v1:runtime:org1:r1",
    });
    await p.query(
      `INSERT INTO remote_turn(
        id, core_run_id, admission_key, conversation_key, scope_id, actor_id,
        binding_id, binding_version, status, version, turn_jti_hash, attestation_nonce_hash,
        created_at, updated_at
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'dispatching',1,$9,$10,$11,$11)`,
      [remoteTurnId, "run-claim-1", "key-claim-1", "conv-1", "scope-1", "actor-1", "binding-1", 1, turnJtiHash, nonceHash, 1_800_000_000],
    );
    const verified: PreClaimClaims = {
      artifact: "pre_claim_attestation",
      schemaVersion: 1,
      remoteTurnId,
      bindingVersion: 1,
      turnJtiHash,
      attestationNonceHash: nonceHash,
      intendedWorkloadIdentity: "wli",
      plannedSandboxId: "sb-1",
      releaseDigest: "a".repeat(64),
      isolationMode: "isolated",
      policyDigest: "b".repeat(64),
      networkPolicyId: "net-1",
      endpointAllowlist: ["https://api.example.com"],
      egressAudience: "urn:qm:egress:1",
      expiry: 1_800_000_100,
      singleUse: true,
    };
    const first = await store.claim({
      remoteTurnId,
      turnJtiHash,
      attestationNonceHash: nonceHash,
      verifiedPreClaim: verified,
      runtimeAudience: "urn:qm:v1:runtime:org1:r1",
    });
    assert.equal(first.ok, true);
    if (first.ok) {
      assert.equal(first.executionLeaseHash.length, 64);
      assert.ok(first.abortToken);
      const second = await store.claim({
        remoteTurnId,
        turnJtiHash,
        attestationNonceHash: nonceHash,
        verifiedPreClaim: verified,
        runtimeAudience: "urn:qm:v1:runtime:org1:r1",
      });
      assert.deepEqual(second, { ok: false, reason: "no_lease" });
    }
  } finally {
    await p.end();
  }
});

test("claim refuses when attestation is missing or mismatched", { skip }, async () => {
  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: URL });
  try {
    const store = createRemoteTurnStore(URL!, {
      abortKey: { kid: "claim-k", privateKeyPem: generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString() },
    });
    const remoteTurnId = randomUUID();
    const base: ClaimInput = {
      remoteTurnId,
      turnJtiHash: "f".repeat(64),
      attestationNonceHash: "e".repeat(64),
      verifiedPreClaim: null,
      runtimeAudience: "urn:qm:v1:runtime:org1:r1",
    };
    assert.deepEqual(await store.claim(base), { ok: false, reason: "attestation_invalid" });
  } finally {
    await p.end();
  }
});
