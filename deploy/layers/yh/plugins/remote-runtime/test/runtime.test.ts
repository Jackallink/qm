import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { exportKeyToPem, signArtifact, type KeySetEntry } from "../../shared/src/protocol.ts";
import { handleTurn, type AttestorClient, type CoreClient, type ExecutorClient, type RuntimeConfig, type TurnEnvelope } from "../src/index.ts";

const UUID = "11111111-1111-4111-8111-111111111111";
const UUID2 = "22222222-2222-4222-8222-222222222222";
const UUID3 = "33333333-3333-4333-8333-333333333333";
const HASH = "a".repeat(64);

function keys(kid = "k1"): { privateKeyPem: string; keySet: KeySetEntry[]; now: number } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const now = Date.now();
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    keySet: [{ kid, publicKeyPem: exportKeyToPem(publicKey), state: "current", activatedAt: now - 1000, retiresAt: now + 100_000 }],
    now,
  };
}

function envelope(overrides: Partial<TurnEnvelope> = {}): TurnEnvelope {
  return {
    remoteTurnId: UUID,
    bindingVersion: 1,
    conversationKey: "ck",
    scopeId: "s1",
    qmSessionId: UUID2,
    coreRunId: UUID3,
    inputDigest: HASH,
    historyDigest: HASH,
    envelopeDigest: HASH,
    releaseDigest: HASH,
    turnToken: "t",
    attestationNonce: "nonce-1234567890abcdef",
    text: "hello",
    history: [],
    ...overrides,
  };
}

function config(now: () => number, coreKeySet?: KeySetEntry[]): RuntimeConfig {
  const core = coreKeySet ? { keySet: coreKeySet } : keys();
  const receipt = keys("receipt-k1");
  return {
    bindingId: "binding-1",
    runtimeAudience: "urn:qm:v1:runtime:test",
    coreVerificationKeys: core.keySet,
    receiptKeys: receipt.keySet,
    receiptKey: { kid: "receipt-k1", privateKeyPem: receipt.privateKeyPem },
    coreBaseUrl: "http://core.test",
    coreSourceAuthKeyId: "sa-1",
    coreSourceAuthSecret: "secret",
    clientCertFingerprint: "pin-1",
    executorBaseUrl: "http://executor.test",
    attestorBaseUrl: "http://attestor.test",
    now,
  };
}

test("handleTurn verifies the turn token and completes the executor exchange with a signed receipt", async () => {
  const signer = keys();
  const cfg = config(() => Date.now(), signer.keySet);
  const nowSec = Math.floor(Date.now() / 1000);
  const turnToken = await signArtifact(
    {
      kid: "k1", iss: "urn:qm:core", aud: cfg.runtimeAudience, iat: nowSec, nbf: nowSec, exp: nowSec + 90,
      jti: "jti-1234567890abcdef", capability: "turn", remoteTurnId: UUID, bindingVersion: 1,
      conversationKey: "ck", scopeId: "s1", qmSessionId: UUID2, coreRunId: UUID3,
      inputDigest: HASH, envelopeDigest: HASH, protocolVersion: 1,
    },
    { kid: "k1", privateKeyPem: signer.privateKeyPem },
  );
  const env = envelope({ turnToken });
  const attestor: AttestorClient = {
    requestPreClaim: async () => ({ ok: true, preClaimAttestation: "preclaim.jws" }),
    signalTerminate: async () => true,
  };
  const core: CoreClient = {
    claim: async () => ({ ok: true, executionLeaseHash: HASH, abortToken: "abort" }),
    postReceipt: async () => ({ ok: true }),
  };
  const executor: ExecutorClient = {
    runTurn: async (input) => ({ ok: true, reply: `echo:${input.text}`, runtimeMs: 10, outputBytes: 10 }),
  };
  const out = await handleTurn({ core, executor, attestor, config: cfg }, env as unknown as Record<string, unknown>);
  assert.equal(out.status, 200);
  assert.deepEqual(out.body, { status: "accepted" });
});

test("handleTurn rejects a forged turn token before any claim", async () => {
  const cfg = config(() => Date.now());
  let claimed = false;
  const core: CoreClient = {
    claim: async () => { claimed = true; return { ok: false, reason: "should not be reached", status: 500 }; },
    postReceipt: async () => ({ ok: true }),
  };
  const out = await handleTurn(
    { core, executor: { runTurn: async () => ({ ok: true, reply: "x", runtimeMs: 1, outputBytes: 1 }) }, attestor: { requestPreClaim: async () => ({ ok: true, preClaimAttestation: "p" }), signalTerminate: async () => true }, config: cfg },
    envelope({ turnToken: "forged.token.value" }) as unknown as Record<string, unknown>,
  );
  assert.equal(out.status, 401);
  assert.equal(claimed, false);
});

test("handleTurn refuses an envelope missing the token or with bad shape", async () => {
  const cfg = config(() => Date.now());
  const out = await handleTurn(
    { core: {} as CoreClient, executor: {} as ExecutorClient, attestor: {} as AttestorClient, config: cfg },
    { remoteTurnId: "x" },
  );
  assert.equal(out.status, 400);
});
