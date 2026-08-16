import { createHash, randomBytes, generateKeyPairSync } from "node:crypto";
import { CompactSign, compactVerify, decodeProtectedHeader, importPKCS8, importSPKI } from "jose";
import type { KeySetEntry } from "./binding-store.ts";

type ImportedKey = Awaited<ReturnType<typeof importPKCS8>>;
export type CoreTokenKeySet = KeySetEntry[];

export function csprngHex(bytes = 16): string {
  return randomBytes(bytes).toString("hex");
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export interface RemoteTurnKeyProvider {
  getCurrentSigningKey(): { kid: string; privateKeyPem: string };
}

export function createRemoteTurnKeyProvider(opts: { kid?: string; privateKeyPem?: string } = {}): RemoteTurnKeyProvider {
  const { kid: givenKid, privateKeyPem: givenKey } = opts;
  if (givenKid && givenKey) {
    return { getCurrentSigningKey: () => ({ kid: givenKid, privateKeyPem: givenKey }) };
  }
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const kid = sha256Hex(publicKey.export({ type: "spki", format: "der" }).toString("hex")).slice(0, 8);
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  return { getCurrentSigningKey: () => ({ kid, privateKeyPem }) };
}

interface SigningKey {
  kid: string;
  privateKeyPem: string;
}

const encoder = new TextEncoder();

async function signJws(payload: unknown, key: SigningKey): Promise<string> {
  return new CompactSign(encoder.encode(JSON.stringify(payload)))
    .setProtectedHeader({ alg: "EdDSA", kid: key.kid })
    .sign(await importPKCS8Key(key.privateKeyPem));
}

async function importPKCS8Key(pem: string): Promise<ImportedKey> {
  return importPKCS8(pem, "EdDSA");
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

export interface TurnExpected {
  aud: string;
  envelopeDigest: string;
  remoteTurnId: string;
  now: number;
}

const TURN_CLAIM_KEYS = new Set([
  "kid", "iss", "aud", "iat", "nbf", "exp", "jti", "capability",
  "remoteTurnId", "bindingVersion", "conversationKey", "scopeId",
  "qmSessionId", "coreRunId", "inputDigest", "envelopeDigest", "protocolVersion",
]);

function isTurnClaims(value: unknown): value is TurnClaims {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record.capability !== "turn") return false;
  if (record.iss !== "urn:qm:core") return false;
  for (const key of Object.keys(record)) {
    if (!TURN_CLAIM_KEYS.has(key)) return false;
  }
  return (
    typeof record.kid === "string" &&
    typeof record.aud === "string" &&
    typeof record.iat === "number" &&
    typeof record.nbf === "number" &&
    typeof record.exp === "number" &&
    typeof record.jti === "string" &&
    record.jti.length >= 16 &&
    typeof record.remoteTurnId === "string" &&
    UUID_PATTERN.test(record.remoteTurnId) &&
    typeof record.bindingVersion === "number" &&
    record.bindingVersion >= 1 &&
    typeof record.conversationKey === "string" &&
    typeof record.scopeId === "string" &&
    typeof record.qmSessionId === "string" &&
    UUID_PATTERN.test(record.qmSessionId) &&
    typeof record.coreRunId === "string" &&
    typeof record.inputDigest === "string" &&
    SHA256_PATTERN.test(record.inputDigest) &&
    typeof record.envelopeDigest === "string" &&
    SHA256_PATTERN.test(record.envelopeDigest) &&
    typeof record.protocolVersion === "number" &&
    record.protocolVersion >= 1
  );
}

export async function mintTurnToken(payload: TurnClaims, key: SigningKey): Promise<string> {
  const withKid = { ...payload, kid: key.kid };
  return signJws(withKid, key);
}

const SKEW_S = 30;

function entryActive(entry: KeySetEntry, now: number): boolean {
  return entry.activatedAt <= now && now < entry.retiresAt;
}

async function loadKey(kid: string, keys: CoreTokenKeySet): Promise<ImportedKey | null> {
  const entry = keys.find((k) => k.kid === kid);
  if (!entry) return null;
  return importSPKI(entry.publicKeyPem, "EdDSA");
}

async function verifyJwsCore(
  token: string,
  keys: CoreTokenKeySet,
  now: number,
): Promise<{ payload: Record<string, unknown>; headerKid: string } | null> {
  if (token.split(".").length !== 3) return null;
  let header: { alg?: string; kid?: string };
  try {
    header = decodeProtectedHeader(token);
  } catch {
    return null;
  }
  if (header.alg !== "EdDSA") return null;
  const headerKid = header.kid;
  if (headerKid === undefined) return null;
  const entry = keys.find((k) => k.kid === headerKid);
  if (!entry || !entryActive(entry, now)) return null;
  const keyLike = await loadKey(headerKid, keys);
  if (!keyLike) return null;
  let payload: unknown;
  try {
    const result = await compactVerify(token, keyLike, { algorithms: ["EdDSA"] });
    payload = JSON.parse(new TextDecoder().decode(result.payload));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  if (record.kid !== headerKid) return null;
  return { payload: record, headerKid };
}

export async function verifyTurnToken(
  token: string,
  keys: CoreTokenKeySet,
  expected: TurnExpected,
): Promise<TurnClaims | null> {
  const verified = await verifyJwsCore(token, keys, expected.now);
  if (!verified) return null;
  const claims = verified.payload;
  if (!isTurnClaims(claims)) return null;
  const nowSec = expected.now / 1000;
  if (nowSec < claims.iat - SKEW_S) return null;
  if (nowSec < claims.nbf - SKEW_S) return null;
  if (nowSec >= claims.exp) return null;
  if (claims.aud !== expected.aud) return null;
  if (claims.remoteTurnId !== expected.remoteTurnId) return null;
  if (claims.envelopeDigest !== expected.envelopeDigest) return null;
  return claims;
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

export interface AbortExpected {
  aud: string;
  remoteTurnId: string;
  turnJtiHash: string;
  now: number;
}

export interface AbortTurnState {
  phase: "pre_claim" | "post_claim";
  persistedExecutionLeaseHash?: string;
}

const ABORT_CLAIM_KEYS = new Set([
  "kid", "iss", "aud", "iat", "nbf", "exp", "jti", "capability",
  "remoteTurnId", "bindingVersion", "turnJtiHash", "protocolVersion",
  "executionLeaseHash", "coreRunId",
]);

function isAbortClaims(value: unknown): value is AbortClaims {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record.capability !== "abort") return false;
  if (record.iss !== "urn:qm:core") return false;
  for (const key of Object.keys(record)) {
    if (!ABORT_CLAIM_KEYS.has(key)) return false;
  }
  return (
    typeof record.kid === "string" &&
    typeof record.aud === "string" &&
    typeof record.iat === "number" &&
    typeof record.nbf === "number" &&
    typeof record.exp === "number" &&
    typeof record.jti === "string" &&
    record.jti.length >= 16 &&
    typeof record.remoteTurnId === "string" &&
    UUID_PATTERN.test(record.remoteTurnId) &&
    typeof record.bindingVersion === "number" &&
    record.bindingVersion >= 1 &&
    typeof record.turnJtiHash === "string" &&
    SHA256_PATTERN.test(record.turnJtiHash) &&
    typeof record.protocolVersion === "number" &&
    record.protocolVersion >= 1 &&
    (record.executionLeaseHash === undefined ||
      (typeof record.executionLeaseHash === "string" && SHA256_PATTERN.test(record.executionLeaseHash))) &&
    (record.coreRunId === undefined || typeof record.coreRunId === "string")
  );
}

export async function mintAbortToken(payload: AbortClaims, key: SigningKey): Promise<string> {
  const withKid = { ...payload, kid: key.kid };
  return signJws(withKid, key);
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
}

export interface ReceiptExpected {
  remoteTurnId: string;
  bindingVersion: number;
  executionLeaseHash: string;
  inputDigest: string;
  releaseDigest: string;
  now: number;
}

const RECEIPT_CLAIM_KEYS = new Set([
  "artifact", "schemaVersion", "remoteTurnId", "bindingVersion", "executionLeaseHash",
  "inputDigest", "releaseDigest", "status", "reply", "outputBytes", "runtimeMs", "receivedAt",
]);

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function isReceiptClaims(value: unknown): value is ReceiptClaims {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!RECEIPT_CLAIM_KEYS.has(key)) return false;
  }
  if (record.artifact !== "receipt") return false;
  if (record.status !== "completed") return false;
  if (typeof record.schemaVersion !== "number" || record.schemaVersion < 1) return false;
  if (typeof record.remoteTurnId !== "string" || !UUID_PATTERN.test(record.remoteTurnId)) return false;
  if (typeof record.bindingVersion !== "number" || record.bindingVersion < 1) return false;
  if (typeof record.executionLeaseHash !== "string" || !SHA256_PATTERN.test(record.executionLeaseHash)) return false;
  if (typeof record.inputDigest !== "string" || !SHA256_PATTERN.test(record.inputDigest)) return false;
  if (typeof record.releaseDigest !== "string" || !SHA256_PATTERN.test(record.releaseDigest)) return false;
  if (typeof record.reply !== "string") return false;
  if (Buffer.byteLength(record.reply, "utf8") > 16384) return false;
  if (typeof record.outputBytes !== "number" || !Number.isInteger(record.outputBytes) || record.outputBytes < 0 || record.outputBytes > 16384) return false;
  if (typeof record.runtimeMs !== "number" || !Number.isInteger(record.runtimeMs) || record.runtimeMs < 0 || record.runtimeMs > 60000) return false;
  if (typeof record.receivedAt !== "number" || !Number.isInteger(record.receivedAt)) return false;
  return true;
}

function receiptExpectedMatches(claims: ReceiptClaims, expected: ReceiptExpected): boolean {
  return (
    claims.remoteTurnId === expected.remoteTurnId &&
    claims.bindingVersion === expected.bindingVersion &&
    claims.executionLeaseHash === expected.executionLeaseHash &&
    claims.inputDigest === expected.inputDigest &&
    claims.releaseDigest === expected.releaseDigest
  );
}

export async function verifyReceipt(
  token: string,
  keys: CoreTokenKeySet,
  expected: ReceiptExpected,
): Promise<ReceiptClaims | null> {
  if (token.split(".").length !== 3) return null;
  let headerKid: string | undefined;
  try {
    const header = decodeProtectedHeader(token);
    if (header.alg !== "EdDSA") return null;
    headerKid = header.kid;
  } catch {
    return null;
  }
  if (headerKid === undefined) return null;
  const entry = keys.find((k) => k.kid === headerKid);
  if (!entry || !entryActive(entry, expected.now)) return null;
  const key = await loadKey(headerKid, keys);
  if (!key) return null;
  let payload: unknown;
  try {
    const result = await compactVerify(token, key, { algorithms: ["EdDSA"] });
    payload = JSON.parse(new TextDecoder().decode(result.payload));
  } catch {
    return null;
  }
  if (!isReceiptClaims(payload)) return null;
  if (!receiptExpectedMatches(payload, expected)) return null;
  return payload;
}

export async function verifyAbortToken(
  token: string,
  keys: CoreTokenKeySet,
  expected: AbortExpected,
  turnState: AbortTurnState,
): Promise<AbortClaims | null> {
  const verified = await verifyJwsCore(token, keys, expected.now);
  if (!verified) return null;
  const claims = verified.payload;
  if (!isAbortClaims(claims)) return null;
  const nowSec = expected.now / 1000;
  if (nowSec < claims.iat - SKEW_S) return null;
  if (nowSec < claims.nbf - SKEW_S) return null;
  if (nowSec >= claims.exp) return null;
  if (claims.aud !== expected.aud) return null;
  if (claims.remoteTurnId !== expected.remoteTurnId) return null;
  if (claims.turnJtiHash !== expected.turnJtiHash) return null;
  if (turnState.phase === "post_claim") {
    if (claims.executionLeaseHash === undefined) return null;
    if (claims.coreRunId === undefined) return null;
    if (claims.executionLeaseHash !== turnState.persistedExecutionLeaseHash) return null;
  } else {
    if (claims.executionLeaseHash !== undefined) return null;
    if (claims.coreRunId !== undefined) return null;
  }
  return claims;
}
