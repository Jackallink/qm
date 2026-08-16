import { CompactSign, compactVerify, exportSPKI, importSPKI } from "jose";
import type { KeyObject } from "node:crypto";

export interface G0ContextClaims {
  actorId: string;
  scopeId: string;
  conversationKey: string;
  governanceDecisionId: string;
  governanceAuthorizationDigest: string;
  traceId: string;
  exp: number;
  nbf: number;
  aud: string;
}

export interface G0Verifier {
  verifyContext(
    jws: string,
    expected: { audience: string; nowMs: number },
  ): Promise<G0ContextClaims | null>;
}

const G0_FIELDS = new Set([
  "kid", "actorId", "scopeId", "conversationKey", "governanceDecisionId",
  "governanceAuthorizationDigest", "traceId", "exp", "nbf", "aud",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function validateClaims(value: unknown): G0ContextClaims | null {
  if (!isRecord(value)) return null;
  if (Object.keys(value).some((key) => !G0_FIELDS.has(key))) return null;
  if (!isString(value.actorId)) return null;
  if (!isString(value.scopeId)) return null;
  if (!isString(value.conversationKey)) return null;
  if (!isString(value.governanceDecisionId)) return null;
  if (!isString(value.governanceAuthorizationDigest)) return null;
  if (!isString(value.traceId)) return null;
  if (!isNumber(value.exp) || !isNumber(value.nbf)) return null;
  if (!isString(value.aud)) return null;
  return value as unknown as G0ContextClaims;
}

export async function mintGovernanceContext(
  payload: G0ContextClaims,
  key: KeyObject,
  kid: string,
): Promise<string> {
  const withKid = { ...payload, kid };
  return new CompactSign(new TextEncoder().encode(JSON.stringify(withKid)))
    .setProtectedHeader({ alg: "EdDSA", kid })
    .sign(key);
}

export function createG0Verifier(opts: {
  publicKeyPems: Record<string, string>;
  skewMs?: number;
}): G0Verifier {
  const skewMs = opts.skewMs ?? 30_000;
  return {
    async verifyContext(jws, expected): Promise<G0ContextClaims | null> {
      let header: { alg?: string; kid?: string };
      try {
        const { decodeProtectedHeader } = await import("jose");
        header = decodeProtectedHeader(jws) as { alg?: string; kid?: string };
      } catch {
        return null;
      }
      if (header.alg !== "EdDSA" || !header.kid) return null;
      const pem = opts.publicKeyPems[header.kid];
      if (!pem) return null;
      let payload: unknown;
      try {
        const key = await importSPKI(pem, "EdDSA");
        const result = await compactVerify(jws, key, { algorithms: ["EdDSA"] });
        payload = JSON.parse(new TextDecoder().decode(result.payload));
      } catch {
        return null;
      }
      const claims = validateClaims(payload);
      if (!claims) return null;
      if (claims.aud !== expected.audience) return null;
      const now = expected.nowMs;
      if (now < claims.nbf * 1000 - skewMs) return null;
      if (now >= claims.exp * 1000) return null;
      return claims;
    },
  };
}

export async function exportG0PublicKey(key: KeyObject): Promise<string> {
  return exportSPKI(key);
}
