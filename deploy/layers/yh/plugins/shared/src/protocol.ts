import { CompactSign, compactVerify, decodeProtectedHeader, importPKCS8, importSPKI } from "jose";
import { createHash } from "node:crypto";
import type { KeyObject } from "node:crypto";

export interface KeySetEntry {
  kid: string;
  publicKeyPem: string;
  state: "current" | "overlap";
  activatedAt: number;
  retiresAt: number;
}

export interface TurnClaims {
  kid: string;
  iss: string;
  aud: string;
  iat: number;
  nbf: number;
  exp: number;
  jti: string;
  capability: "turn";
  remoteTurnId: string;
  bindingVersion: number;
  conversationKey: string;
  scopeId: string;
  qmSessionId: string;
  coreRunId: string;
  inputDigest: string;
  envelopeDigest: string;
  protocolVersion: number;
}

export interface AbortClaims {
  kid: string;
  iss: string;
  aud: string;
  iat: number;
  nbf: number;
  exp: number;
  jti: string;
  capability: "abort";
  remoteTurnId: string;
  bindingVersion: number;
  turnJtiHash: string;
  protocolVersion: number;
  executionLeaseHash?: string;
  coreRunId?: string;
}

export interface ReceiptClaims {
  artifact: "receipt";
  schemaVersion: number;
  remoteTurnId: string;
  bindingVersion: number;
  executionLeaseHash: string;
  inputDigest: string;
  releaseDigest: string;
  status: "completed";
  reply: string;
  outputBytes: number;
  runtimeMs: number;
  receivedAt: number;
  kid: string;
}

export interface PreClaimClaims {
  artifact: "pre_claim_attestation";
  schemaVersion: number;
  remoteTurnId: string;
  bindingVersion: number;
  turnJtiHash: string;
  attestationNonceHash: string;
  intendedWorkloadIdentity: string;
  plannedSandboxId: string;
  releaseDigest: string;
  isolationMode: string;
  policyDigest: string;
  networkPolicyId: string;
  endpointAllowlist: string[];
  egressAudience: string;
  expiry: number;
  singleUse: boolean;
  kid: string;
}

export interface StartProofClaims {
  artifact: "start_proof";
  schemaVersion: number;
  remoteTurnId: string;
  bindingVersion: number;
  turnJtiHash: string;
  executionLeaseHash: string;
  sandboxId: string;
  workloadIdentity: string;
  releaseDigest: string;
  networkPolicyId: string;
  egressTokenId: string;
  startTime: number;
  attestorKid: string;
}

export interface TerminationProofClaims {
  artifact: "termination_proof";
  schemaVersion: number;
  remoteTurnId: string;
  executionLeaseHash: string;
  sandboxId: string;
  exitResult: "deleted";
  egressRevocationAck: true;
  egressTokenId: string;
  timestamp: number;
  attestorKid: string;
}

export interface UsageStatementClaims {
  artifact: "usage_statement";
  schemaVersion: number;
  remoteTurnId: string;
  executionLeaseHash: string;
  workloadIdentity: string;
  endpoint: string;
  usage: { inputTokens: number; outputTokens: number };
  costUsd: number;
  timestamp: number;
  kid: string;
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function computeInputDigest(text: string): string {
  return sha256Hex(text);
}

export function computeEnvelopeDigest(fields: {
  remoteTurnId: string;
  bindingVersion: number;
  conversationKey: string;
  scopeId: string;
  qmSessionId: string;
  coreRunId: string;
  inputDigest: string;
  historyDigest: string;
}): string {
  const frames = [
    fields.remoteTurnId,
    String(fields.bindingVersion),
    fields.conversationKey,
    fields.scopeId,
    fields.qmSessionId,
    fields.coreRunId,
    fields.inputDigest,
    fields.historyDigest,
  ].map((field) => {
    const bytes = Buffer.from(field, "utf8");
    const head = Buffer.alloc(4);
    head.writeUInt32BE(bytes.length);
    return Buffer.concat([head, bytes]);
  });
  return sha256Hex(Buffer.concat(frames).toString("latin1"));
}

const SKEW_S = 30;

function entryActive(entry: KeySetEntry, now: number): boolean {
  return entry.activatedAt <= now && now < entry.retiresAt;
}

async function verifySigned(
  jws: string,
  keys: KeySetEntry[],
  nowMs: number,
): Promise<{ payload: Record<string, unknown>; headerKid: string } | null> {
  if (jws.split(".").length !== 3) return null;
  let header: { alg?: string; kid?: string };
  try {
    header = decodeProtectedHeader(jws);
  } catch {
    return null;
  }
  if (header.alg !== "EdDSA" || header.kid === undefined) return null;
  const entry = keys.find((k) => k.kid === header.kid);
  if (!entry || !entryActive(entry, nowMs)) return null;
  let payload: unknown;
  try {
    const key = await importSPKI(entry.publicKeyPem, "EdDSA");
    const result = await compactVerify(jws, key, { algorithms: ["EdDSA"] });
    payload = JSON.parse(new TextDecoder().decode(result.payload));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  if (record.kid !== undefined && record.kid !== header.kid) return null;
  return { payload: record, headerKid: header.kid };
}

function timeValid(claims: { iat: number; nbf: number; exp: number }, nowMs: number): boolean {
  const nowSec = nowMs / 1000;
  if (nowSec < claims.iat - SKEW_S) return false;
  if (nowSec < claims.nbf - SKEW_S) return false;
  if (nowSec >= claims.exp) return false;
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

const UUID_PATTERN = "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";
const SHA256_PATTERN = "^[a-f0-9]{64}$";

function matches(value: string, pattern: string): boolean {
  return new RegExp(pattern).test(value);
}

export interface TurnTokenVerifyInput {
  aud: string;
  remoteTurnId: string;
  envelopeDigest?: string;
  nowMs: number;
}

export async function verifyTurnToken(
  jws: string,
  keys: KeySetEntry[],
  input: TurnTokenVerifyInput,
): Promise<TurnClaims | null> {
  const verified = await verifySigned(jws, keys, input.nowMs);
  if (!verified) return null;
  const c = verified.payload;
  if (c.capability !== "turn" || c.iss !== "urn:qm:core") return null;
  if (!isString(c.jti) || c.jti.length < 16) return null;
  if (!isString(c.remoteTurnId) || !matches(c.remoteTurnId, UUID_PATTERN)) return null;
  if (!isString(c.qmSessionId) || !matches(c.qmSessionId, UUID_PATTERN)) return null;
  if (!isString(c.inputDigest) || !matches(c.inputDigest, SHA256_PATTERN)) return null;
  if (!isString(c.envelopeDigest) || !matches(c.envelopeDigest, SHA256_PATTERN)) return null;
  if (typeof c.bindingVersion !== "number" || c.bindingVersion < 1) return null;
  if (typeof c.protocolVersion !== "number" || c.protocolVersion < 1) return null;
  for (const key of ["kid", "aud", "conversationKey", "scopeId", "coreRunId"]) {
    if (!isString(c[key])) return null;
  }
  if (typeof c.iat !== "number" || typeof c.nbf !== "number" || typeof c.exp !== "number") return null;
  if (!timeValid(c as unknown as { iat: number; nbf: number; exp: number }, input.nowMs)) return null;
  if (c.aud !== input.aud || c.remoteTurnId !== input.remoteTurnId) {
    return null;
  }
  if (input.envelopeDigest !== undefined && c.envelopeDigest !== input.envelopeDigest) {
    return null;
  }
  return c as unknown as TurnClaims;
}

export interface AbortTokenVerifyInput {
  aud: string;
  remoteTurnId: string;
  turnJtiHash: string;
  nowMs: number;
  phase: "pre_claim" | "post_claim";
  executionLeaseHash?: string;
  coreRunId?: string;
}

export async function verifyAbortToken(
  jws: string,
  keys: KeySetEntry[],
  input: AbortTokenVerifyInput,
): Promise<AbortClaims | null> {
  const verified = await verifySigned(jws, keys, input.nowMs);
  if (!verified) return null;
  const c = verified.payload;
  if (c.capability !== "abort" || c.iss !== "urn:qm:core") return null;
  if (!isString(c.jti) || c.jti.length < 16) return null;
  if (!isString(c.turnJtiHash) || !matches(c.turnJtiHash, SHA256_PATTERN)) return null;
  if (typeof c.bindingVersion !== "number" || c.bindingVersion < 1) return null;
  if (typeof c.protocolVersion !== "number" || c.protocolVersion < 1) return null;
  if (typeof c.iat !== "number" || typeof c.nbf !== "number" || typeof c.exp !== "number") return null;
  if (!timeValid(c as unknown as { iat: number; nbf: number; exp: number }, input.nowMs)) return null;
  if (c.aud !== input.aud || c.remoteTurnId !== input.remoteTurnId || c.turnJtiHash !== input.turnJtiHash) {
    return null;
  }
  if (input.phase === "post_claim") {
    if (!isString(c.executionLeaseHash) || !matches(c.executionLeaseHash, SHA256_PATTERN)) return null;
    if (!isString(c.coreRunId)) return null;
    if (c.executionLeaseHash !== input.executionLeaseHash || c.coreRunId !== input.coreRunId) return null;
  } else {
    if (c.executionLeaseHash !== undefined || c.coreRunId !== undefined) return null;
  }
  return c as unknown as AbortClaims;
}

const RECEIPT_FIELDS = new Set([
  "artifact", "schemaVersion", "remoteTurnId", "bindingVersion", "executionLeaseHash",
  "inputDigest", "releaseDigest", "status", "reply", "outputBytes", "runtimeMs", "receivedAt", "kid",
]);

export async function signReceipt(
  claims: Omit<ReceiptClaims, "kid">,
  key: { kid: string; privateKeyPem: string },
): Promise<string> {
  const withKid = { ...claims, kid: key.kid };
  const signingKey = await importPKCS8(key.privateKeyPem, "EdDSA");
  return new CompactSign(new TextEncoder().encode(JSON.stringify(withKid)))
    .setProtectedHeader({ alg: "EdDSA", kid: key.kid })
    .sign(signingKey);
}

export interface ReceiptVerifyInput {
  remoteTurnId: string;
  bindingVersion: number;
  executionLeaseHash: string;
  inputDigest: string;
  releaseDigest: string;
  nowMs: number;
}

export async function verifyReceipt(
  jws: string,
  keys: KeySetEntry[],
  input: ReceiptVerifyInput,
): Promise<ReceiptClaims | null> {
  const verified = await verifySigned(jws, keys, input.nowMs);
  if (!verified) return null;
  const c = verified.payload;
  for (const key of Object.keys(c)) {
    if (!RECEIPT_FIELDS.has(key)) return null;
  }
  if (c.artifact !== "receipt" || c.status !== "completed") return null;
  if (!isString(c.reply)) return null;
  if (Buffer.byteLength(c.reply, "utf8") > 16_384) return null;
  if (typeof c.outputBytes !== "number" || c.outputBytes < 0 || c.outputBytes > 16_384) return null;
  if (typeof c.runtimeMs !== "number" || c.runtimeMs < 0 || c.runtimeMs > 60_000) return null;
  if (typeof c.schemaVersion !== "number" || c.schemaVersion < 1) return null;
  if (typeof c.bindingVersion !== "number" || c.bindingVersion < 1) return null;
  if (!isString(c.remoteTurnId) || !matches(c.remoteTurnId, UUID_PATTERN)) return null;
  for (const key of ["executionLeaseHash", "inputDigest", "releaseDigest"]) {
    if (!isString(c[key]) || !matches(c[key], SHA256_PATTERN)) return null;
  }
  if (typeof c.receivedAt !== "number") return null;
  if (
    c.remoteTurnId !== input.remoteTurnId ||
    c.bindingVersion !== input.bindingVersion ||
    c.executionLeaseHash !== input.executionLeaseHash ||
    c.inputDigest !== input.inputDigest ||
    c.releaseDigest !== input.releaseDigest
  ) {
    return null;
  }
  return c as unknown as ReceiptClaims;
}

export async function signArtifact(
  payload: Record<string, unknown>,
  key: { kid: string; privateKeyPem: string },
): Promise<string> {
  const signingKey = await importPKCS8(key.privateKeyPem, "EdDSA");
  return new CompactSign(new TextEncoder().encode(JSON.stringify(payload)))
    .setProtectedHeader({ alg: "EdDSA", kid: key.kid })
    .sign(signingKey);
}

export async function verifyArtifact(
  jws: string,
  keys: KeySetEntry[],
  nowMs: number,
): Promise<Record<string, unknown> | null> {
  const verified = await verifySigned(jws, keys, nowMs);
  return verified ? verified.payload : null;
}

export function exportKeyToPem(key: KeyObject): string {
  return key.export({ type: "spki", format: "pem" }).toString();
}
