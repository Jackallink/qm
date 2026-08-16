import { test } from "node:test";
import assert from "node:assert/strict";
import { createRemoteTurnTransport } from "../src/remote-turn/transport.ts";
import type { DispatchPayload } from "../src/remote-turn/store.ts";

function payload(): DispatchPayload {
  return {
    remoteTurnId: "11111111-1111-4111-8111-111111111111",
    bindingId: "binding-1",
    bindingVersion: 1,
    conversationKey: "conv-1",
    scopeId: "scope-1",
    qmSessionId: "22222222-2222-4222-8222-222222222222",
    coreRunId: "33333333-3333-4333-8333-333333333333",
    inputDigest: "a".repeat(64),
    historyDigest: "b".repeat(64),
    envelopeDigest: "c".repeat(64),
    turnJti: "jti-1234567890abcdef",
    attestationNonce: "nonce-1234567890abcdef",
    releaseDigest: "d".repeat(64),
    turnToken: "eyJ.abc.def",
    text: "hello",
    history: [],
  };
}

test("resolveService returns the base URL for a registered service", () => {
  const t = createRemoteTurnTransport({ transports: { "svc-1": "https://runtime.example.com" } });
  assert.equal(t.resolveService("svc-1"), "https://runtime.example.com");
  assert.equal(t.resolveService("svc-unknown"), null);
});

test("sendTurn posts the envelope and turn token to /turn", async () => {
  const seen: Array<{ url: string; body: Record<string, unknown> }> = [];
  const t = createRemoteTurnTransport({
    transports: { "svc-1": "https://runtime.example.com" },
    fetchImpl: (async (url: string, init?: RequestInit) => {
      seen.push({ url, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return new Response(null, { status: 202 });
    }) as typeof fetch,
  });
  const result = await t.sendTurn(payload(), "svc-1", "https://runtime.example.com");
  assert.deepEqual(result, { ok: true });
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.url, "https://runtime.example.com/turn");
  assert.equal(seen[0]!.body["remoteTurnId"], payload().remoteTurnId);
  assert.equal(seen[0]!.body["turnToken"], "eyJ.abc.def");
  assert.equal(seen[0]!.body["attestationNonce"], "nonce-1234567890abcdef");
});

test("sendTurn fails on non-2xx and on network errors", async () => {
  const failing = createRemoteTurnTransport({
    transports: { "svc-1": "https://runtime.example.com" },
    fetchImpl: (async () => new Response(null, { status: 500 })) as typeof fetch,
  });
  assert.deepEqual(await failing.sendTurn(payload(), "svc-1", "https://runtime.example.com"), {
    ok: false,
    reason: "delivery_failed",
  });

  const throwing = createRemoteTurnTransport({
    transports: { "svc-1": "https://runtime.example.com" },
    fetchImpl: (async () => {
      throw new Error("connection refused");
    }) as typeof fetch,
  });
  assert.deepEqual(await throwing.sendTurn(payload(), "svc-1", "https://runtime.example.com"), {
    ok: false,
    reason: "delivery_failed",
  });
});
