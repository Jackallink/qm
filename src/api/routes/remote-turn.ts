import { createHash } from "node:crypto";
import { sendJson } from "../http.ts";
import { type ApiCtx, type Route } from "./route.ts";
import { isObj } from "./shared.ts";

const sha256Hex = (input: string): string => createHash("sha256").update(input).digest("hex");

function bodyOf(ctx: ApiCtx): Record<string, unknown> {
  return isObj(ctx.body) ? ctx.body : {};
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function badRequest(ctx: ApiCtx, message: string): void {
  sendJson(ctx.res, 400, { error: "bad_request", message });
}

function notFound(ctx: ApiCtx, message: string): void {
  sendJson(ctx.res, 404, { error: "not_found", message });
}

function unauthorized(ctx: ApiCtx, message: string): void {
  sendJson(ctx.res, 401, { error: "unauthorized", message });
}

function serviceUnavailable(ctx: ApiCtx, message: string): void {
  sendJson(ctx.res, 503, { error: "service_unavailable", message });
}

type TransportCheck =
  | { ok: true; bindingId: string; binding: import("../../remote-turn/binding-store.ts").RemoteRuntimeBinding }
  | { ok: false; status: number; message: string };

async function verifyTransport(ctx: ApiCtx): Promise<TransportCheck> {
  const deps = ctx.deps;
  if (!deps.remoteTurnTransportAuth || !deps.remoteTurnBindingStore) {
    return { ok: false, status: 503, message: "remote turn control plane is not configured" };
  }
  const body = bodyOf(ctx);
  const id = typeof body.bindingId === "string" && body.bindingId.length > 0 ? body.bindingId : null;
  if (!id) return { ok: false, status: 400, message: "bindingId required" };
  const binding = await deps.remoteTurnBindingStore.getBinding(id);
  if (!binding) return { ok: false, status: 404, message: "binding not found" };
  const source = deps.remoteTurnTransportAuth.verifySourceAuth(binding, {
    method: ctx.method,
    pathWithQuery: ctx.pathname + ctx.url.search,
    signature: ctx.req.headers["x-signature"],
    timestamp: ctx.req.headers["x-timestamp"],
    body: ctx.rawBody,
  });
  if (!source.ok) return { ok: false, status: 401, message: source.reason };
  const pin = deps.remoteTurnTransportAuth.verifyClientCertPin(
    binding,
    ctx.req.headers["x-client-cert-fingerprint"],
  );
  if (!pin.ok) return { ok: false, status: 401, message: pin.reason };
  return { ok: true, bindingId: id, binding };
}

function sendTransportFailure(ctx: ApiCtx, check: { status: number; message: string }): void {
  if (check.status === 400) badRequest(ctx, check.message);
  else if (check.status === 404) notFound(ctx, check.message);
  else if (check.status === 503) serviceUnavailable(ctx, check.message);
  else unauthorized(ctx, check.message);
}

async function claim(ctx: ApiCtx): Promise<void> {
  const transport = await verifyTransport(ctx);
  if (!transport.ok) {
    sendTransportFailure(ctx, transport);
    return;
  }
  const deps = ctx.deps;
  if (!deps.remoteTurnStore || !deps.remoteTurnAttestationVerifier || !deps.remoteTurnTurnVerifier || !deps.remoteTurnAttestorClient) {
    serviceUnavailable(ctx, "remote turn control plane is not configured");
    return;
  }
  const body = bodyOf(ctx);
  const turnToken = str(body.turnToken);
  const attestationNonce = str(body.attestationNonce);
  const preClaimJws = str(body.preClaimAttestation);
  const remoteTurnId = str(body.remoteTurnId);
  const envelopeDigest = str(body.envelopeDigest);
  if (!turnToken || !attestationNonce || !preClaimJws || !remoteTurnId || !envelopeDigest) {
    badRequest(ctx, "turnToken, attestationNonce, preClaimAttestation, remoteTurnId, and envelopeDigest are required");
    return;
  }
  const turn = await deps.remoteTurnTurnVerifier.verifyTurnToken(turnToken, transport.binding.coreVerificationKeys, {
    aud: transport.binding.runtimeAudience,
    remoteTurnId,
    envelopeDigest,
    now: Date.now(),
  });
  if (!turn) {
    unauthorized(ctx, "turn token verification failed");
    return;
  }
  const expected = await deps.remoteTurnStore.getPreClaimExpectation(remoteTurnId);
  if (!expected || expected.bindingId !== transport.bindingId) {
    notFound(ctx, "turn not found in dispatching state for this binding");
    return;
  }
  if (expected.turnJtiHash !== sha256Hex(turn.jti)) {
    unauthorized(ctx, "turn token jti does not match the dispatched turn");
    return;
  }
  const claims = await deps.remoteTurnAttestationVerifier.verifyPreClaimAttestation(preClaimJws, {
    attestationKeySet: transport.binding.attestorKeys,
    expected,
  });
  if (!claims) {
    unauthorized(ctx, "pre-claim attestation verification failed");
    return;
  }
  const result = await deps.remoteTurnStore.claim({
    remoteTurnId,
    turnJtiHash: expected.turnJtiHash,
    attestationNonceHash: expected.attestationNonceHash,
    verifiedPreClaim: claims,
    runtimeAudience: transport.binding.runtimeAudience,
    version: expected.version,
  });
  if (!result.ok) {
    sendJson(ctx.res, 409, { error: "claim_refused", reason: result.reason });
    return;
  }
  const leasePush = await deps.remoteTurnAttestorClient.pushLease({
    remoteTurnId,
    executionLease: result.executionLease,
    executionLeaseHash: result.executionLeaseHash,
  });
  if (!leasePush.ok) {
    sendJson(ctx.res, 503, {
      error: "lease_delivery_failed",
      message: leasePush.reason,
      executionLeaseHash: result.executionLeaseHash,
      abortToken: result.abortToken,
    });
    return;
  }
  sendJson(ctx.res, 200, {
    status: "claimed",
    executionLeaseHash: result.executionLeaseHash,
    abortToken: result.abortToken,
  });
}

async function usage(ctx: ApiCtx): Promise<void> {
  const transport = await verifyTransport(ctx);
  if (!transport.ok) {
    sendTransportFailure(ctx, transport);
    return;
  }
  const deps = ctx.deps;
  if (!deps.remoteTurnStore || !deps.remoteTurnAttestationVerifier) {
    serviceUnavailable(ctx, "remote turn control plane is not configured");
    return;
  }
  const body = bodyOf(ctx);
  const statementJws = str(body.statement);
  const remoteTurnId = str(body.remoteTurnId);
  if (!statementJws || !remoteTurnId) {
    badRequest(ctx, "statement and remoteTurnId are required");
    return;
  }
  const leaseHash = await deps.remoteTurnStore.getExecutionLeaseHash(remoteTurnId);
  if (!leaseHash) {
    notFound(ctx, "turn has no execution lease");
    return;
  }
  const claims = await deps.remoteTurnAttestationVerifier.verifyUsageStatement(statementJws, {
    meteringKeySet: transport.binding.meteringKeys,
    expected: { remoteTurnId, executionLeaseHash: leaseHash },
  });
  if (!claims) {
    unauthorized(ctx, "usage statement verification failed");
    return;
  }
  const record = await deps.remoteTurnStore.recordUsageStatement({
    remoteTurnId,
    inputTokens: claims.usage.inputTokens,
    outputTokens: claims.usage.outputTokens,
    costUsd: claims.costUsd,
    endpoint: claims.endpoint,
    statementDigest: sha256Hex(statementJws),
    receivedAt: Date.now(),
  });
  if (!record.ok) {
    notFound(ctx, "turn not found");
    return;
  }
  const outcome = await deps.remoteTurnStore.advanceTeardown(remoteTurnId, deps.remoteTurnUsageGraceMs ?? 15_000);
  sendJson(ctx.res, 200, { status: "recorded", applied: record.applied, teardown: outcome });
}

async function receipt(ctx: ApiCtx): Promise<void> {
  const transport = await verifyTransport(ctx);
  if (!transport.ok) {
    sendTransportFailure(ctx, transport);
    return;
  }
  const deps = ctx.deps;
  if (!deps.remoteTurnStore) {
    serviceUnavailable(ctx, "remote turn control plane is not configured");
    return;
  }
  const body = bodyOf(ctx);
  const remoteTurnId = str(body.remoteTurnId);
  const receiptToken = str(body.receipt);
  if (!remoteTurnId || !receiptToken) {
    badRequest(ctx, "remoteTurnId and receipt are required");
    return;
  }
  const result = await deps.remoteTurnStore.receiveReceipt({ remoteTurnId, receiptToken });
  if (!result.ok) {
    sendJson(ctx.res, 409, { error: "receipt_refused", reason: result.reason });
    return;
  }
  const outcome = await deps.remoteTurnStore.advanceTeardown(remoteTurnId, deps.remoteTurnUsageGraceMs ?? 15_000);
  sendJson(ctx.res, 200, { status: "receipt_received", teardown: outcome });
}

async function startProof(ctx: ApiCtx): Promise<void> {
  const transport = await verifyTransport(ctx);
  if (!transport.ok) {
    sendTransportFailure(ctx, transport);
    return;
  }
  const deps = ctx.deps;
  if (!deps.remoteTurnStore) {
    serviceUnavailable(ctx, "remote turn control plane is not configured");
    return;
  }
  const body = bodyOf(ctx);
  const remoteTurnId = str(body.remoteTurnId);
  const startProofJws = str(body.startProof);
  if (!remoteTurnId || !startProofJws) {
    badRequest(ctx, "remoteTurnId and startProof are required");
    return;
  }
  const result = await deps.remoteTurnStore.startExecution({ remoteTurnId, startProofJws });
  if (!result.ok) {
    sendJson(ctx.res, 409, { error: "start_refused", reason: result.reason });
    return;
  }
  sendJson(ctx.res, 200, { status: "executing" });
}

async function terminationProof(ctx: ApiCtx): Promise<void> {
  const transport = await verifyTransport(ctx);
  if (!transport.ok) {
    sendTransportFailure(ctx, transport);
    return;
  }
  const deps = ctx.deps;
  if (!deps.remoteTurnStore) {
    serviceUnavailable(ctx, "remote turn control plane is not configured");
    return;
  }
  const body = bodyOf(ctx);
  const remoteTurnId = str(body.remoteTurnId);
  const proofJws = str(body.terminationProof);
  if (!remoteTurnId || !proofJws) {
    badRequest(ctx, "remoteTurnId and terminationProof are required");
    return;
  }
  const leaseHash = await deps.remoteTurnStore.getExecutionLeaseHash(remoteTurnId);
  if (!leaseHash) {
    notFound(ctx, "turn has no execution lease");
    return;
  }
  if (!deps.remoteTurnAttestationVerifier) {
    serviceUnavailable(ctx, "remote turn control plane is not configured");
    return;
  }
  const verified = await deps.remoteTurnAttestationVerifier.verifyTerminationProof(proofJws, {
    attestationKeySet: transport.binding.attestorKeys,
    expected: { remoteTurnId, executionLeaseHash: leaseHash },
  });
  if (!verified) {
    unauthorized(ctx, "termination proof verification failed");
    return;
  }
  const result = await deps.remoteTurnStore.completeTeardown({
    remoteTurnId,
    evidence: {
      sandboxDeleted: verified.exitResult === "deleted",
      egressRevoked: verified.egressRevocationAck === true,
      proofDigest: sha256Hex(proofJws),
    },
  });
  if (result !== "completed") {
    sendJson(ctx.res, 409, { error: "teardown_refused", reason: result });
    return;
  }
  sendJson(ctx.res, 200, { status: "completed" });
}

export const remoteTurnRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "POST", path: "/v1/remote-turn/claim", auth: "public", handle: claim },
  { method: "POST", path: "/v1/remote-turn/receipt", auth: "public", handle: receipt },
  { method: "POST", path: "/v1/remote-turn/usage", auth: "public", handle: usage },
  { method: "POST", path: "/v1/remote-turn/start-proof", auth: "public", handle: startProof },
  { method: "POST", path: "/v1/remote-turn/termination-proof", auth: "public", handle: terminationProof },
];
