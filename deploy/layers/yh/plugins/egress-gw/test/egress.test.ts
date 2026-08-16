import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { verifyArtifact, type KeySetEntry } from "../../shared/src/protocol.ts";
import { createEgressGateway, createMemoryEgressTokenStore } from "../src/index.ts";

const HASH = "a".repeat(64);
const ALLOWED = "https://api.deepseek.com";

function gateway() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const now = () => 1_800_000_000_000;
  const keySetWith = (): KeySetEntry[] => [
    { kid: "metering-k1", publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(), state: "current", activatedAt: now() - 1000, retiresAt: now() + 100_000 },
  ];
  const keySet: KeySetEntry[] = keySetWith();
  const gw = createEgressGateway({
    meteringKey: { kid: "metering-k1", privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString() },
    store: createMemoryEgressTokenStore(),
    now,
    tokenTtlMs: 120_000,
  });
  return { gw, keySet, now };
}

test("mint → authorize (allowed) → usage → statement signs a verifiable artifact", async () => {
  const { gw, keySet, now } = gateway();
  const minted = await gw.mintToken({
    executionLeaseHash: HASH,
    workloadIdentity: "11111111-1111-4111-8111-111111111111",
    endpointAllowlist: [ALLOWED],
    expiryMs: now() + 120_000,
  });
  assert.equal(minted.ok, true);
  if (!minted.ok) return;

  const allowed = await gw.authorize({ token: minted.token, url: `${ALLOWED}/v1/chat/completions` });
  assert.equal(allowed.ok, true, "the allowlisted endpoint is authorized");

  const denied = await gw.authorize({ token: minted.token, url: "https://evil.example.com/steal" });
  assert.equal(denied.ok, false, "a non-allowlisted endpoint is refused");

  await gw.recordUsage({ token: minted.token, url: `${ALLOWED}/v1/chat/completions`, usage: { inputTokens: 100, outputTokens: 50, costUsd: 0.01 } });
  const statement = await gw.usageStatement({ executionLeaseHash: HASH });
  assert.equal(statement.ok, true);
  if (!statement.ok) return;
  const verified = await verifyArtifact(statement.statement, keySet, now() + 1000);
  assert.ok(verified);
  assert.equal(verified!.artifact, "usage_statement");
  assert.equal((verified!.usage as { inputTokens: number }).inputTokens, 100);
  assert.equal(verified!.executionLeaseHash, HASH);
});

test("revoked or expired tokens are refused", async () => {
  const { gw, now } = gateway();
  const minted = await gw.mintToken({
    executionLeaseHash: HASH,
    workloadIdentity: "w",
    endpointAllowlist: [ALLOWED],
    expiryMs: now() + 120_000,
  });
  if (!minted.ok) return;
  const revoked = await gw.revokeToken(minted.tokenId);
  assert.equal(revoked.ok, true);
  assert.equal((await gw.authorize({ token: minted.token, url: `${ALLOWED}/x` })).ok, false);

  const short = await gw.mintToken({
    executionLeaseHash: "b".repeat(64),
    workloadIdentity: "w2",
    endpointAllowlist: [ALLOWED],
    expiryMs: now() - 1,
  });
  if (!short.ok) return;
  assert.equal((await gw.authorize({ token: short.token, url: `${ALLOWED}/x` })).ok, false, "an expired token is refused");
});

test("usage statement is refused without recorded usage", async () => {
  const { gw } = gateway();
  const minted = await gw.mintToken({
    executionLeaseHash: HASH,
    workloadIdentity: "w",
    endpointAllowlist: [ALLOWED],
    expiryMs: Date.now() + 120_000,
  });
  if (!minted.ok) return;
  const statement = await gw.usageStatement({ executionLeaseHash: HASH });
  assert.equal(statement.ok, false, "no usage recorded ⇒ no statement (full charge)");
});
