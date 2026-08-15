import { randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import { join, resolve } from "node:path";
import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../../../plugins/chassis/src/portal-identity.ts";
import { signedRequestHeaders } from "../../../plugins/chassis/src/source-auth-sign.ts";
import { isLocalDockerTextOnlyProfile, type QmConfig } from "../config.ts";
import { CliError } from "../log.ts";
import { readEnvFile, sleep } from "../util.ts";

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface LocalCustomProviderInput {
  id: string;
  name: string;
  protocol: "openai" | "anthropic";
  baseUrl: string;
  model: {
    id: string;
    name: string;
    contextWindow: number;
    maxTokens: number;
  };
}

interface LocalHostInput {
  config: QmConfig;
  configDir: string;
  envFile?: string;
  principal: string;
  now?: () => number;
  fetchImpl?: FetchLike;
}

export interface LocalDockerBootstrapInput extends LocalHostInput {
  provider: LocalCustomProviderInput;
  coreUrl?: string;
}

export interface LocalDockerVerifierInput extends LocalHostInput {
  text: string;
  threadRef?: string;
  timeoutMs?: number;
  webUrl?: string;
  sleep?: (ms: number) => Promise<void>;
}

interface HostSecrets {
  sourceAuth: string;
  portalIdentity: string;
  adminGrants: string;
  providerKey?: string;
}

interface PendingResponse {
  response: Response;
  abort: () => void;
}

class LocalRequestTimeout extends Error {}

const BOOTSTRAP_REQUEST_TIMEOUT_MS = 15_000;
const ERROR_BODY_LIMIT = 1024;
const PROXY_ENV_NAMES = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"] as const;

const requireText = (value: string, label: string): string => {
  const trimmed = value.trim();
  if (!trimmed) throw new CliError(`local Docker ${label} is required`, { clause: "d0l.host" });
  return trimmed;
};

function requireLocalProfile(config: QmConfig): void {
  if (!isLocalDockerTextOnlyProfile(config)) {
    throw new CliError("local bootstrap and verifier require the local Docker text-only profile", {
      clause: "d0l.host",
    });
  }
}

function requireDirectLoopbackTransport(): void {
  const nodeOptions = process.env.NODE_OPTIONS ?? "";
  const proxyEnabled =
    process.execArgv.some((argument) => argument.startsWith("--use-env-proxy")) ||
    /(^|\s)--use-env-proxy(?:=\S+)?(?=\s|$)/.test(nodeOptions) ||
    Boolean(process.env.NODE_USE_ENV_PROXY?.trim()) ||
    PROXY_ENV_NAMES.some((name) => Boolean(process.env[name]?.trim()));
  if (proxyEnabled) {
    throw new CliError("local Docker bootstrap and verifier require proxy environment to be disabled", {
      clause: "d0l.host",
    });
  }
}

function secretPath(configDir: string, envFile?: string): string {
  return resolve(envFile ?? join(configDir, ".env"));
}

function readHostSecrets(configDir: string, envFile?: string, providerKey = false): HostSecrets {
  const path = secretPath(configDir, envFile);
  let stats: ReturnType<typeof lstatSync>;
  try {
    stats = lstatSync(path);
  } catch {
    throw new CliError(`local Docker secret file does not exist: ${path}`, { clause: "d0l.host" });
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new CliError("local Docker secret file must be a regular file", { clause: "d0l.host" });
  }
  if ((stats.mode & 0o077) !== 0) {
    throw new CliError("local Docker secret file requires permissions 0600 or stricter", { clause: "d0l.host" });
  }
  const values = readEnvFile(path);
  const required = (name: string): string => {
    const value = values.get(name)?.trim();
    if (!value) throw new CliError(`local Docker secret file is missing ${name}`, { clause: "d0l.host" });
    return value;
  };
  return {
    sourceAuth: required("CORE_SIGNING_SECRET"),
    portalIdentity: required("PORTAL_IDENTITY_SECRET"),
    adminGrants: required("ADMIN_GRANTS"),
    ...(providerKey ? { providerKey: required("D0L_PROVIDER_API_KEY") } : {}),
  };
}

function isOrgAdmin(principal: string, grants: string): boolean {
  return grants.split(",").some((raw) => {
    const entry = raw.trim();
    const colon = entry.lastIndexOf(":");
    return colon > 0 && entry.slice(0, colon).trim() === principal && entry.slice(colon + 1).trim() === "org_admin";
  });
}

function expectedUrl(kind: "Core" | "Web", config: QmConfig): string {
  const basePort = config.basePort ?? 8080;
  return `http://127.0.0.1:${basePort + (kind === "Core" ? 0 : 2)}`;
}

function loopbackUrl(kind: "Core" | "Web", value: string | undefined, config: QmConfig): string {
  const expected = expectedUrl(kind, config);
  const supplied = value ?? expected;
  let parsed: URL;
  try {
    parsed = new URL(supplied);
  } catch {
    throw new CliError(`local Docker loopback ${kind} URL must be ${expected}`, { clause: "d0l.host" });
  }
  if (
    parsed.protocol !== "http:" ||
    parsed.hostname !== "127.0.0.1" ||
    parsed.port !== new URL(expected).port ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    parsed.username ||
    parsed.password
  ) {
    throw new CliError(`local Docker loopback ${kind} URL must be ${expected}`, { clause: "d0l.host" });
  }
  return expected;
}

function validateProvider(provider: LocalCustomProviderInput): LocalCustomProviderInput {
  const id = requireText(provider.id, "provider id");
  const name = requireText(provider.name, "provider name");
  const modelId = requireText(provider.model.id, "model id");
  const modelName = requireText(provider.model.name, "model name");
  if (!/^[a-z][a-z0-9-]{1,31}$/.test(id)) {
    throw new CliError("local Docker provider id must be a lowercase slug", { clause: "d0l.host" });
  }
  if (provider.protocol !== "openai" && provider.protocol !== "anthropic") {
    throw new CliError("local Docker provider protocol must be openai or anthropic", { clause: "d0l.host" });
  }
  let base: URL;
  try {
    base = new URL(provider.baseUrl);
  } catch {
    throw new CliError("local Docker provider base URL must be HTTPS", { clause: "d0l.host" });
  }
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) {
    throw new CliError("local Docker provider base URL must be HTTPS", { clause: "d0l.host" });
  }
  if (!Number.isSafeInteger(provider.model.contextWindow) || provider.model.contextWindow <= 0) {
    throw new CliError("local Docker model context window must be a positive integer", { clause: "d0l.host" });
  }
  if (!Number.isSafeInteger(provider.model.maxTokens) || provider.model.maxTokens <= 0) {
    throw new CliError("local Docker model max tokens must be a positive integer", { clause: "d0l.host" });
  }
  return {
    id,
    name,
    protocol: provider.protocol,
    baseUrl: base.toString().replace(/\/+$/, ""),
    model: {
      id: modelId,
      name: modelName,
      contextWindow: provider.model.contextWindow,
      maxTokens: provider.model.maxTokens,
    },
  };
}

function portalToken(principal: string, secret: string, now: () => number): string {
  return mintPortalIdentity({ p: principal, exp: now() + 60_000 }, secret);
}

async function awaitWithin<T>(operation: Promise<T>, timeoutMs: number, onTimeout?: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout?.();
      reject(new LocalRequestTimeout());
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function fetchWithin(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<PendingResponse> {
  const controller = new AbortController();
  const response = await awaitWithin(fetchImpl(url, { ...init, signal: controller.signal }), timeoutMs, () => controller.abort());
  return { response, abort: () => controller.abort() };
}

async function jsonWithin(pending: PendingResponse, timeoutMs: number): Promise<unknown> {
  return await awaitWithin(pending.response.json(), timeoutMs, pending.abort);
}

async function readErrorBody(pending: PendingResponse): Promise<string> {
  try {
    const body = await awaitWithin(pending.response.text(), BOOTSTRAP_REQUEST_TIMEOUT_MS, pending.abort);
    const trimmed = body.replace(/\s+/g, " ").trim().slice(0, ERROR_BODY_LIMIT);
    return trimmed ? `: ${trimmed}` : "";
  } catch {
    pending.abort();
    return "";
  }
}

async function signedPut(
  coreUrl: string,
  path: string,
  body: unknown,
  sourceAuth: string,
  identity: string,
  fetchImpl: FetchLike,
  label: string,
): Promise<void> {
  const signedPath = `${path}?d0l=${encodeURIComponent(randomUUID())}`;
  const raw = JSON.stringify(body);
  let pending: PendingResponse;
  try {
    pending = await fetchWithin(fetchImpl, `${coreUrl}${signedPath}`, {
      method: "PUT",
      headers: signedRequestHeaders(sourceAuth, "PUT", signedPath, raw, {
        "content-type": "application/json",
        [PORTAL_IDENTITY_HEADER]: identity,
      }),
      body: raw,
      redirect: "manual",
    }, BOOTSTRAP_REQUEST_TIMEOUT_MS);
  } catch (error) {
    if (error instanceof LocalRequestTimeout) {
      throw new CliError(`local Docker bootstrap ${label} timed out waiting for Core`, { clause: "d0l.host" });
    }
    throw new CliError(`local Docker bootstrap ${label} could not reach Core`, { clause: "d0l.host" });
  }
  try {
    if (!pending.response.ok) {
      const detail = await readErrorBody(pending);
      throw new CliError(`local Docker bootstrap ${label} failed with HTTP ${pending.response.status}${detail}`, {
        clause: "d0l.host",
      });
    }
  } finally {
    pending.abort();
  }
}

export async function runLocalDockerBootstrap(input: LocalDockerBootstrapInput): Promise<{
  coreUrl: string;
  providerId: string;
  modelId: string;
  scopeId: string;
}> {
  requireDirectLoopbackTransport();
  requireLocalProfile(input.config);
  const principal = requireText(input.principal, "admin principal");
  const secrets = readHostSecrets(input.configDir, input.envFile, true);
  if (!isOrgAdmin(principal, secrets.adminGrants)) {
    throw new CliError("local Docker bootstrap principal is not an org_admin in ADMIN_GRANTS", { clause: "d0l.host" });
  }
  const provider = validateProvider(input.provider);
  const coreUrl = loopbackUrl("Core", input.coreUrl, input.config);
  const scopeId = `org:${input.config.orgId}`;
  const now = input.now ?? Date.now;
  const identity = portalToken(principal, secrets.portalIdentity, now);
  const fetchImpl = input.fetchImpl ?? fetch;
  await signedPut(
    coreUrl,
    `/v1/admin/scopes/${encodeURIComponent(scopeId)}/approved-harnesses`,
    { ids: ["pi"] },
    secrets.sourceAuth,
    identity,
    fetchImpl,
    "approved harnesses",
  );
  await signedPut(
    coreUrl,
    `/v1/admin/custom-providers/${encodeURIComponent(provider.id)}`,
    {
      name: provider.name,
      protocol: provider.protocol,
      baseUrl: provider.baseUrl,
      models: [provider.model],
      apiKey: secrets.providerKey,
      validate: true,
    },
    secrets.sourceAuth,
    identity,
    fetchImpl,
    "custom provider",
  );
  await signedPut(
    coreUrl,
    `/v1/admin/scopes/${encodeURIComponent(scopeId)}/runtime`,
    { harnessId: "pi", modelId: provider.model.id },
    secrets.sourceAuth,
    identity,
    fetchImpl,
    "runtime selection",
  );
  return { coreUrl, providerId: provider.id, modelId: provider.model.id, scopeId };
}

function validThreadRef(principal: string, value: string | undefined): string {
  const ref = value ?? `web:${principal}:d0l-smoke`;
  if (!ref.startsWith(`web:${principal}:`) || ref.length <= `web:${principal}:`.length) {
    throw new CliError("local Docker verifier threadRef must belong to the QA principal", { clause: "d0l.host" });
  }
  return ref;
}

function runIdFrom(response: unknown): string | null {
  if (!response || typeof response !== "object") return null;
  const value = (response as { runId?: unknown }).runId;
  return typeof value === "string" && value ? value : null;
}

function completeReply(response: unknown): string | null {
  if (!response || typeof response !== "object") return null;
  const record = response as {
    status?: unknown;
    replyComplete?: unknown;
    result?: { status?: unknown; reply?: unknown };
  };
  if (
    record.status !== "done" ||
    record.replyComplete !== true ||
    record.result?.status !== "ok" ||
    typeof record.result.reply !== "string"
  )
    return null;
  return record.result.reply.trim() ? record.result.reply : null;
}

export async function runLocalDockerVerifier(input: LocalDockerVerifierInput): Promise<{ runId: string; reply: string }> {
  requireDirectLoopbackTransport();
  requireLocalProfile(input.config);
  const principal = requireText(input.principal, "QA principal");
  const text = requireText(input.text, "smoke text");
  const secrets = readHostSecrets(input.configDir, input.envFile);
  if (!isOrgAdmin(principal, secrets.adminGrants)) {
    throw new CliError("local Docker verifier principal is not an org_admin in ADMIN_GRANTS", { clause: "d0l.host" });
  }
  const webUrl = loopbackUrl("Web", input.webUrl, input.config);
  const threadRef = validThreadRef(principal, input.threadRef);
  const timeoutMs = input.timeoutMs ?? 45_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 55_000) {
    throw new CliError("local Docker verifier timeout must be between 1 and 55000 milliseconds", { clause: "d0l.host" });
  }
  const now = input.now ?? Date.now;
  const identity = portalToken(principal, secrets.portalIdentity, now);
  const fetchImpl = input.fetchImpl ?? fetch;
  const deadline = Date.now() + timeoutMs;
  const remaining = (): number => {
    const value = deadline - Date.now();
    if (value <= 0) throw new CliError("local Docker verifier timed out before a complete reply", { clause: "d0l.host" });
    return value;
  };
  const verifyFetch = async (url: string, init: RequestInit, unavailable: string): Promise<PendingResponse> => {
    const timeout = remaining();
    try {
      return await fetchWithin(fetchImpl, url, init, timeout);
    } catch (error) {
      if (error instanceof LocalRequestTimeout) {
        throw new CliError("local Docker verifier timed out before a complete reply", { clause: "d0l.host" });
      }
      throw new CliError(unavailable, { clause: "d0l.host" });
    }
  };
  const verifyJson = async (pending: PendingResponse, invalid: string): Promise<unknown> => {
    const timeout = remaining();
    try {
      return await jsonWithin(pending, timeout);
    } catch (error) {
      if (error instanceof LocalRequestTimeout) {
        throw new CliError("local Docker verifier timed out before a complete reply", { clause: "d0l.host" });
      }
      throw new CliError(invalid, { clause: "d0l.host" });
    } finally {
      pending.abort();
    }
  };
  const submitted = await verifyFetch(
    `${webUrl}/api/turn`,
    {
      method: "POST",
      headers: { "content-type": "application/json", [PORTAL_IDENTITY_HEADER]: identity },
      body: JSON.stringify({ text, threadRef }),
      redirect: "manual",
    },
    "local Docker verifier could not reach Web",
  );
  if (!submitted.response.ok) {
    submitted.abort();
    throw new CliError(`local Docker verifier turn was refused with HTTP ${submitted.response.status}`, { clause: "d0l.host" });
  }
  const queued = await verifyJson(submitted, "local Docker verifier did not receive a run id");
  const runId = runIdFrom(queued);
  if (!runId) throw new CliError("local Docker verifier did not receive a run id", { clause: "d0l.host" });
  const sleepImpl = input.sleep ?? sleep;
  for (;;) {
    const polled = await verifyFetch(
      `${webUrl}/api/runs/${encodeURIComponent(runId)}`,
      {
        headers: { [PORTAL_IDENTITY_HEADER]: identity },
        redirect: "manual",
      },
      "local Docker verifier could not poll Web",
    );
    if (!polled.response.ok) {
      polled.abort();
      throw new CliError(`local Docker verifier run lookup failed with HTTP ${polled.response.status}`, { clause: "d0l.host" });
    }
    const record = await verifyJson(polled, "local Docker verifier received an invalid run record");
    const reply = completeReply(record);
    if (reply !== null) return { runId, reply };
    const status = record && typeof record === "object" ? (record as { status?: unknown }).status : undefined;
    if (status === "done" || status === "failed") {
      throw new CliError("local Docker verifier run failed before a complete reply", { clause: "d0l.host" });
    }
    if (Date.now() >= deadline)
      throw new CliError("local Docker verifier timed out before a complete reply", { clause: "d0l.host" });
    await sleepImpl(250);
  }
}
