import { createServer } from "node:http";
import { sha256Hex, signArtifact } from "../../shared/src/protocol.ts";

export interface EgressTokenRecord {
  tokenId: string;
  token: string;
  executionLeaseHash: string;
  workloadIdentity: string;
  endpointAllowlist: string[];
  expiryMs: number;
  revoked: boolean;
  usage: { inputTokens: number; outputTokens: number; costUsd: number; calls: number };
  networkId?: string;
}

export interface EgressTokenStore {
  insert(record: EgressTokenRecord): Promise<void>;
  get(tokenId: string): Promise<EgressTokenRecord | null>;
  getByLease(executionLeaseHash: string): Promise<EgressTokenRecord | null>;
  markRevoked(tokenId: string): Promise<void>;
  addUsage(tokenId: string, usage: { inputTokens: number; outputTokens: number; costUsd: number }): Promise<void>;
  list(): Promise<EgressTokenRecord[]>;
}

export function createMemoryEgressTokenStore(): EgressTokenStore {
  const records = new Map<string, EgressTokenRecord>();
  return {
    async insert(record) {
      records.set(record.tokenId, record);
    },
    async get(tokenId) {
      return records.get(tokenId) ?? null;
    },
    async getByLease(executionLeaseHash) {
      for (const record of records.values()) {
        if (record.executionLeaseHash === executionLeaseHash) return record;
      }
      return null;
    },
    async markRevoked(tokenId) {
      const record = records.get(tokenId);
      if (record) record.revoked = true;
    },
    async addUsage(tokenId, usage) {
      const record = records.get(tokenId);
      if (record) {
        record.usage.inputTokens += usage.inputTokens;
        record.usage.outputTokens += usage.outputTokens;
        record.usage.costUsd += usage.costUsd;
        record.usage.calls += 1;
      }
    },
    async list() {
      return [...records.values()];
    },
  };
}

export interface EgressConfig {
  meteringKey: { kid: string; privateKeyPem: string };
  store: EgressTokenStore;
  now?: () => number;
  tokenTtlMs: number;
}

export interface EgressHandlers {
  mintToken(input: {
    executionLeaseHash: string;
    workloadIdentity: string;
    endpointAllowlist: string[];
    expiryMs: number;
  }): Promise<{ ok: true; token: string; tokenId: string } | { ok: false; reason: string }>;
  revokeToken(tokenId: string): Promise<{ ok: true; ack: boolean } | { ok: false; reason: string }>;
  authorize(input: { token: string; url: string }): Promise<{ ok: true } | { ok: false; reason: string }>;
  recordUsage(input: {
    token: string;
    url: string;
    usage?: { inputTokens: number; outputTokens: number; costUsd: number };
  }): Promise<void>;
  usageStatement(input: { executionLeaseHash: string }): Promise<
    { ok: true; statement: string } | { ok: false; reason: string }
  >;
}

export function createEgressGateway(config: EgressConfig): EgressHandlers {
  const now = config.now ?? Date.now;
  return {
    async mintToken(input) {
      const tokenId = `egt-${sha256Hex(`${input.executionLeaseHash}:${now()}`).slice(0, 16)}`;
      const token = `egt.${Buffer.from(JSON.stringify({ tokenId, lease: input.executionLeaseHash, exp: input.expiryMs })).toString("base64url")}`;
      await config.store.insert({
        tokenId,
        token,
        executionLeaseHash: input.executionLeaseHash,
        workloadIdentity: input.workloadIdentity,
        endpointAllowlist: input.endpointAllowlist,
        expiryMs: input.expiryMs,
        revoked: false,
        usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 },
      });
      return { ok: true, token, tokenId };
    },
    async revokeToken(tokenId) {
      const record = await config.store.get(tokenId);
      if (!record) return { ok: false, reason: "unknown token" };
      await config.store.markRevoked(tokenId);
      return { ok: true, ack: true };
    },
    async authorize(input) {
      if (!input.token.startsWith("egt.")) return { ok: false, reason: "malformed token" };
      let payload: { tokenId?: string; exp?: number };
      try {
        payload = JSON.parse(Buffer.from(input.token.slice(4), "base64url").toString("utf8")) as {
          tokenId?: string;
          exp?: number;
        };
      } catch {
        return { ok: false, reason: "malformed token" };
      }
      if (!payload.tokenId) return { ok: false, reason: "malformed token" };
      const record = await config.store.get(payload.tokenId);
      if (!record) return { ok: false, reason: "unknown token" };
      if (record.revoked) return { ok: false, reason: "revoked" };
      if (now() >= record.expiryMs) return { ok: false, reason: "expired" };
      let url: URL;
      try {
        url = new URL(input.url);
      } catch {
        return { ok: false, reason: "malformed url" };
      }
      const allowed = record.endpointAllowlist.some((entry) => {
        try {
          const allowedUrl = new URL(entry);
          return allowedUrl.origin === url.origin;
        } catch {
          return false;
        }
      });
      if (!allowed) return { ok: false, reason: "endpoint not allowed" };
      return { ok: true };
    },
    async recordUsage(input) {
      let payload: { tokenId?: string };
      try {
        payload = JSON.parse(Buffer.from(input.token.slice(4), "base64url").toString("utf8")) as { tokenId?: string };
      } catch {
        return;
      }
      if (!payload.tokenId) return;
      await config.store.addUsage(payload.tokenId, input.usage ?? { inputTokens: 0, outputTokens: 0, costUsd: 0 });
    },
    async usageStatement(input) {
      const record = await config.store.getByLease(input.executionLeaseHash);
      if (!record) return { ok: false, reason: "no token for lease" };
      if (record.usage.calls === 0) return { ok: false, reason: "no usage recorded" };
      const statement = await signArtifact(
        {
          artifact: "usage_statement",
          schemaVersion: 1,
          remoteTurnId: record.workloadIdentity,
          executionLeaseHash: record.executionLeaseHash,
          workloadIdentity: record.workloadIdentity,
          endpoint: record.endpointAllowlist[0] ?? "",
          usage: { inputTokens: record.usage.inputTokens, outputTokens: record.usage.outputTokens },
          costUsd: record.usage.costUsd,
          timestamp: Math.floor(now() / 1000),
        },
        config.meteringKey,
      );
      return { ok: true, statement };
    },
  };
}

export function createEgressServer(handlers: EgressHandlers): ReturnType<typeof createServer> {
  return createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    let body: Record<string, unknown> = {};
    try {
      body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "bad_request" }));
      return;
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    let out: { status: number; body: Record<string, unknown> };
    if (req.method === "POST" && url.pathname === "/egress-tokens") {
      const result = await handlers.mintToken({
        executionLeaseHash: typeof body.executionLeaseHash === "string" ? body.executionLeaseHash : "",
        workloadIdentity: typeof body.workloadIdentity === "string" ? body.workloadIdentity : "",
        endpointAllowlist: Array.isArray(body.endpointAllowlist) ? (body.endpointAllowlist as string[]) : [],
        expiryMs: typeof body.expiryMs === "number" ? body.expiryMs : Date.now() + 120_000,
      });
      out = result.ok
        ? { status: 200, body: { token: result.token, tokenId: result.tokenId } }
        : { status: 409, body: { error: "mint_refused", reason: result.reason } };
    } else if (req.method === "POST" && url.pathname.startsWith("/egress-tokens/") && url.pathname.endsWith("/revoke")) {
      const tokenId = decodeURIComponent(url.pathname.split("/")[2]!);
      const result = await handlers.revokeToken(tokenId);
      out = result.ok ? { status: 200, body: { revoked: result.ack } } : { status: 409, body: { error: "revoke_failed", reason: result.reason } };
    } else if (req.method === "POST" && url.pathname === "/authorize") {
      const result = await handlers.authorize({
        token: typeof body.token === "string" ? body.token : "",
        url: typeof body.url === "string" ? body.url : "",
      });
      out = result.ok ? { status: 200, body: { allowed: true } } : { status: 403, body: { allowed: false, reason: result.reason } };
    } else if (req.method === "POST" && url.pathname === "/usage") {
      await handlers.recordUsage({
        token: typeof body.token === "string" ? body.token : "",
        url: typeof body.url === "string" ? body.url : "",
        usage: body.usage as { inputTokens: number; outputTokens: number; costUsd: number } | undefined,
      });
      out = { status: 200, body: { recorded: true } };
    } else if (req.method === "POST" && url.pathname === "/usage-statement") {
      const result = await handlers.usageStatement({
        executionLeaseHash: typeof body.executionLeaseHash === "string" ? body.executionLeaseHash : "",
      });
      out = result.ok
        ? { status: 200, body: { statement: result.statement } }
        : { status: 409, body: { error: "no_statement", reason: result.reason } };
    } else {
      out = { status: 404, body: { error: "not_found" } };
    }
    res.writeHead(out.status, { "content-type": "application/json" });
    res.end(JSON.stringify(out.body));
  });
}
