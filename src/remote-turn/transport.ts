import type { DispatchPayload } from "./store.ts";

export interface TransportRegistry {
  [serviceId: string]: string;
}

export type DispatchSendResult =
  | { ok: true }
  | { ok: false; reason: "unregistered_service" | "delivery_failed" };

export interface RemoteTurnTransport {
  sendTurn(payload: DispatchPayload, serviceId: string, baseUrl: string): Promise<DispatchSendResult>;
  resolveService(serviceId: string): string | null;
}

export function createRemoteTurnTransport(opts: {
  transports: TransportRegistry;
  clientCertFingerprint?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): RemoteTurnTransport {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  return {
    resolveService(serviceId: string): string | null {
      return opts.transports[serviceId] ?? null;
    },
    async sendTurn(payload: DispatchPayload, serviceId: string, baseUrl: string): Promise<DispatchSendResult> {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (opts.clientCertFingerprint) headers["x-client-cert-fingerprint"] = opts.clientCertFingerprint;
      const body = JSON.stringify({
        remoteTurnId: payload.remoteTurnId,
        bindingVersion: payload.bindingVersion,
        conversationKey: payload.conversationKey,
        scopeId: payload.scopeId,
        qmSessionId: payload.qmSessionId,
        coreRunId: payload.coreRunId,
        inputDigest: payload.inputDigest,
        historyDigest: payload.historyDigest,
        envelopeDigest: payload.envelopeDigest,
        releaseDigest: payload.releaseDigest,
        turnToken: payload.turnToken,
        attestationNonce: payload.attestationNonce,
        text: payload.text,
        history: payload.history,
      });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetchImpl(`${baseUrl.replace(/\/$/, "")}/turn`, {
          method: "POST",
          headers,
          body,
          signal: controller.signal,
        });
        if (res.status === 200 || res.status === 202) return { ok: true };
        return { ok: false, reason: "delivery_failed" };
      } catch {
        return { ok: false, reason: "delivery_failed" };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
