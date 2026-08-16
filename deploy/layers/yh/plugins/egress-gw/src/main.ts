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

const tlsPort = Number(process.env.TLS_PORT ?? 443);
const tlsDir = process.env.TLS_DIR;
const capabilitySecret = process.env.CAPABILITY_SECRET;
if (tlsDir && capabilitySecret) {
  const { generateTlsMaterial } = await import("./tls-material.ts");
  const { createPrimeTlsServer } = await import("./prime-tls.ts");
  const hosts = (process.env.TLS_HOSTS ?? "api.deepseek.com").split(",").map((h) => h.trim());
  const material = generateTlsMaterial(tlsDir, hosts);
  const tlsServer = createPrimeTlsServer({
    cert: material.serverCert,
    key: material.serverKey,
    capabilitySecret,
    providerApiKey: process.env.PROVIDER_API_KEY,
    providerBaseUrl: process.env.PROVIDER_BASE_URL ?? "https://api.deepseek.com",
    allowedHosts: hosts,
    ...(process.env.TRUSTED_PEER_CIDRS
      ? { trustedPeerCidrs: process.env.TRUSTED_PEER_CIDRS.split(",").map((c) => c.trim()) }
      : {}),
  });
  tlsServer.listen(tlsPort, "0.0.0.0", () => {
    console.log(`[egress-gw] tls openai endpoint on :${tlsPort} (ca: ${tlsDir}/ca.crt)`);
  });
} else {
  console.warn("[egress-gw] TLS_DIR + CAPABILITY_SECRET required for the prime TLS endpoint — skipped");
}
