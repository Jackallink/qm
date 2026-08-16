import { test, before } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { CompactSign, exportSPKI, importPKCS8 } from "jose";
import type { AddressInfo } from "node:net";
import { createInsecureTestServer } from "../src/api/server.ts";
import { createRemoteTurnStore, type AdmitInput, type G0Context, type DispatchEnvelope } from "../src/remote-turn/store.ts";
import { createRemoteBindingStore, type CreateBindingInput, type KeySetEntry } from "../src/remote-turn/binding-store.ts";
import { createAttestationVerifier } from "../src/remote-turn/attestation.ts";
import { createTransportAuth } from "../src/remote-turn/transport-auth.ts";
import { verifyTurnToken, sha256Hex } from "../src/remote-turn/tokens.ts";
import { computeEnvelopeDigest, computeHistoryDigest, computeInputDigest } from "../src/remote-turn/envelope.ts";
import { deriveWindowAnchorMs } from "../src/remote-turn/budget-ledger.ts";
import { signedRequestHeaders } from "../src/auth/source-auth-sign.ts";
import { createApp } from "../src/api/app.ts";

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "set DATABASE_URL (a Postgres) to run the remote-turn claim route tests";

const encoder = new TextEncoder();

interface KeyFixture {
  kid: string;
  privateKeyPem: string;
  keySet: KeySetEntry[];
  sign: (payload: Record<string, unknown>, useKid?: string) => Promise<string>;
}

async function makeEdKeys(kid: string): Promise<KeyFixture> {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicKeyPem = await exportSPKI(publicKey);
  return {
    kid,
    privateKeyPem,
    keySet: [{ kid, publicKeyPem, state: "current", activatedAt: Date.now() - 1000, retiresAt: Date.now() + 100_000 }],
    sign: async (payload, useKid = kid) =>
      new CompactSign(encoder.encode(JSON.stringify(payload))).setProtectedHeader({ alg: "EdDSA", kid: useKid }).sign(privateKey),
  };
}

const SESSION_URL = URL;

let coreKeys: KeyFixture;
let attestorKeys: KeyFixture;

before(async () => {
  if (!URL) return;
  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: URL });
  await p.query(
    "DROP TABLE IF EXISTS remote_turn_events, remote_turn, remote_runtime_binding, budget_reservations, budget_balances, session_leases, sessions, runs CASCADE",
  );
  await p.end();
  coreKeys = await makeEdKeys("core-k1");
  attestorKeys = await makeEdKeys("attestor-k1");
});

function bindingInput(overrides: Partial<CreateBindingInput> = {}): CreateBindingInput {
  return {
    bindingId: `binding-${randomUUID()}`,
    configuredOrgId: "org-acme",
    allowedScopeId: `scope-${randomUUID()}`,
    protocolVersion: 1,
    runtimeAudience: "urn:qm:v1:runtime:org-acme:test",
    transportServiceId: "svc-test",
    transportCertificatePin: "pin-test-abc",
    transportSourceAuthKeyId: "source-auth-key-1",
    releaseDigest: "a".repeat(64),
    releaseAttestationKeyId: "attestor-1",
    receiptKeySetVersion: 1,
    meteringKeySetVersion: 1,
    maxInputBytes: 32_768,
    maxHistoryMessages: 8,
    maxOutputBytes: 16_384,
    maxRuntimeMs: 60_000,
    tokenTtlMs: 90_000,
    budgetCeilingUsd: 100,
    policySnapshotHash: "p".repeat(64),
    networkPolicyId: "net-pol-1",
    endpointAllowlist: ["https://api.deepseek.com"],
    egressAudience: "urn:qm:egress:1",
    createdBy: "test",
    coreVerificationKeys: coreKeys.keySet,
    attestorKeys: attestorKeys.keySet,
    receiptKeys: [],
    meteringKeys: [],
    ...overrides,
  };
}

function g0(scopeId: string, conversationKey: string): G0Context {
  return {
    actorId: "actor-1",
    scopeId,
    conversationKey,
    governanceDecisionId: `decision-${randomUUID()}`,
    governanceAuthorizationDigest: "g".repeat(64),
    traceId: `trace-${randomUUID()}`,
  };
}

function admitInput(bindingId: string, scopeId: string, conversationKey: string): AdmitInput {
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

async function dispatchingTurn(store: ReturnType<typeof createRemoteTurnStore>, bindingId: string, scopeId: string) {
  const conversationKey = `conv-${randomUUID()}`;
  const input = admitInput(bindingId, scopeId, conversationKey);
  const admitted = await store.admit(input);
  assert.equal(admitted.status, "admitted");
  if (admitted.status !== "admitted") throw new Error("admit refused");
  const turnJti = randomUUID();
  const attestationNonce = randomUUID();
  const dispatch = await store.prepareDispatch({
    remoteTurnId: admitted.remoteTurnId,
    leaseToken: admitted.runLeaseToken,
    envelope: { turnJti, attestationNonce } as DispatchEnvelope,
  });
  assert.equal(dispatch.ok, true);
  return { turn: admitted, turnJti, attestationNonce, input };
}

test("claim endpoint: valid turn + pre-claim attestation yields a claimed turn and pushes the lease", { skip }, async () => {
  const bindings = createRemoteBindingStore(URL!);
  const binding = await bindings.createBinding(bindingInput());
  const store = createRemoteTurnStore(URL!, { abortKey: coreKeys });
  try {
    const { turn, turnJti, attestationNonce, input } = await dispatchingTurn(store, binding.bindingId, binding.allowedScopeId);
    const nowSec = Math.floor(Date.now() / 1000);
    const qmSessionId = randomUUID();
    const inputDigest = computeInputDigest("hello remote");
    const historyDigest = computeHistoryDigest([]);
    const envelopeDigest = computeEnvelopeDigest({
      remoteTurnId: turn.remoteTurnId,
      bindingVersion: binding.version,
      conversationKey: input.conversationKey,
      scopeId: binding.allowedScopeId,
      qmSessionId,
      coreRunId: input.coreRunId,
      inputDigest,
      historyDigest,
    });

    const expectation = await store.getPreClaimExpectation(turn.remoteTurnId);
    assert.ok(expectation, "expectation must exist");
    const turnToken = await coreKeys.sign(
      {
        kid: "core-k1",
        iss: "urn:qm:core",
        aud: binding.runtimeAudience,
        iat: nowSec,
        nbf: nowSec,
        exp: nowSec + 300,
        jti: turnJti,
        capability: "turn",
        remoteTurnId: turn.remoteTurnId,
        bindingVersion: binding.version,
        conversationKey: input.conversationKey,
        scopeId: binding.allowedScopeId,
        qmSessionId,
        coreRunId: input.coreRunId,
        inputDigest,
        envelopeDigest,
        protocolVersion: 1,
      },
      "core-k1",
    );

    const preClaim = await attestorKeys.sign({
      artifact: "pre_claim_attestation",
      schemaVersion: 1,
      remoteTurnId: turn.remoteTurnId,
      bindingVersion: binding.version,
      turnJtiHash: sha256Hex(turnJti),
      attestationNonceHash: sha256Hex(attestationNonce),
      intendedWorkloadIdentity: `wl-${turn.remoteTurnId}`,
      plannedSandboxId: "sandbox-1",
      releaseDigest: binding.releaseDigest,
      isolationMode: "container",
      policyDigest: sha256Hex([binding.policySnapshotHash, binding.networkPolicyId, JSON.stringify(binding.endpointAllowlist), binding.egressAudience].join("|")),
      networkPolicyId: binding.networkPolicyId,
      endpointAllowlist: binding.endpointAllowlist,
      egressAudience: binding.egressAudience,
      expiry: expectation!.expiry,
      singleUse: true,
    });

    const leasePushCalls: Array<{ executionLease: string; executionLeaseHash: string }> = [];
    const deps = {
      remoteTurnStore: store,
      remoteTurnBindingStore: bindings,
      remoteTurnTransportAuth: createTransportAuth({ keys: { "source-auth-key-1": "test-source-secret" } }),
      remoteTurnAttestationVerifier: createAttestationVerifier(),
      remoteTurnTurnVerifier: { verifyTurnToken },
      remoteTurnAttestorClient: {
        async pushLease(input: { executionLease: string; executionLeaseHash: string }) {
          leasePushCalls.push(input);
          return { ok: true as const };
        },
      },
    };
    const app = {} as never;
    const server = createInsecureTestServer(app, deps as never);
    server.listen(0);
    const base = `http://localhost:${(server.address() as AddressInfo).port}`;
    try {
      const body = JSON.stringify({
        bindingId: binding.bindingId,
        remoteTurnId: turn.remoteTurnId,
        turnToken,
        attestationNonce,
        preClaimAttestation: preClaim,
        envelopeDigest,
      });
      const headers = signedRequestHeaders("test-source-secret", "POST", "/v1/remote-turn/claim", body, {
        "content-type": "application/json",
        "x-client-cert-fingerprint": "pin-test-abc",
      });
      const res = await fetch(`${base}/v1/remote-turn/claim`, { method: "POST", headers, body });
      const text = await res.text();
      assert.equal(res.status, 200, text);
      const parsed = JSON.parse(text) as { status: string; executionLeaseHash: string; abortToken: string };
      assert.equal(parsed.status, "claimed");
      assert.equal(parsed.executionLeaseHash, sha256Hex(leasePushCalls[0]!.executionLease));
      assert.ok(parsed.abortToken.length > 0);
      assert.equal(leasePushCalls.length, 1);
    } finally {
      server.close();
    }
  } finally {
    await store.close?.();
    await bindings.close();
  }
});
