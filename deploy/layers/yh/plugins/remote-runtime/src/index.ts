import { createServer } from "node:http";
import { verifyTurnToken, verifyAbortToken, signReceipt, sha256Hex } from "../../shared/src/protocol.ts";
import type { KeySetEntry } from "../../shared/src/protocol.ts";

export interface RuntimeConfig {
  bindingId: string;
  runtimeAudience: string;
  coreVerificationKeys: KeySetEntry[];
  receiptKeys: KeySetEntry[];
  receiptKey: { kid: string; privateKeyPem: string };
  coreBaseUrl: string;
  coreSourceAuthKeyId: string;
  coreSourceAuthSecret: string;
  clientCertFingerprint: string;
  executorBaseUrl: string;
  attestorBaseUrl: string;
  bindingVersion: number;
  now?: () => number;
}

export interface TurnEnvelope {
  remoteTurnId: string;
  bindingVersion: number;
  conversationKey: string;
  scopeId: string;
  qmSessionId: string;
  coreRunId: string;
  inputDigest: string;
  historyDigest: string;
  envelopeDigest: string;
  releaseDigest: string;
  turnToken: string;
  attestationNonce: string;
  text: string;
  history: Array<{ role: string; text: string }>;
}

const ENVELOPE_FIELDS = new Set([
  "remoteTurnId", "bindingVersion", "conversationKey", "scopeId", "qmSessionId",
  "coreRunId", "inputDigest", "historyDigest", "envelopeDigest", "releaseDigest",
  "turnToken", "attestationNonce", "text", "history",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isEnvelope(value: unknown): value is TurnEnvelope {
  if (!isRecord(value)) return false;
  for (const key of Object.keys(value)) {
    if (!ENVELOPE_FIELDS.has(key)) return false;
  }
  for (const key of ENVELOPE_FIELDS) {
    if (key === "history") {
      if (!Array.isArray(value[key])) return false;
    } else if (key === "bindingVersion") {
      if (typeof value[key] !== "number" || value[key] < 1) return false;
    } else if (!isString(value[key])) {
      return false;
    }
  }
  return true;
}

function canonicalPayload(method: string, pathWithQuery: string, body: string): string {
  return `${method}\n${pathWithQuery}\n${body}`;
}

import { createHmac } from "node:crypto";

function signRequest(secret: string, timestampSec: number, canonical: string): string {
  return `v0=${createHmac("sha256", secret).update(`v0:${timestampSec}:${canonical}`).digest("hex")}`;
}

export interface CoreClient {
  claim(input: {
    bindingId: string;
    remoteTurnId: string;
    turnToken: string;
    attestationNonce: string;
    preClaimAttestation: string;
    envelopeDigest: string;
  }): Promise<{ ok: true; executionLeaseHash: string; abortToken: string } | { ok: false; reason: string; status: number }>;
  postReceipt(input: { bindingId: string; remoteTurnId: string; receipt: string }): Promise<{ ok: true } | { ok: false; reason: string }>;
}

export function createCoreClient(opts: {
  coreBaseUrl: string;
  coreSourceAuthKeyId: string;
  coreSourceAuthSecret: string;
  clientCertFingerprint: string;
  fetchImpl?: typeof fetch;
}): CoreClient {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = opts.coreBaseUrl.replace(/\/$/, "");
  async function post(path: string, body: Record<string, unknown>): Promise<{ status: number; text: string }> {
    const raw = JSON.stringify(body);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-source-key-id": opts.coreSourceAuthKeyId,
      "x-client-cert-fingerprint": opts.clientCertFingerprint,
    };
    const nowSec = Math.floor(Date.now() / 1000);
    headers["x-timestamp"] = String(nowSec);
    headers["x-signature"] = signRequest(opts.coreSourceAuthSecret, nowSec, canonicalPayload("POST", path, raw));
    const res = await fetchImpl(`${base}${path}`, { method: "POST", headers, body: raw });
    return { status: res.status, text: await res.text() };
  }
  return {
    async claim(input) {
      const { status, text } = await post("/v1/remote-turn/claim", {
        bindingId: input.bindingId,
        remoteTurnId: input.remoteTurnId,
        turnToken: input.turnToken,
        attestationNonce: input.attestationNonce,
        preClaimAttestation: input.preClaimAttestation,
        envelopeDigest: input.envelopeDigest,
      });
      if (status === 200) {
        const body = JSON.parse(text) as { status: string; executionLeaseHash: string; abortToken: string };
        return { ok: true as const, executionLeaseHash: body.executionLeaseHash, abortToken: body.abortToken };
      }
      let reason = `claim refused (HTTP ${status})`;
      try {
        const body = JSON.parse(text) as { error?: string; message?: string; reason?: string };
        reason = body.message ?? body.reason ?? reason;
      } catch {
        void 0;
      }
      return { ok: false as const, reason, status };
    },
    async postReceipt(input) {
      const { status } = await post("/v1/remote-turn/receipt", {
        bindingId: input.bindingId,
        remoteTurnId: input.remoteTurnId,
        receipt: input.receipt,
      });
      return status === 200 ? { ok: true as const } : { ok: false as const, reason: `receipt refused (HTTP ${status})` };
    },
  };
}

export interface ExecutorClient {
  runTurn(input: { remoteTurnId: string; text: string; history: Array<{ role: string; text: string }> }): Promise<
    { ok: true; reply: string; runtimeMs: number; outputBytes: number } | { ok: false; reason: string }
  >;
}

export function createExecutorClient(opts: { executorBaseUrl: string; timeoutMs?: number; fetchImpl?: typeof fetch }): ExecutorClient {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 60_000;
  return {
    async runTurn(input) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const startedAt = Date.now();
      try {
        const res = await fetchImpl(`${opts.executorBaseUrl.replace(/\/$/, "")}/execute`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ remoteTurnId: input.remoteTurnId, text: input.text, history: input.history }),
          signal: controller.signal,
        });
        if (res.status !== 200) return { ok: false as const, reason: `executor refused (HTTP ${res.status})` };
        const body = (await res.json()) as { reply?: string };
        if (typeof body.reply !== "string") return { ok: false as const, reason: "executor returned no reply" };
        const runtimeMs = Date.now() - startedAt;
        return { ok: true as const, reply: body.reply, runtimeMs, outputBytes: Buffer.byteLength(body.reply, "utf8") };
      } catch {
        return { ok: false as const, reason: "executor unreachable" };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export interface AttestorClient {
  requestPreClaim(input: { remoteTurnId: string; turnToken: string; attestationNonce: string }): Promise<
    { ok: true; preClaimAttestation: string } | { ok: false; reason: string }
  >;
  signalTerminate(remoteTurnId: string): Promise<boolean>;
}

export function createAttestorClient(opts: { attestorBaseUrl: string; fetchImpl?: typeof fetch }): AttestorClient {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = opts.attestorBaseUrl.replace(/\/$/, "");
  return {
    async requestPreClaim(input) {
      try {
        const res = await fetchImpl(`${base}/attest/pre-claim`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ remoteTurnId: input.remoteTurnId, turnToken: input.turnToken, attestationNonce: input.attestationNonce }),
        });
        if (res.status !== 200) return { ok: false as const, reason: `attestor refused (HTTP ${res.status})` };
        const body = (await res.json()) as { preClaimAttestation?: string };
        if (typeof body.preClaimAttestation !== "string") return { ok: false as const, reason: "attestor returned no attestation" };
        return { ok: true as const, preClaimAttestation: body.preClaimAttestation };
      } catch {
        return { ok: false as const, reason: "attestor unreachable" };
      }
    },
    async signalTerminate(remoteTurnId) {
      try {
        const res = await fetchImpl(`${base}/terminate`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ remoteTurnId }),
        });
        return res.status === 200;
      } catch {
        return false;
      }
    },
  };
}

export interface RuntimeHandlers {
  core: CoreClient;
  executor: ExecutorClient;
  attestor: AttestorClient;
  config: RuntimeConfig;
}

const abortTokens = new Map<string, string>();

export async function handleTurn(
  handlers: RuntimeHandlers,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const { config } = handlers;
  if (!isEnvelope(body)) return { status: 400, body: { error: "bad_request", message: "invalid envelope" } };
  const envelope = body as TurnEnvelope;
  if (envelope.bindingVersion !== config.bindingVersion) return { status: 400, body: { error: "bad_request", message: "unsupported protocol version" } };
  const turn = await verifyTurnToken(envelope.turnToken, config.coreVerificationKeys, {
    aud: config.runtimeAudience,
    remoteTurnId: envelope.remoteTurnId,
    envelopeDigest: envelope.envelopeDigest,
    nowMs: (config.now ?? Date.now)(),
  });
  if (!turn) return { status: 401, body: { error: "unauthorized", message: "turn token verification failed" } };
  const preClaim = await handlers.attestor.requestPreClaim({
    remoteTurnId: envelope.remoteTurnId,
    turnToken: envelope.turnToken,
    attestationNonce: envelope.attestationNonce,
  });
  if (!preClaim.ok) return { status: 502, body: { error: "attestation_unavailable", reason: preClaim.reason } };
  const claim = await handlers.core.claim({
    bindingId: config.bindingId,
    remoteTurnId: envelope.remoteTurnId,
    turnToken: envelope.turnToken,
    attestationNonce: envelope.attestationNonce,
    preClaimAttestation: preClaim.preClaimAttestation,
    envelopeDigest: envelope.envelopeDigest,
  });
  if (!claim.ok) return { status: claim.status, body: { error: "claim_refused", reason: claim.reason } };
  abortTokens.set(envelope.remoteTurnId, claim.abortToken);
  const executed = await handlers.executor.runTurn({
    remoteTurnId: envelope.remoteTurnId,
    text: envelope.text,
    history: envelope.history,
  });
  if (!executed.ok) {
    await handlers.attestor.signalTerminate(envelope.remoteTurnId);
    return { status: 502, body: { error: "execution_failed", reason: executed.reason } };
  }
  const receipt = await signReceipt(
    {
      artifact: "receipt",
      schemaVersion: 1,
      remoteTurnId: envelope.remoteTurnId,
      bindingVersion: envelope.bindingVersion,
      executionLeaseHash: claim.executionLeaseHash,
      inputDigest: envelope.inputDigest,
      releaseDigest: envelope.releaseDigest,
      status: "completed",
      reply: executed.reply,
      outputBytes: executed.outputBytes,
      runtimeMs: executed.runtimeMs,
      receivedAt: Date.now(),
    },
    config.receiptKey,
  );
  const posted = await handlers.core.postReceipt({
    bindingId: config.bindingId,
    remoteTurnId: envelope.remoteTurnId,
    receipt,
  });
  if (!posted.ok) return { status: 502, body: { error: "receipt_refused", reason: posted.reason } };
  return { status: 200, body: { status: "accepted" } };
}

export function createRuntimeServer(handlers: RuntimeHandlers): ReturnType<typeof createServer> {
  return createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    let body: unknown;
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "bad_request", message: "invalid json" }));
      return;
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    let out: { status: number; body: Record<string, unknown> };
    if (req.method === "POST" && url.pathname === "/turn") {
      out = await handleTurn(handlers, body);
    } else if (req.method === "POST" && url.pathname === "/abort") {
      const envelope = isRecord(body) ? body : {};
      const remoteTurnId = isString(envelope.remoteTurnId) ? envelope.remoteTurnId : "";
      const abortToken = isString(envelope.abortToken) ? envelope.abortToken : "";
      if (!remoteTurnId || !abortToken) {
        out = { status: 400, body: { error: "bad_request", message: "remoteTurnId and abortToken required" } };
      } else {
        const known = abortTokens.get(remoteTurnId);
        if (known !== abortToken) {
          out = { status: 401, body: { error: "unauthorized", message: "abort token does not match" } };
        } else {
          const abortOk = await handlers.attestor.signalTerminate(remoteTurnId);
          abortTokens.delete(remoteTurnId);
          out = abortOk
            ? { status: 200, body: { status: "abort_acknowledged" } }
            : { status: 502, body: { error: "abort_failed" } };
        }
      }
    } else {
      out = { status: 404, body: { error: "not_found" } };
    }
    res.writeHead(out.status, { "content-type": "application/json" });
    res.end(JSON.stringify(out.body));
  });
}
