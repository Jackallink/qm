import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { CompactSign, exportSPKI } from "jose";
import { createAttestationVerifier, type PreClaimExpected, type StartProofExpected } from "../src/remote-turn/attestation.ts";
import type { KeySetEntry } from "../src/remote-turn/binding-store.ts";

const encoder = new TextEncoder();

interface AttestorFixture {
  kid: string;
  keySet: KeySetEntry[];
  sign: (payload: Record<string, unknown>, kid?: string) => Promise<string>;
  now: () => number;
}

async function makeAttestor(now: () => number): Promise<AttestorFixture> {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const kid = "attestor-k1";
  const keySet: KeySetEntry[] = [
    {
      kid,
      publicKeyPem: await exportSPKI(publicKey),
      state: "current",
      activatedAt: now() - 1000,
      retiresAt: now() + 100_000,
    },
  ];
  const signer = async (payload: Record<string, unknown>, useKid = kid): Promise<string> =>
    new CompactSign(encoder.encode(JSON.stringify(payload)))
      .setProtectedHeader({ alg: "EdDSA", kid: useKid })
      .sign(privateKey);
  return {
    kid,
    keySet,
    now,
    sign: signer,
  };
}

const UUID = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";
const HASH64 = "a".repeat(64);

function preClaimPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    artifact: "pre_claim_attestation",
    schemaVersion: 1,
    remoteTurnId: UUID,
    bindingVersion: 1,
    turnJtiHash: HASH64,
    attestationNonceHash: HASH64,
    intendedWorkloadIdentity: "wli",
    plannedSandboxId: "sandbox-1",
    releaseDigest: HASH64,
    isolationMode: "isolated",
    policyDigest: HASH64,
    networkPolicyId: "net-1",
    endpointAllowlist: ["https://api.deepseek.com"],
    egressAudience: "urn:qm:egress:1",
    expiry: 1_800_000_000,
    singleUse: true,
    ...overrides,
  };
}

function preClaimExpected(overrides: Record<string, unknown> = {}): PreClaimExpected {
  return {
    remoteTurnId: UUID,
    bindingVersion: 1,
    turnJtiHash: HASH64,
    attestationNonceHash: HASH64,
    intendedWorkloadIdentity: "wli",
    releaseDigest: HASH64,
    policyDigest: HASH64,
    endpointAllowlist: ["https://api.deepseek.com"],
    egressAudience: "urn:qm:egress:1",
    expiry: 1_800_000_000,
    singleUse: true,
    ...overrides,
  } as unknown as PreClaimExpected;
}

function startProofPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    artifact: "start_proof",
    schemaVersion: 1,
    remoteTurnId: UUID,
    bindingVersion: 1,
    turnJtiHash: HASH64,
    executionLeaseHash: HASH64,
    sandboxId: "sandbox-1",
    workloadIdentity: "wli",
    releaseDigest: HASH64,
    networkPolicyId: "net-1",
    egressTokenId: "eg-1",
    startTime: 1_800_000_100,
    attestorKid: "attestor-k1",
    ...overrides,
  };
}

function startProofExpected(overrides: Record<string, unknown> = {}): StartProofExpected {
  return {
    executionLeaseHash: HASH64,
    plannedSandboxId: "sandbox-1",
    intendedWorkloadIdentity: "wli",
    turnJtiHash: HASH64,
    ...overrides,
  } as unknown as StartProofExpected;
}

test("verifyPreClaimAttestation accepts a valid attestor-signed pre-claim attestation", async () => {
  const fixture = await makeAttestor(() => 1_799_999_000);
  const verifier = createAttestationVerifier({ now: fixture.now });
  const jws = await fixture.sign(preClaimPayload());
  const claims = await verifier.verifyPreClaimAttestation(jws, {
    attestationKeySet: fixture.keySet,
    expected: preClaimExpected() as unknown as PreClaimExpected,
  });
  assert.ok(claims);
  assert.equal(claims.remoteTurnId, UUID);
  assert.equal(claims.plannedSandboxId, "sandbox-1");
});

test("verifyPreClaimAttestation rejects a tampered signature", async () => {
  const fixture = await makeAttestor(() => 1_799_999_000);
  const verifier = createAttestationVerifier({ now: fixture.now });
  const jws = await fixture.sign(preClaimPayload());
  const [header, payload, signature] = jws.split(".");
  const tampered = Buffer.from(JSON.stringify(preClaimPayload({ egressAudience: "urn:qm:egress:evil" }))).toString(
    "base64url",
  );
  const forged = `${header}.${tampered}.${signature}`;
  const claims = await verifier.verifyPreClaimAttestation(forged, {
    attestationKeySet: fixture.keySet,
    expected: preClaimExpected() as unknown as PreClaimExpected,
  });
  assert.equal(claims, null);
});

test("verifyPreClaimAttestation rejects a key outside the pinned attestor set", async () => {
  const fixture = await makeAttestor(() => 1_799_999_000);
  const verifier = createAttestationVerifier({ now: fixture.now });
  const jws = await fixture.sign(preClaimPayload(), "unknown-kid");
  const claims = await verifier.verifyPreClaimAttestation(jws, {
    attestationKeySet: fixture.keySet,
    expected: preClaimExpected() as unknown as PreClaimExpected,
  });
  assert.equal(claims, null);
});

test("verifyPreClaimAttestation rejects a retired key", async () => {
  const fixture = await makeAttestor(() => 1_799_999_000);
  const current = fixture.keySet[0]!;
  fixture.keySet[0] = {
    ...current,
    retiresAt: 1_799_998_000,
  };
  const verifier = createAttestationVerifier({ now: fixture.now });
  const jws = await fixture.sign(preClaimPayload());
  const claims = await verifier.verifyPreClaimAttestation(jws, {
    attestationKeySet: fixture.keySet,
    expected: preClaimExpected() as unknown as PreClaimExpected,
  });
  assert.equal(claims, null);
});

test("verifyPreClaimAttestation rejects mismatched expected fields", async () => {
  const fixture = await makeAttestor(() => 1_799_999_000);
  const verifier = createAttestationVerifier({ now: fixture.now });
  const jws = await fixture.sign(preClaimPayload());
  const claims = await verifier.verifyPreClaimAttestation(jws, {
    attestationKeySet: fixture.keySet,
    expected: preClaimExpected({ turnJtiHash: "b".repeat(64) }) as unknown as PreClaimExpected,
  });
  assert.equal(claims, null);
});

test("verifyPreClaimAttestation rejects an unknown extra field (additionalProperties false)", async () => {
  const fixture = await makeAttestor(() => 1_799_999_000);
  const verifier = createAttestationVerifier({ now: fixture.now });
  const jws = await fixture.sign(preClaimPayload({ smuggled: "field" }));
  const claims = await verifier.verifyPreClaimAttestation(jws, {
    attestationKeySet: fixture.keySet,
    expected: preClaimExpected() as unknown as PreClaimExpected,
  });
  assert.equal(claims, null);
});

test("verifyStartProof accepts a valid start proof and enforces planned-vs-actual equality", async () => {
  const fixture = await makeAttestor(() => 1_799_999_000);
  const verifier = createAttestationVerifier({ now: fixture.now });
  const valid = await fixture.sign(startProofPayload());
  const ok = await verifier.verifyStartProof(valid, {
    attestationKeySet: fixture.keySet,
    expected: startProofExpected() as unknown as StartProofExpected,
  });
  assert.ok(ok);
  assert.equal(ok.sandboxId, "sandbox-1");
  const mismatch = await fixture.sign(startProofPayload({ sandboxId: "sandbox-2" }));
  const denied = await verifier.verifyStartProof(mismatch, {
    attestationKeySet: fixture.keySet,
    expected: startProofExpected() as unknown as StartProofExpected,
  });
  assert.equal(denied, null);
});

test("verifyStartProof rejects an attestation claiming a wrong lease", async () => {
  const fixture = await makeAttestor(() => 1_799_999_000);
  const verifier = createAttestationVerifier({ now: fixture.now });
  const jws = await fixture.sign(startProofPayload());
  const claims = await verifier.verifyStartProof(jws, {
    attestationKeySet: fixture.keySet,
    expected: startProofExpected({ executionLeaseHash: "c".repeat(64) }) as unknown as StartProofExpected,
  });
  assert.equal(claims, null);
});

test("verifyStartProof rejects a start proof that omits the execution lease", async () => {
  const fixture = await makeAttestor(() => 1_799_999_000);
  const verifier = createAttestationVerifier({ now: fixture.now });
  const { executionLeaseHash, ...withoutLease } = startProofPayload();
  const jws = await fixture.sign(withoutLease);
  const claims = await verifier.verifyStartProof(jws, {
    attestationKeySet: fixture.keySet,
    expected: startProofExpected() as unknown as StartProofExpected,
  });
  assert.equal(claims, null);
  void executionLeaseHash;
});

test("verifyPreClaimAttestation rejects an empty endpoint allowlist", async () => {
  const fixture = await makeAttestor(() => 1_799_999_000);
  const verifier = createAttestationVerifier({ now: fixture.now });
  const jws = await fixture.sign(preClaimPayload({ endpointAllowlist: [] }));
  const claims = await verifier.verifyPreClaimAttestation(jws, {
    attestationKeySet: fixture.keySet,
    expected: preClaimExpected() as unknown as PreClaimExpected,
  });
  assert.equal(claims, null);
});

test("verifyPreClaimAttestation rejects a non-URI endpoint allowlist item", async () => {
  const fixture = await makeAttestor(() => 1_799_999_000);
  const verifier = createAttestationVerifier({ now: fixture.now });
  const jws = await fixture.sign(preClaimPayload({ endpointAllowlist: ["not-a-url"] }));
  const claims = await verifier.verifyPreClaimAttestation(jws, {
    attestationKeySet: fixture.keySet,
    expected: preClaimExpected() as unknown as PreClaimExpected,
  });
  assert.equal(claims, null);
});

test("verifyPreClaimAttestation rejects a hostless http URI in the allowlist", async () => {
  const fixture = await makeAttestor(() => 1_799_999_000);
  const verifier = createAttestationVerifier({ now: fixture.now });
  const jws = await fixture.sign(preClaimPayload({ endpointAllowlist: ["http:foo"] }));
  const claims = await verifier.verifyPreClaimAttestation(jws, {
    attestationKeySet: fixture.keySet,
    expected: preClaimExpected() as unknown as PreClaimExpected,
  });
  assert.equal(claims, null);
});

test("verifyStartProof rejects an unknown extra field (additionalProperties false)", async () => {
  const fixture = await makeAttestor(() => 1_799_999_000);
  const verifier = createAttestationVerifier({ now: fixture.now });
  const jws = await fixture.sign(startProofPayload({ smuggled: "field" }));
  const claims = await verifier.verifyStartProof(jws, {
    attestationKeySet: fixture.keySet,
    expected: startProofExpected() as unknown as StartProofExpected,
  });
  assert.equal(claims, null);
});

test("verifyPreClaimAttestation rejects a key that is not yet activated", async () => {
  const fixture = await makeAttestor(() => 1_799_999_000);
  const current = fixture.keySet[0]!;
  fixture.keySet[0] = {
    ...current,
    activatedAt: 1_800_000_000,
  };
  const verifier = createAttestationVerifier({ now: fixture.now });
  const jws = await fixture.sign(preClaimPayload());
  const claims = await verifier.verifyPreClaimAttestation(jws, {
    attestationKeySet: fixture.keySet,
    expected: preClaimExpected() as unknown as PreClaimExpected,
  });
  assert.equal(claims, null);
});

test("verifyPreClaimAttestation rejects a pre-claim carrying an execution lease", async () => {
  const fixture = await makeAttestor(() => 1_799_999_000);
  const verifier = createAttestationVerifier({ now: fixture.now });
  const jws = await fixture.sign(preClaimPayload({ executionLeaseHash: HASH64 }));
  const claims = await verifier.verifyPreClaimAttestation(jws, {
    attestationKeySet: fixture.keySet,
    expected: preClaimExpected() as unknown as PreClaimExpected,
  });
  assert.equal(claims, null);
});

test("verifyPreClaimAttestation rejects an artifact const mismatch", async () => {
  const fixture = await makeAttestor(() => 1_799_999_000);
  const verifier = createAttestationVerifier({ now: fixture.now });
  const jws = await fixture.sign(preClaimPayload({ artifact: "start_proof" }));
  const claims = await verifier.verifyPreClaimAttestation(jws, {
    attestationKeySet: fixture.keySet,
    expected: preClaimExpected() as unknown as PreClaimExpected,
  });
  assert.equal(claims, null);
});

test("verifyStartProof rejects a payload attestorKid that differs from the header kid", async () => {
  const fixture = await makeAttestor(() => 1_799_999_000);
  const verifier = createAttestationVerifier({ now: fixture.now });
  const jws = await fixture.sign(startProofPayload({ attestorKid: "attestor-other" }));
  const claims = await verifier.verifyStartProof(jws, {
    attestationKeySet: fixture.keySet,
    expected: startProofExpected() as unknown as StartProofExpected,
  });
  assert.equal(claims, null);
});

function usageStatementPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    artifact: "usage_statement",
    schemaVersion: 1,
    remoteTurnId: UUID,
    executionLeaseHash: HASH64,
    workloadIdentity: "wli",
    endpoint: "https://api.deepseek.com/v1/chat/completions",
    usage: { inputTokens: 120, outputTokens: 40 },
    costUsd: 0.0012,
    timestamp: 1_799_999_000,
    kid: "attestor-k1",
    ...overrides,
  };
}

test("verifyUsageStatement accepts a valid metering-signed usage statement", async () => {
  const fixture = await makeAttestor(() => 1_799_999_000);
  const verifier = createAttestationVerifier({ now: fixture.now });
  const jws = await fixture.sign(usageStatementPayload());
  const claims = await verifier.verifyUsageStatement(jws, {
    meteringKeySet: fixture.keySet,
    expected: { remoteTurnId: UUID, executionLeaseHash: HASH64 },
  });
  assert.ok(claims);
  assert.equal(claims.artifact, "usage_statement");
  assert.equal(claims.usage.inputTokens, 120);
  assert.equal(claims.usage.outputTokens, 40);
  assert.equal(claims.endpoint, "https://api.deepseek.com/v1/chat/completions");
});

test("verifyUsageStatement rejects a tampered signature", async () => {
  const fixture = await makeAttestor(() => 1_799_999_000);
  const verifier = createAttestationVerifier({ now: fixture.now });
  const jws = await fixture.sign(usageStatementPayload());
  const forged = `${jws.slice(0, -4)}AAAA`;
  const claims = await verifier.verifyUsageStatement(forged, {
    meteringKeySet: fixture.keySet,
    expected: { remoteTurnId: UUID, executionLeaseHash: HASH64 },
  });
  assert.equal(claims, null);
});

test("verifyUsageStatement rejects a statement bound to a different lease", async () => {
  const fixture = await makeAttestor(() => 1_799_999_000);
  const verifier = createAttestationVerifier({ now: fixture.now });
  const jws = await fixture.sign(usageStatementPayload());
  const claims = await verifier.verifyUsageStatement(jws, {
    meteringKeySet: fixture.keySet,
    expected: { remoteTurnId: UUID, executionLeaseHash: "f".repeat(64) },
  });
  assert.equal(claims, null);
});

test("verifyUsageStatement rejects wrong-lease turn id", async () => {
  const fixture = await makeAttestor(() => 1_799_999_000);
  const verifier = createAttestationVerifier({ now: fixture.now });
  const jws = await fixture.sign(usageStatementPayload());
  const claims = await verifier.verifyUsageStatement(jws, {
    meteringKeySet: fixture.keySet,
    expected: { remoteTurnId: "00000000-0000-4000-8000-000000000000", executionLeaseHash: HASH64 },
  });
  assert.equal(claims, null);
});

test("verifyUsageStatement rejects a metering key outside the pinned set", async () => {
  const fixture = await makeAttestor(() => 1_799_999_000);
  const other = await makeAttestor(() => 1_799_999_000);
  const verifier = createAttestationVerifier({ now: fixture.now });
  const jws = await other.sign(usageStatementPayload());
  const claims = await verifier.verifyUsageStatement(jws, {
    meteringKeySet: fixture.keySet,
    expected: { remoteTurnId: UUID, executionLeaseHash: HASH64 },
  });
  assert.equal(claims, null);
});

test("verifyUsageStatement rejects unknown fields, negative tokens, and malformed uri", async () => {
  const fixture = await makeAttestor(() => 1_799_999_000);
  const verifier = createAttestationVerifier({ now: fixture.now });
  for (const bad of [
    usageStatementPayload({ extraField: true }),
    usageStatementPayload({ usage: { inputTokens: -1, outputTokens: 0 } }),
    usageStatementPayload({ usage: { inputTokens: 0 } }),
    usageStatementPayload({ endpoint: "not-a-uri" }),
    usageStatementPayload({ costUsd: -0.01 }),
    usageStatementPayload({ artifact: "receipt" }),
    usageStatementPayload({ schemaVersion: 0 }),
    usageStatementPayload({ kid: "some-other-kid" }),
  ]) {
    const jws = await fixture.sign(bad);
    const claims = await verifier.verifyUsageStatement(jws, {
      meteringKeySet: fixture.keySet,
      expected: { remoteTurnId: UUID, executionLeaseHash: HASH64 },
    });
    assert.equal(claims, null, `expected rejection for ${JSON.stringify(bad).slice(0, 80)}`);
  }
});
