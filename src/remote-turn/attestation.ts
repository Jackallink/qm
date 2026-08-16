import { compactVerify, importSPKI } from "jose";
import type { KeySetEntry } from "./binding-store.ts";

const UUID_PATTERN = "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";
const SHA256_PATTERN = "^[a-f0-9]{64}$";

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

export interface PreClaimExpected {
  remoteTurnId: string;
  bindingVersion: number;
  turnJtiHash: string;
  attestationNonceHash: string;
  intendedWorkloadIdentity: string;
  releaseDigest: string;
  policyDigest: string;
  endpointAllowlist: string[];
  egressAudience: string;
  expiry: number;
  singleUse: boolean;
}

export interface StartProofExpected {
  executionLeaseHash: string;
  plannedSandboxId: string;
  intendedWorkloadIdentity: string;
  turnJtiHash: string;
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

export interface UsageStatementExpected {
  remoteTurnId: string;
  executionLeaseHash: string;
}

interface AttestationVerifier {
  attestationKeySet: KeySetEntry[];
  expected: PreClaimExpected;
}

type ImportedKey = Awaited<ReturnType<typeof importSPKI>>;
type KeyCache = Map<string, Promise<ImportedKey | null>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

function matches(value: string, pattern: string): boolean {
  return new RegExp(pattern).test(value);
}

function isHttpUri(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && Boolean(parsed.hostname);
  } catch {
    return false;
  }
}

function findKey(attestationKeySet: KeySetEntry[], kid: string): KeySetEntry | null {
  return attestationKeySet.find((entry) => entry.kid === kid) ?? null;
}

function entryActive(entry: KeySetEntry, now: number): boolean {
  return entry.activatedAt <= now && now < entry.retiresAt;
}

function keyLoader(attestationKeySet: KeySetEntry[], cache: KeyCache): (kid: string) => Promise<ImportedKey | null> {
  return (kid: string) => {
    const entry = findKey(attestationKeySet, kid);
    if (!entry) return Promise.resolve(null);
    const cacheKey = `${entry.kid}@${entry.publicKeyPem.length}:${entry.publicKeyPem.slice(-24)}`;
    const existing = cache.get(cacheKey);
    if (existing) return existing;
    const loaded = importSPKI(entry.publicKeyPem, "EdDSA").catch(() => null);
    cache.set(cacheKey, loaded);
    return loaded;
  };
}

async function verifyAttestationJws(
  jws: string,
  attestationKeySet: KeySetEntry[],
  now: number,
  cache: KeyCache,
): Promise<{ payload: unknown; headerKid: string } | null> {
  const loadKey = keyLoader(attestationKeySet, cache);
  const dot = jws.indexOf(".");
  if (dot <= 0) return null;
  const headerSegment = jws.slice(0, dot);
  let headerKid: unknown;
  try {
    const decoded = JSON.parse(Buffer.from(headerSegment, "base64url").toString("utf8")) as unknown;
    if (!isRecord(decoded)) return null;
    headerKid = decoded.kid;
  } catch {
    return null;
  }
  if (!isString(headerKid)) return null;
  const key = await loadKey(headerKid);
  if (!key) return null;
  const entry = findKey(attestationKeySet, headerKid);
  if (!entry || !entryActive(entry, now)) return null;
  try {
    const { payload } = await compactVerify(jws, key, { algorithms: ["EdDSA"] });
    return { payload: JSON.parse(new TextDecoder().decode(payload)) as unknown, headerKid };
  } catch {
    return null;
  }
}

const PRECLAIM_FIELDS = new Set([
  "artifact", "schemaVersion", "remoteTurnId", "bindingVersion", "turnJtiHash",
  "attestationNonceHash", "intendedWorkloadIdentity", "plannedSandboxId", "releaseDigest",
  "isolationMode", "policyDigest", "networkPolicyId", "endpointAllowlist", "egressAudience",
  "expiry", "singleUse",
]);

function validatePreClaimClaims(value: unknown): PreClaimClaims | null {
  if (!isRecord(value)) return null;
  if (Object.keys(value).some((key) => !PRECLAIM_FIELDS.has(key))) return null;
  if (value.artifact !== "pre_claim_attestation") return null;
  if (!isInteger(value.schemaVersion) || value.schemaVersion < 1) return null;
  if (!isString(value.remoteTurnId) || !matches(value.remoteTurnId, UUID_PATTERN)) return null;
  if (!isInteger(value.bindingVersion) || value.bindingVersion < 1) return null;
  if (!isString(value.turnJtiHash) || !matches(value.turnJtiHash, SHA256_PATTERN)) return null;
  if (!isString(value.attestationNonceHash) || !matches(value.attestationNonceHash, SHA256_PATTERN)) return null;
  if (!isString(value.intendedWorkloadIdentity)) return null;
  if (!isString(value.plannedSandboxId)) return null;
  if (!isString(value.releaseDigest) || !matches(value.releaseDigest, SHA256_PATTERN)) return null;
  if (!isString(value.isolationMode)) return null;
  if (!isString(value.policyDigest) || !matches(value.policyDigest, SHA256_PATTERN)) return null;
  if (!isString(value.networkPolicyId)) return null;
  if (
    !Array.isArray(value.endpointAllowlist) ||
    value.endpointAllowlist.length < 1 ||
    !value.endpointAllowlist.every((item) => isString(item) && isHttpUri(item))
  ) {
    return null;
  }
  if (!isString(value.egressAudience)) return null;
  if (!isInteger(value.expiry)) return null;
  if (value.singleUse !== true) return null;
  return {
    artifact: "pre_claim_attestation",
    schemaVersion: value.schemaVersion,
    remoteTurnId: value.remoteTurnId,
    bindingVersion: value.bindingVersion,
    turnJtiHash: value.turnJtiHash,
    attestationNonceHash: value.attestationNonceHash,
    intendedWorkloadIdentity: value.intendedWorkloadIdentity,
    plannedSandboxId: value.plannedSandboxId,
    releaseDigest: value.releaseDigest,
    isolationMode: value.isolationMode,
    policyDigest: value.policyDigest,
    networkPolicyId: value.networkPolicyId,
    endpointAllowlist: value.endpointAllowlist as string[],
    egressAudience: value.egressAudience,
    expiry: value.expiry,
    singleUse: true,
  };
}

const STARTPROOF_FIELDS = new Set([
  "artifact", "schemaVersion", "remoteTurnId", "bindingVersion", "turnJtiHash",
  "executionLeaseHash", "sandboxId", "workloadIdentity", "releaseDigest", "networkPolicyId",
  "egressTokenId", "startTime", "attestorKid",
]);

function validateStartProofClaims(value: unknown): StartProofClaims | null {
  if (!isRecord(value)) return null;
  if (Object.keys(value).some((key) => !STARTPROOF_FIELDS.has(key))) return null;
  if (value.artifact !== "start_proof") return null;
  if (!isInteger(value.schemaVersion) || value.schemaVersion < 1) return null;
  if (!isString(value.remoteTurnId) || !matches(value.remoteTurnId, UUID_PATTERN)) return null;
  if (!isInteger(value.bindingVersion) || value.bindingVersion < 1) return null;
  if (!isString(value.turnJtiHash) || !matches(value.turnJtiHash, SHA256_PATTERN)) return null;
  if (!isString(value.executionLeaseHash) || !matches(value.executionLeaseHash, SHA256_PATTERN)) return null;
  if (!isString(value.sandboxId)) return null;
  if (!isString(value.workloadIdentity)) return null;
  if (!isString(value.releaseDigest) || !matches(value.releaseDigest, SHA256_PATTERN)) return null;
  if (!isString(value.networkPolicyId)) return null;
  if (!isString(value.egressTokenId)) return null;
  if (!isInteger(value.startTime)) return null;
  if (!isString(value.attestorKid)) return null;
  return {
    artifact: "start_proof",
    schemaVersion: value.schemaVersion,
    remoteTurnId: value.remoteTurnId,
    bindingVersion: value.bindingVersion,
    turnJtiHash: value.turnJtiHash,
    executionLeaseHash: value.executionLeaseHash,
    sandboxId: value.sandboxId,
    workloadIdentity: value.workloadIdentity,
    releaseDigest: value.releaseDigest,
    networkPolicyId: value.networkPolicyId,
    egressTokenId: value.egressTokenId,
    startTime: value.startTime,
    attestorKid: value.attestorKid,
  };
}

function preClaimExpectedMatches(claims: PreClaimClaims, expected: PreClaimExpected): boolean {
  return (
    claims.remoteTurnId === expected.remoteTurnId &&
    claims.bindingVersion === expected.bindingVersion &&
    claims.turnJtiHash === expected.turnJtiHash &&
    claims.attestationNonceHash === expected.attestationNonceHash &&
    claims.intendedWorkloadIdentity === expected.intendedWorkloadIdentity &&
    claims.releaseDigest === expected.releaseDigest &&
    claims.policyDigest === expected.policyDigest &&
    claims.endpointAllowlist.length === expected.endpointAllowlist.length &&
    claims.endpointAllowlist.every((url, index) => url === expected.endpointAllowlist[index]) &&
    claims.egressAudience === expected.egressAudience &&
    claims.expiry === expected.expiry &&
    claims.singleUse === expected.singleUse
  );
}

function startProofExpectedMatches(claims: StartProofClaims, expected: StartProofExpected): boolean {
  return (
    claims.executionLeaseHash === expected.executionLeaseHash &&
    claims.sandboxId === expected.plannedSandboxId &&
    claims.workloadIdentity === expected.intendedWorkloadIdentity &&
    claims.turnJtiHash === expected.turnJtiHash
  );
}

const USAGE_FIELDS = new Set([
  "artifact", "schemaVersion", "remoteTurnId", "executionLeaseHash", "workloadIdentity",
  "endpoint", "usage", "costUsd", "timestamp", "kid",
]);

function validateUsageStatementClaims(value: unknown): UsageStatementClaims | null {
  if (!isRecord(value)) return null;
  if (Object.keys(value).some((key) => !USAGE_FIELDS.has(key))) return null;
  if (value.artifact !== "usage_statement") return null;
  if (!isInteger(value.schemaVersion) || value.schemaVersion < 1) return null;
  if (!isString(value.remoteTurnId) || !matches(value.remoteTurnId, UUID_PATTERN)) return null;
  if (!isString(value.executionLeaseHash) || !matches(value.executionLeaseHash, SHA256_PATTERN)) return null;
  if (!isString(value.workloadIdentity) || value.workloadIdentity.length === 0) return null;
  if (!isString(value.endpoint) || !isHttpUri(value.endpoint)) return null;
  const usage = value.usage;
  if (!isRecord(usage)) return null;
  if (Object.keys(usage).some((key) => key !== "inputTokens" && key !== "outputTokens")) return null;
  if (!isInteger(usage.inputTokens) || usage.inputTokens < 0) return null;
  if (!isInteger(usage.outputTokens) || usage.outputTokens < 0) return null;
  if (typeof value.costUsd !== "number" || !Number.isFinite(value.costUsd) || value.costUsd < 0) return null;
  if (!isInteger(value.timestamp) || value.timestamp < 0) return null;
  if (!isString(value.kid) || value.kid.length === 0) return null;
  return value as unknown as UsageStatementClaims;
}

function usageStatementExpectedMatches(claims: UsageStatementClaims, expected: UsageStatementExpected): boolean {
  return claims.remoteTurnId === expected.remoteTurnId && claims.executionLeaseHash === expected.executionLeaseHash;
}

export interface AttestationVerifierOptions {
  now?: () => number;
}

export function createAttestationVerifier(opts: AttestationVerifierOptions = {}): {
  verifyPreClaimAttestation: (jws: string, input: AttestationVerifier) => Promise<PreClaimClaims | null>;
  verifyStartProof: (
    jws: string,
    input: { attestationKeySet: KeySetEntry[]; expected: StartProofExpected },
  ) => Promise<StartProofClaims | null>;
  verifyUsageStatement: (
    jws: string,
    input: { meteringKeySet: KeySetEntry[]; expected: UsageStatementExpected },
  ) => Promise<UsageStatementClaims | null>;
} {
  const now = opts.now ?? Date.now;
  const cache: KeyCache = new Map();
  return {
    async verifyPreClaimAttestation(jws, input): Promise<PreClaimClaims | null> {
      const verified = await verifyAttestationJws(jws, input.attestationKeySet, now(), cache);
      if (!verified) return null;
      const claims = validatePreClaimClaims(verified.payload);
      if (!claims || !preClaimExpectedMatches(claims, input.expected)) return null;
      return claims;
    },
    async verifyStartProof(jws, input): Promise<StartProofClaims | null> {
      const verified = await verifyAttestationJws(jws, input.attestationKeySet, now(), cache);
      if (!verified) return null;
      const claims = validateStartProofClaims(verified.payload);
      if (!claims) return null;
      if (claims.attestorKid !== verified.headerKid) return null;
      if (!startProofExpectedMatches(claims, input.expected)) return null;
      return claims;
    },
    async verifyUsageStatement(jws, input): Promise<UsageStatementClaims | null> {
      const verified = await verifyAttestationJws(jws, input.meteringKeySet, now(), cache);
      if (!verified) return null;
      const claims = validateUsageStatementClaims(verified.payload);
      if (!claims) return null;
      if (claims.kid !== verified.headerKid) return null;
      if (!usageStatementExpectedMatches(claims, input.expected)) return null;
      return claims;
    },
  };
}
