export const CORE_API_URL = (process.env.CORE_API_URL ?? "http://localhost:8080").replace(/\/$/, "");
export const CORE_ORG_ID = process.env.CORE_ORG_ID ?? "acme";
const secret = (raw: string | undefined): string | undefined => (raw?.trim() ? raw : undefined);

export const CORE_SIGNING_SECRET = secret(process.env.CORE_SIGNING_SECRET);
const configuredPortalIdentitySecret = secret(process.env.PORTAL_IDENTITY_SECRET);
const allowDevelopmentIdentityFallback = process.env.NODE_ENV !== "production";
export const PORTAL_IDENTITY_SECRET =
  configuredPortalIdentitySecret ?? (allowDevelopmentIdentityFallback ? CORE_SIGNING_SECRET : undefined);
if (!configuredPortalIdentitySecret && CORE_SIGNING_SECRET && allowDevelopmentIdentityFallback) {
  console.warn(
    "[chassis] PORTAL_IDENTITY_SECRET unset — signing portal identity with CORE_SIGNING_SECRET (dev fallback)",
  );
}

export function portFromEnv(fallback: number): number {
  return Number(process.env.PORT ?? fallback);
}
