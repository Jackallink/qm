import { createServer as createHttpsServer } from "node:https";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Server } from "node:http";

export function ipInCidr(ip: string, cidr: string): boolean {
  const [base, bitsRaw] = cidr.split("/") as [string, string];
  const bits = Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const clean = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
  const octets = clean.split(".").map(Number);
  if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return false;
  const baseOctets = base.split(".").map(Number);
  if (baseOctets.length !== 4) return false;
  const mask = bits === 0 ? 0 : ~((1 << (32 - bits)) - 1) >>> 0;
  const ipInt = ((octets[0]! << 24) | (octets[1]! << 16) | (octets[2]! << 8) | octets[3]!) >>> 0;
  const baseInt = ((baseOctets[0]! << 24) | (baseOctets[1]! << 16) | (baseOctets[2]! << 8) | baseOctets[3]!) >>> 0;
  return (ipInt & mask) === (baseInt & mask);
}

function signToken(secret: string, payloadB64: string): string {
  return createHmac("sha256", secret).update(payloadB64).digest("base64url");
}

export interface CapabilityClaims {
  orgId?: string;
  actorId?: string;
  scopeId?: string;
  aud: string;
  egress?: {
    allowedHosts?: string[];
    deniedHosts?: string[];
    denyPrivateNetworks?: boolean;
    privateNetworkAllowedHosts?: string[];
  };
  exp: number;
}

export function verifyCapabilityToken(token: string, secret: string, nowMs: number): CapabilityClaims | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sig] = parts as [string, string, string];
  const expected = signToken(secret, `${headerB64}.${payloadB64}`);
  const sigBuf = Buffer.from(sig ?? "", "base64url");
  const expBuf = Buffer.from(expected, "base64url");
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object") return null;
  const claims = payload as Record<string, unknown>;
  if (typeof claims.aud !== "string" || claims.aud !== "egress-proxy") return null;
  if (typeof claims.exp !== "number" || nowMs >= claims.exp) return null;
  return claims as unknown as CapabilityClaims;
}

export interface PrimeTlsOptions {
  cert: string;
  key: string;
  capabilitySecret?: string;
  providerApiKey?: string;
  providerBaseUrl?: string;
  allowedHosts?: string[];
  /** Trusted peer subnets (CIDR). When a connection arrives from one of
   * these, the capability token is optional — the per-scope internal
   * network already scopes the sandbox to this gateway as its only peer. */
  trustedPeerCidrs?: string[];
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export function createPrimeTlsServer(opts: PrimeTlsOptions): Server {
  const now = opts.now ?? Date.now;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const allowedHosts = opts.allowedHosts ?? ["api.deepseek.com"];
  const providerBaseUrl = opts.providerBaseUrl ?? "https://api.deepseek.com";

  const tokenFromRequest = (req: import("node:http").IncomingMessage): string | null => {
    const header = req.headers["proxy-authorization"];
    const raw = Array.isArray(header) ? header[0] : header;
    if (!raw) return null;
    if (raw.startsWith("Basic ")) {
      try {
        const decoded = Buffer.from(raw.slice(6), "base64").toString("utf8");
        return decoded.split(":")[1] ?? null;
      } catch {
        return null;
      }
    }
    if (raw.startsWith("Bearer ")) return raw.slice(7);
    return raw;
  };

  return createHttpsServer({ cert: opts.cert, key: opts.key }, async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    const url = new URL(req.url ?? "/", "https://api.deepseek.com");
    const send = (status: number, body: unknown): void => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method !== "POST" || !url.pathname.endsWith("/chat/completions")) {
      send(404, { error: "not_found" });
      return;
    }
    if (!opts.capabilitySecret) {
      send(503, { error: "capability_secret_unset" });
      return;
    }
    const token = tokenFromRequest(req);
    const claims = token ? verifyCapabilityToken(token, opts.capabilitySecret, now()) : null;
    const peer = req.socket.remoteAddress ?? "";
    const trustedPeer = (opts.trustedPeerCidrs ?? []).some((cidr) => ipInCidr(peer, cidr));
    if (!claims && !trustedPeer) {
      send(403, { error: "egress_denied", reason: "missing or invalid capability token" });
      return;
    }
    const host = url.hostname;
    const allowed = allowedHosts.includes(host);
    if (!allowed) {
      send(403, { error: "egress_denied", reason: "host not allowed" });
      return;
    }
    if (!opts.providerApiKey) {
      send(503, { error: "provider_key_unset" });
      return;
    }
    let parsed: unknown;
    try {
      parsed = raw ? JSON.parse(raw) : {};
    } catch {
      send(400, { error: "bad_request" });
      return;
    }
    try {
      const upstream = await fetchImpl(`${providerBaseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${opts.providerApiKey}`,
        },
        body: JSON.stringify(parsed),
      });
      const text = await upstream.text();
      res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" });
      res.end(text);
    } catch {
      send(502, { error: "upstream_unreachable" });
    }
  });
}
