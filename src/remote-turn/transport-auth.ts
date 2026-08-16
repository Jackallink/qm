import { verifySignature } from "../auth/source-auth.ts";
import { canonicalPayload } from "../auth/source-auth-sign.ts";
import type { RemoteRuntimeBinding } from "./binding-store.ts";

export interface TransportAuthKeys {
  [keyId: string]: string;
}

export type TransportAuthResult = { ok: true } | { ok: false; reason: string };

export interface TransportAuthVerifier {
  verifySourceAuth(
    binding: Pick<RemoteRuntimeBinding, "transportSourceAuthKeyId">,
    req: { method: string; pathWithQuery: string; signature: unknown; timestamp: unknown; body: string },
  ): TransportAuthResult;
  verifyClientCertPin(
    binding: Pick<RemoteRuntimeBinding, "transportCertificatePin">,
    presentedPin: unknown,
  ): TransportAuthResult;
}

export function createTransportAuth(opts: {
  keys: TransportAuthKeys;
  now?: () => number;
  replayWindowMs?: number;
}): TransportAuthVerifier {
  const now = opts.now ?? Date.now;
  const replayWindowMs = opts.replayWindowMs ?? 5 * 60_000;
  return {
    verifySourceAuth(
      binding: Pick<RemoteRuntimeBinding, "transportSourceAuthKeyId">,
      req: { method: string; pathWithQuery: string; signature: unknown; timestamp: unknown; body: string },
    ): TransportAuthResult {
      const secret = opts.keys[binding.transportSourceAuthKeyId];
      if (!secret) return { ok: false, reason: "unknown transport source-auth key id" };
      if (typeof req.signature !== "string" || typeof req.timestamp !== "string") {
        return { ok: false, reason: "missing signature or timestamp" };
      }
      const timestamp = Number(req.timestamp);
      const canonical = canonicalPayload(req.method, req.pathWithQuery, req.body);
      const result = verifySignature(secret, { signature: req.signature, timestamp, body: canonical }, now(), replayWindowMs);
      return result.ok ? { ok: true } : { ok: false, reason: result.reason ?? "signature verification failed" };
    },
    verifyClientCertPin(
      binding: Pick<RemoteRuntimeBinding, "transportCertificatePin">,
      presentedPin: unknown,
    ): TransportAuthResult {
      if (typeof presentedPin !== "string" || presentedPin.length === 0) {
        return { ok: false, reason: "missing client certificate fingerprint" };
      }
      if (presentedPin !== binding.transportCertificatePin) {
        return { ok: false, reason: "client certificate fingerprint mismatch" };
      }
      return { ok: true };
    },
  };
}
