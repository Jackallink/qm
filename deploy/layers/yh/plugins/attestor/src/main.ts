import { createAttestor, createAttestorServer } from "./index.ts";
import { createPostgresAttestorStore } from "./pg-store.ts";
import { createDockerClient } from "./docker.ts";
import type { KeySetEntry } from "../../shared/src/protocol.ts";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function keySetFromEnv(prefix: string): KeySetEntry[] {
  const raw = process.env[`${prefix}_KEYS`];
  if (!raw) return [];
  const parsed = JSON.parse(raw) as Array<{ kid: string; publicKeyPem: string; state?: string; activatedAt?: number; retiresAt?: number }>;
  const now = Date.now();
  return parsed.map((entry) => ({
    kid: entry.kid,
    publicKeyPem: entry.publicKeyPem,
    state: entry.state === "overlap" ? "overlap" : "current",
    activatedAt: entry.activatedAt ?? now - 1000,
    retiresAt: entry.retiresAt ?? now + 100_000,
  }));
}

const config = {
  attestorKey: { kid: requireEnv("ATTESTOR_KEY_KID"), privateKeyPem: requireEnv("ATTESTOR_KEY") },
  coreVerificationKeys: keySetFromEnv("CORE_VERIFICATION"),
  runtimeAudience: requireEnv("RUNTIME_AUDIENCE"),
  releaseDigest: requireEnv("ATTESTOR_RELEASE_DIGEST"),
  releaseImage: requireEnv("ATTESTOR_RELEASE_IMAGE"),
  networkPolicyId: requireEnv("NETWORK_POLICY_ID"),
  endpointAllowlist: JSON.parse(requireEnv("ENDPOINT_ALLOWLIST")) as string[],
  egressAudience: requireEnv("EGRESS_AUDIENCE"),
  policySnapshotHash: requireEnv("POLICY_SNAPSHOT_HASH"),
  isolationMode: process.env.ISOLATION_MODE ?? "container",
  maxPreClaimSandboxes: Number(process.env.ATTESTOR_MAX_PRECLAIM_SANDBOXES ?? 8),
  preClaimReapGraceMs: Number(process.env.ATTESTOR_REAP_GRACE_MS ?? 30_000),
  bindingVersion: Number(process.env.BINDING_VERSION ?? 1),
  egressGateway: {
    async mintToken(input) {
      const res = await fetch(`${requireEnv("EGRESS_BASE_URL")}/egress-tokens`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok) return { ok: false as const, reason: `egress refused (HTTP ${res.status})` };
      const body = (await res.json()) as { token: string; tokenId: string };
      return { ok: true as const, token: body.token, tokenId: body.tokenId };
    },
    async revokeToken(tokenId) {
      const res = await fetch(`${requireEnv("EGRESS_BASE_URL")}/egress-tokens/${tokenId}/revoke`, { method: "POST" });
      if (!res.ok) return { ok: false as const, reason: `revoke refused (HTTP ${res.status})` };
      return { ok: true as const, ack: true };
    },
  },
  docker: createDockerClient(),
  store: createPostgresAttestorStore({ connectionString: requireEnv("ATTESTOR_PG_URL") }),
};

const handlers = createAttestor(config);
const port = Number(process.env.PORT ?? 8082);
createAttestorServer(handlers).listen(port, () => {
  console.log(`[attestor] listening on :${port}`);
});
