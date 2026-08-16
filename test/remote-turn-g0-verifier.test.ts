import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { createG0Verifier, exportG0PublicKey, mintGovernanceContext, type G0ContextClaims } from "../src/remote-turn/g0-verifier.ts";

function claims(overrides: Partial<G0ContextClaims> = {}): G0ContextClaims {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    actorId: "actor-1",
    scopeId: "scope-1",
    conversationKey: "conv-1",
    governanceDecisionId: "decision-1",
    governanceAuthorizationDigest: "g".repeat(64),
    traceId: "trace-1",
    exp: nowSec + 300,
    nbf: nowSec - 10,
    aud: "urn:qm:core",
    ...overrides,
  };
}

test("G0 context verifies with the configured governance key", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pem = await exportG0PublicKey(publicKey);
  const verifier = createG0Verifier({ publicKeyPems: { "gov-k1": pem } });
  const jws = await mintGovernanceContext(claims(), privateKey, "gov-k1");
  const verified = await verifier.verifyContext(jws, { audience: "urn:qm:core", nowMs: Date.now() });
  assert.ok(verified);
  assert.equal(verified!.actorId, "actor-1");
  assert.equal(verified!.governanceDecisionId, "decision-1");
});

test("G0 context rejects unknown kid, wrong audience, expiry, and tampering", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pem = await exportG0PublicKey(publicKey);
  const verifier = createG0Verifier({ publicKeyPems: { "gov-k1": pem } });
  const nowSec = Math.floor(Date.now() / 1000);

  const unknownKid = await mintGovernanceContext(claims(), privateKey, "other-kid");
  assert.equal(await verifier.verifyContext(unknownKid, { audience: "urn:qm:core", nowMs: Date.now() }), null);

  const wrongAud = await mintGovernanceContext(claims({ aud: "urn:qm:elsewhere" }), privateKey, "gov-k1");
  assert.equal(await verifier.verifyContext(wrongAud, { audience: "urn:qm:core", nowMs: Date.now() }), null);

  const expired = await mintGovernanceContext(claims({ exp: nowSec - 10 }), privateKey, "gov-k1");
  assert.equal(await verifier.verifyContext(expired, { audience: "urn:qm:core", nowMs: Date.now() }), null);

  const future = await mintGovernanceContext(claims({ nbf: nowSec + 120 }), privateKey, "gov-k1");
  assert.equal(await verifier.verifyContext(future, { audience: "urn:qm:core", nowMs: Date.now() }), null);

  const valid = await mintGovernanceContext(claims(), privateKey, "gov-k1");
  const tampered = `${valid.slice(0, -4)}AAAA`;
  assert.equal(await verifier.verifyContext(tampered, { audience: "urn:qm:core", nowMs: Date.now() }), null);
});

test("G0 context rejects unknown fields and missing required fields", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pem = await exportG0PublicKey(publicKey);
  const verifier = createG0Verifier({ publicKeyPems: { "gov-k1": pem } });
  const nowSec = Math.floor(Date.now() / 1000);

  const extra = await mintGovernanceContext(
    { ...claims(), extraField: "x" } as unknown as G0ContextClaims,
    privateKey,
    "gov-k1",
  );
  assert.equal(await verifier.verifyContext(extra, { audience: "urn:qm:core", nowMs: Date.now() }), null);

  const missing = await mintGovernanceContext(
    { ...claims(), governanceDecisionId: "" } as unknown as G0ContextClaims,
    privateKey,
    "gov-k1",
  );
  assert.equal(await verifier.verifyContext(missing, { audience: "urn:qm:core", nowMs: Date.now() }), null);

  void nowSec;
});
