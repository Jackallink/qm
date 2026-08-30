import { createCoreClient, createAttestorClient, createExecutorClient, createRuntimeServer, type RuntimeConfig } from "./index.ts";
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

const config: RuntimeConfig = {
  bindingId: requireEnv("BINDING_ID"),
  runtimeAudience: requireEnv("RUNTIME_AUDIENCE"),
  coreVerificationKeys: keySetFromEnv("CORE_VERIFICATION"),
  receiptKeys: keySetFromEnv("RECEIPT"),
  receiptKey: { kid: requireEnv("RECEIPT_KEY_KID"), privateKeyPem: requireEnv("RUNTIME_RECEIPT_KEY") },
  coreBaseUrl: requireEnv("CORE_BASE_URL"),
  coreSourceAuthKeyId: requireEnv("CORE_SOURCE_AUTH_KEY_ID"),
  coreSourceAuthSecret: requireEnv("CORE_SOURCE_AUTH_SECRET"),
  clientCertFingerprint: requireEnv("CLIENT_CERT_FINGERPRINT"),
  executorBaseUrl: requireEnv("EXECUTOR_BASE_URL"),
  attestorBaseUrl: requireEnv("ATTESTOR_BASE_URL"),
  bindingVersion: Number(process.env.BINDING_VERSION ?? 1),
};

const handlers = {
  core: createCoreClient({
    coreBaseUrl: config.coreBaseUrl,
    coreSourceAuthKeyId: config.coreSourceAuthKeyId,
    coreSourceAuthSecret: config.coreSourceAuthSecret,
    clientCertFingerprint: config.clientCertFingerprint,
  }),
  executor: createExecutorClient({ executorBaseUrl: config.executorBaseUrl }),
  attestor: createAttestorClient({ attestorBaseUrl: config.attestorBaseUrl }),
  config,
};

const port = Number(process.env.PORT ?? 8081);
createRuntimeServer(handlers).listen(port, () => {
  console.log(`[remote-runtime] listening on :${port}`);
});
