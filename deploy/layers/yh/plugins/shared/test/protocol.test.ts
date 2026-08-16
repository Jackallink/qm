import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import {
  computeEnvelopeDigest,
  exportKeyToPem,
  sha256Hex,
  signArtifact,
  signReceipt,
  verifyAbortToken,
  verifyArtifact,
  verifyReceipt,
  verifyTurnToken,
  type KeySetEntry,
  type ReceiptClaims,
} from "../src/protocol.ts";

const UUID = "11111111-1111-4111-8111-111111111111";
const UUID2 = "22222222-2222-4222-8222-222222222222";
const UUID3 = "33333333-3333-4333-8333-333333333333";
const HASH = "a".repeat(64);

function keySet(kid = "k1"): { privateKeyPem: string; keySet: KeySetEntry[]; now: number } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const now = Date.now();
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    keySet: [{ kid, publicKeyPem: exportKeyToPem(publicKey), state: "current", activatedAt: now - 1000, retiresAt: now + 100_000 }],
    now,
  };
}

test("computeEnvelopeDigest matches the 05 length-prefixed framing", () => {
  const d = computeEnvelopeDigest({
    remoteTurnId: UUID,
    bindingVersion: 1,
    conversationKey: "ck",
    scopeId: "s1",
    qmSessionId: UUID2,
    coreRunId: UUID3,
    inputDigest: HASH,
    historyDigest: HASH,
  });
  assert.match(d, /^[a-f0-9]{64}$/);
  const expected = sha256Hex(
    [UUID, "1", "ck", "s1", UUID2, UUID3, HASH, HASH]
      .map((f) => {
        const b = Buffer.from(f, "utf8");
        const h = Buffer.alloc(4);
        h.writeUInt32BE(b.length);
        return Buffer.concat([h, b]);
      })
      .reduce((acc, b) => Buffer.concat([acc, b]), Buffer.alloc(0))
      .toString("latin1"),
  );
  assert.equal(d, expected);
});

test("verifyTurnToken accepts a valid core-signed turn token", async () => {
  const { privateKeyPem: pem, keySet: ks, now } = keySet();
  const nowSec = Math.floor(now / 1000);
  const jws = await signArtifact(
    {
      kid: "k1", iss: "urn:qm:core", aud: "urn:qm:v1:runtime:test", iat: nowSec, nbf: nowSec, exp: nowSec + 90,
      jti: "jti-1234567890abcdef", capability: "turn", remoteTurnId: UUID, bindingVersion: 1,
      conversationKey: "ck", scopeId: "s1", qmSessionId: UUID2, coreRunId: UUID3,
      inputDigest: HASH, envelopeDigest: HASH, protocolVersion: 1,
    },
    { kid: "k1", privateKeyPem: pem },
  );
  const verified = await verifyTurnToken(jws, ks, {
    aud: "urn:qm:v1:runtime:test", remoteTurnId: UUID, envelopeDigest: HASH, nowMs: now,
  });
  assert.ok(verified);
  assert.equal(verified!.jti, "jti-1234567890abcdef");
});

test("verifyTurnToken rejects a wrong audience and expiry", async () => {
  const { privateKeyPem: pem, keySet: ks, now } = keySet();
  const nowSec = Math.floor(now / 1000);
  const jws = await signArtifact(
    {
      kid: "k1", iss: "urn:qm:core", aud: "urn:qm:v1:runtime:test", iat: nowSec, nbf: nowSec, exp: nowSec + 90,
      jti: "jti-1234567890abcdef", capability: "turn", remoteTurnId: UUID, bindingVersion: 1,
      conversationKey: "ck", scopeId: "s1", qmSessionId: UUID2, coreRunId: UUID3,
      inputDigest: HASH, envelopeDigest: HASH, protocolVersion: 1,
    },
    { kid: "k1", privateKeyPem: pem },
  );
  assert.equal(await verifyTurnToken(jws, ks, { aud: "wrong", remoteTurnId: UUID, envelopeDigest: HASH, nowMs: now }), null);
  assert.equal(await verifyTurnToken(jws, ks, { aud: "urn:qm:v1:runtime:test", remoteTurnId: UUID, envelopeDigest: HASH, nowMs: now + 100_000 }), null);
});

test("verifyAbortToken binds the lease in post-claim phase", async () => {
  const { privateKeyPem: pem, keySet: ks, now } = keySet();
  const nowSec = Math.floor(now / 1000);
  const jws = await signArtifact(
    {
      kid: "k1", iss: "urn:qm:core", aud: "urn:qm:v1:runtime:test", iat: nowSec, nbf: nowSec, exp: nowSec + 90,
      jti: "jti-1234567890abcdef", capability: "abort", remoteTurnId: UUID, bindingVersion: 1,
      turnJtiHash: HASH, protocolVersion: 1, executionLeaseHash: "b".repeat(64), coreRunId: UUID3,
    },
    { kid: "k1", privateKeyPem: pem },
  );
  const ok = await verifyAbortToken(jws, ks, {
    aud: "urn:qm:v1:runtime:test", remoteTurnId: UUID, turnJtiHash: HASH, nowMs: now,
    phase: "post_claim", executionLeaseHash: "b".repeat(64), coreRunId: UUID3,
  });
  assert.ok(ok);
  const wrongLease = await verifyAbortToken(jws, ks, {
    aud: "urn:qm:v1:runtime:test", remoteTurnId: UUID, turnJtiHash: HASH, nowMs: now,
    phase: "post_claim", executionLeaseHash: "c".repeat(64), coreRunId: UUID3,
  });
  assert.equal(wrongLease, null);
});

test("receipt sign/verify round-trips with the byte bound enforced", async () => {
  const { privateKeyPem: pem, keySet: ks, now } = keySet();
  const claims: Omit<ReceiptClaims, "kid"> = {
    artifact: "receipt", schemaVersion: 1, remoteTurnId: UUID, bindingVersion: 1,
    executionLeaseHash: HASH, inputDigest: HASH, releaseDigest: HASH, status: "completed",
    reply: "hello", outputBytes: 5, runtimeMs: 100, receivedAt: now,
  };
  const jws = await signReceipt(claims, { kid: "k1", privateKeyPem: pem });
  const verified = await verifyReceipt(jws, ks, {
    remoteTurnId: UUID, bindingVersion: 1, executionLeaseHash: HASH, inputDigest: HASH, releaseDigest: HASH, nowMs: now,
  });
  assert.ok(verified);
  assert.equal(verified!.reply, "hello");

  const oversize = await signReceipt({ ...claims, reply: "x".repeat(17_000) }, { kid: "k1", privateKeyPem: pem });
  assert.equal(await verifyReceipt(oversize, ks, {
    remoteTurnId: UUID, bindingVersion: 1, executionLeaseHash: HASH, inputDigest: HASH, releaseDigest: HASH, nowMs: now,
  }), null);
});

test("verifyArtifact rejects a key outside the pinned set", async () => {
  const { privateKeyPem: pem, keySet: ks, now } = keySet();
  const other = keySet("other");
  const jws = await signArtifact({ artifact: "x", schemaVersion: 1 }, { kid: "other", privateKeyPem: other.privateKeyPem });
  assert.equal(await verifyArtifact(jws, ks, now), null);
  const own = await signArtifact({ artifact: "x", schemaVersion: 1 }, { kid: "k1", privateKeyPem: pem });
  assert.ok(await verifyArtifact(own, ks, now));
});
