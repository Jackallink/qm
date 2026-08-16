import { createEgressGateway, createEgressServer, createMemoryEgressTokenStore } from "./index.ts";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const handlers = createEgressGateway({
  meteringKey: { kid: requireEnv("METERING_KEY_KID"), privateKeyPem: requireEnv("METERING_KEY") },
  store: createMemoryEgressTokenStore(),
  tokenTtlMs: Number(process.env.TOKEN_TTL_MS ?? 120_000),
  providerApiKey: process.env.PROVIDER_API_KEY,
  providerBaseUrl: process.env.PROVIDER_BASE_URL,
});

const port = Number(process.env.PORT ?? 48080);
createEgressServer(handlers).listen(port, () => {
  console.log(`[egress-gw] listening on :${port}`);
});
