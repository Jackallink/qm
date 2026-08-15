import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CliError, bold, die, dim, errMessage, header, note, ok, step, warn } from "../log.ts";
import {
  capture,
  captureBoth,
  deploymentSecretValue,
  isInvalidSecret,
  readEnvFile,
  resolveBuildRepoRoot,
  runInherit,
  sleep,
  sourceBuildInfo,
  streamLabeled,
  tailString,
  which,
} from "../util.ts";
import { manifestRef } from "../manifest.ts";
import {
  brokerWiring,
  ordered,
  orgEnv,
  runnableServices,
  serviceDef,
  teardownOrdered,
  virtualServiceEnv,
  type LogOpts,
  type ServiceName,
} from "../services.ts";
import {
  LOCAL_DOCKER_HOST_ONLY_ENV_NAMES,
  dockerPostgresImage,
  dockerBasePort,
  isLocalDockerTextOnlyProfile,
  isSandboxDisabled,
  sandboxCoreEnv,
  securityScreenEnv,
  type QmConfig,
  validateLocalDockerTextOnlyProfile,
} from "../config.ts";
import { discoverPlugins, type ResolvedPlugin } from "../plugins.ts";
import { computedSecrets, runtimeSecretNames, secretsForService } from "../secrets.ts";
import {
  readDeploymentState,
  withDeploymentLock,
  writeDeploymentState,
  type DeploymentImageEvidence,
  type DeploymentState,
} from "../state.ts";

const safe = (s: string): string => s.replace(/[^A-Za-z0-9_.-]/g, "-");
const ORG_LABEL_KEY = "qm.org";
const localDockerHostOnlyEnvNames = new Set(LOCAL_DOCKER_HOST_ONLY_ENV_NAMES);
const localDockerDistinctSecretNames = [
  "CAPABILITY_SECRET",
  "CORE_SIGNING_SECRET",
  "PORTAL_IDENTITY_SECRET",
  "CONNECTOR_SECRET_KEY",
] as const;
const orgLabelArgs = (ctx: DockerCtx): string[] => ["--label", `${ORG_LABEL_KEY}=${ctx.config.orgId}`];
const baseHostPort = (ctx: DockerCtx): number => dockerBasePort(ctx.config);
type Ipv6Probe = (port: number) => Promise<boolean>;
type LoopbackHealthProbe = (url: string) => Promise<boolean>;

interface DockerCtx {
  config: QmConfig;
  configDir: string;
  sandboxDir: string;
  network: string;
  prefix: string;
  databaseUrl: string;
  signingSecret?: string;
  envFile?: string;
  sandboxEnv: Record<string, string>;
  sandboxSecretKeys: Set<string>;
  missingSandboxSecrets: string[];
  buildFrom: boolean;
  repoRoot?: string;
  buildInfo?: { gitCommit?: string; dirty?: boolean };
  fetchImpl: typeof fetch;
  ipv6Probe: Ipv6Probe;
  loopbackHealthProbe: LoopbackHealthProbe;
}

const dockerPrefix = (config: QmConfig): string => `qm-${safe(config.orgId)}`;
const cname = (ctx: DockerCtx, name: string): string => `${ctx.prefix}-${name}`;
const pgVolume = (ctx: DockerCtx): string => `${ctx.prefix}-pgdata`;

function requireDocker(): void {
  if (!which("docker")) die("docker not found on PATH (the docker target needs a running Docker daemon).");
  try {
    capture("docker", ["version", "-f", "{{.Server.Version}}"]);
  } catch {
    die("the Docker daemon is not reachable — start Docker (or OrbStack) and retry.");
  }
}

function assertLocalDockerDaemon(config: QmConfig): void {
  if (!isLocalDockerTextOnlyProfile(config)) return;
  const configuredHost = process.env.DOCKER_HOST?.trim();
  const host = configuredHost || docker(["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"]).trim();
  if (host.startsWith("unix://") || host.startsWith("npipe://")) return;
  throw new CliError("local Docker text-only profile requires a local Docker daemon over a Unix socket or named pipe");
}

function docker(args: string[], allow?: RegExp): string {
  try {
    return capture("docker", args, allow ? { allow } : {});
  } catch (e) {
    throw dockerError(args, errMessage(e));
  }
}

function dockerInherit(args: string[], hint?: string): void {
  try {
    runInherit("docker", args);
  } catch {
    throw new CliError(`docker ${args.slice(0, 2).join(" ")} failed.${hint ? `\n${hint}` : ""}`);
  }
}

function dockerError(args: string[], message: string): CliError {
  let hint = "";
  if (/port is already allocated|address already in use/i.test(message)) {
    hint = `\nhint: a host port is already in use — set QM_BASE_PORT to a free base port.`;
  }
  return new CliError(`docker ${args.slice(0, 3).join(" ")}… failed:\n${message}${hint}`);
}

function containerRunning(name: string): boolean {
  try {
    return docker(["inspect", "-f", "{{.State.Running}}", name], /No such object/).trim() === "true";
  } catch {
    return false;
  }
}

function inspectExists(args: string[], notFound: RegExp): boolean {
  const out = docker(args, notFound);
  return out.trim().length > 0 && !notFound.test(out);
}

function containerExists(name: string): boolean {
  return inspectExists(["inspect", "-f", "{{.Id}}", name], /No such object|No such container/i);
}

function volumeExists(name: string): boolean {
  return inspectExists(["volume", "inspect", "-f", "{{.Name}}", name], /No such volume|not found/i);
}

function pgContainerPassword(ctx: DockerCtx): string | undefined {
  if (!containerExists(cname(ctx, "pg"))) return undefined;
  try {
    const env = docker(["inspect", "-f", "{{range .Config.Env}}{{println .}}{{end}}", cname(ctx, "pg")]);
    return env
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.startsWith("POSTGRES_PASSWORD="))
      ?.slice("POSTGRES_PASSWORD=".length);
  } catch {
    return undefined;
  }
}

function imageRef(ctx: DockerCtx, service: ServiceName): string {
  return ctx.config.imageOverrides[service] ?? manifestRef(service);
}

function resolveImage(ctx: DockerCtx, service: ServiceName): string {
  if (ctx.buildFrom) {
    const root = ctx.repoRoot!;
    const dockerfile = join(root, "deploy", service, "Dockerfile");
    if (!existsSync(dockerfile)) throw new CliError(`no Dockerfile at ${dockerfile}`);
    const tag = `qm-${service}:local`;
    const buildArgs: string[] = [];
    step(`building ${service} from ${dockerfile}`);
    dockerInherit(["build", "-f", dockerfile, "-t", tag, ...buildArgs, root]);
    return tag;
  }
  const ref = imageRef(ctx, service);
  step(`pulling ${ref}`);
  dockerInherit(
    ["pull", ref],
    `failed to pull ${ref} — the portable images may not be published yet; ` +
      `re-run with --build-from to build locally from deploy/${service}/Dockerfile.`,
  );
  return ref;
}

function containerImageContentId(name: string): string {
  const id = docker(["inspect", "--format", "{{.Image}}", name]).trim();
  if (!/^sha256:[a-f0-9]{64}$/.test(id)) {
    throw new CliError(`docker container ${name} did not report an image content ID`);
  }
  return id;
}

function imageDigestFromReference(image: string): string | undefined {
  return image.match(/@(?<digest>sha256:[a-f0-9]{64})$/)?.groups?.digest;
}

function imageRepoDigests(imageId: string): string[] {
  const raw = docker(["image", "inspect", "--format", "{{json .RepoDigests}}", imageId]).trim();
  let values: unknown;
  try {
    values = JSON.parse(raw);
  } catch {
    throw new CliError(`docker image ${imageId} did not report repository digests`);
  }
  if (values === null) return [];
  if (!Array.isArray(values)) throw new CliError(`docker image ${imageId} did not report repository digests`);
  return values
    .filter((value): value is string => typeof value === "string")
    .flatMap((value) => {
      const digest = imageDigestFromReference(value);
      return digest ? [digest] : [];
    });
}

function dockerImageEvidence(ctx: DockerCtx, service: string, image: string): DeploymentImageEvidence {
  const imageId = containerImageContentId(cname(ctx, service));
  if (ctx.buildFrom && service !== "pg") {
    const build = ctx.buildInfo;
    if (!ctx.repoRoot) {
      throw new CliError("local Docker text-only source builds require Git HEAD and dirty-state evidence");
    }
    if (isLocalDockerTextOnlyProfile(ctx.config) && (!build?.gitCommit || build.dirty === undefined)) {
      throw new CliError("local Docker text-only source builds require Git HEAD and dirty-state evidence");
    }
    return {
      kind: "build-from",
      source: ctx.repoRoot,
      imageId,
      ...(build?.gitCommit ? { gitCommit: build.gitCommit } : {}),
      ...(build?.dirty === undefined ? {} : { dirty: build.dirty }),
    };
  }
  const source = image;
  const configuredDigest = imageDigestFromReference(source);
  const actualDigests = imageRepoDigests(imageId);
  if (isLocalDockerTextOnlyProfile(ctx.config) && configuredDigest && !actualDigests.includes(configuredDigest)) {
    throw new CliError(`docker container ${cname(ctx, service)} does not match its required image digest`);
  }
  const releaseDigest = configuredDigest ?? actualDigests[0];
  if (isLocalDockerTextOnlyProfile(ctx.config) && !releaseDigest) {
    throw new CliError(
      `local Docker text-only profile requires ${service} to use a digest-pinned release image, or run with --build-from`,
    );
  }
  return {
    kind: "release",
    source,
    imageId,
    ...(releaseDigest ? { releaseDigest } : {}),
  };
}

function recordDockerImageEvidence(
  ctx: DockerCtx,
  service: string,
  evidence: DeploymentImageEvidence,
): void {
  const state = readDeploymentState(ctx.config.orgId);
  writeDeploymentState({
    ...state,
    orgId: ctx.config.orgId,
    network: ctx.network,
    images: { ...(state?.images ?? {}), [service]: evidence },
  });
}

function resolvePluginImage(ctx: DockerCtx, p: ResolvedPlugin): string {
  if (p.kind === "source") {
    const tag = `${ctx.prefix}-${p.name}:local`;
    step(`building plugin ${p.name} from ${p.dockerfile}`);
    dockerInherit(["build", "-f", p.dockerfile!, "-t", tag, p.sourceDir!]);
    return tag;
  }
  step(`pulling plugin ${p.name} (${p.image})`);
  dockerInherit(["pull", p.image!], `failed to pull ${p.image} for plugin ${p.name}.`);
  return p.image!;
}

function ensureNetwork(ctx: DockerCtx): void {
  docker(["network", "create", ctx.network], /already exists/);
}

function persistRestart(name: string): void {
  docker(["update", "--restart", "unless-stopped", name]);
}

function externalDatabaseUrl(ctx: DockerCtx): string | undefined {
  return process.env.DATABASE_URL ?? readEnvValue(ctx.envFile, "DATABASE_URL");
}

function ensurePostgres(ctx: DockerCtx, dryRun: boolean): string {
  const fromEnv = externalDatabaseUrl(ctx);
  if (fromEnv) {
    step("Postgres: using DATABASE_URL from the environment");
    return fromEnv;
  }

  const pgName = cname(ctx, "pg");
  const image = dockerPostgresImage(ctx.config);
  const url = (password: string): string => `postgres://postgres:${password}@pg:5432/qm`;

  if (dryRun) {
    step(`Postgres: would run ${pgName} (image ${image}, volume ${pgVolume(ctx)})`);
    return url(readDeploymentState(ctx.config.orgId)?.pgPassword ?? "<generated>");
  }
  return withDeploymentLock(ctx.config.orgId, () => {
    const state = readDeploymentState(ctx.config.orgId);
    let password: string;
    const existing = pgContainerPassword(ctx);
    if (existing) {
      password = existing;
    } else if (volumeExists(pgVolume(ctx))) {
      if (!state?.pgPassword) {
        throw new CliError(
          `Postgres volume ${pgVolume(ctx)} exists but its password is unknown (deployment state missing). ` +
            `Set DATABASE_URL to point at it, or 'qm down --purge' to recreate it (DESTROYS data).`,
        );
      }
      password = state.pgPassword;
    } else {
      password = state?.pgPassword ?? randomBytes(16).toString("hex");
    }

    const stateOut: DeploymentState = { ...state, orgId: ctx.config.orgId, network: ctx.network, pgPassword: password };
    writeDeploymentState(stateOut);

    if (!containerRunning(pgName)) {
      step(`Postgres: starting ${pgName}`);
      docker(["rm", "-f", pgName], /No such container|is not running/);
      const secretFile = writeSecretEnvFile({ POSTGRES_PASSWORD: password });
      try {
        docker([
          "run",
          "-d",
          "--name",
          pgName,
          ...orgLabelArgs(ctx),
          "--network",
          ctx.network,
          "--network-alias",
          "pg",
          "--restart",
          "no",
          "--env-file",
          secretFile.path,
          "-e",
          "POSTGRES_DB=qm",
          "-v",
          `${pgVolume(ctx)}:/var/lib/postgresql/data`,
          image,
        ]);
      } finally {
        secretFile.cleanup();
      }
    }
    return url(password);
  });
}

async function waitPostgres(ctx: DockerCtx): Promise<void> {
  for (let i = 0; i < 60; i++) {
    try {
      docker(["exec", cname(ctx, "pg"), "pg_isready", "-U", "postgres"]);
      persistRestart(cname(ctx, "pg"));
      return;
    } catch {
      await sleep(1000);
    }
  }
  throw new CliError("Postgres did not become ready in 60s");
}

function readEnvValue(envFile: string | undefined, key: string): string | undefined {
  if (!envFile) return undefined;
  return readEnvFile(envFile).get(key);
}

function secretValues(ctx: DockerCtx, service: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const secret of secretsForService(ctx.config, service)) {
    if (secret.managedBy === "terraform" && service === "core") continue;
    if (
      isLocalDockerTextOnlyProfile(ctx.config) && localDockerHostOnlyEnvNames.has(secret.name)
    ) {
      continue;
    }
    const fileValue = readEnvValue(ctx.envFile, secret.name);
    const value = deploymentSecretValue(secret.name, fileValue);
    if (value === undefined) continue;
    for (const name of runtimeSecretNames(service, secret)) {
      if (name !== `FLY_RESIDENT_ENV_${secret.name}`) out[name] = value;
    }
  }
  return out;
}

export function dockerServiceEnv(config: QmConfig, service: ServiceName): Record<string, string> {
  const def = serviceDef(service);
  const out: Record<string, string> = {
    [def.docker.portEnv]: String(def.docker.internalPort),
    CORE_API_URL: "http://core:8080",
    ...orgEnv(service, config.orgId, config.publicUrl, config.services.includes("portal")),
  };
  if (service === "portal") {
    if (config.services.includes("web-ui")) out.WEB_UI_UPSTREAM = "http://web-ui:8080";
    if (config.services.includes("admin")) out.ADMIN_UPSTREAM = "http://admin:8080";
  }
  if (config.services.includes("auth")) {
    Object.assign(
      out,
      brokerWiring(service, {
        publicUrl: config.publicUrl,
        authBaseUrl: "http://auth:8080",
        ...(config.env.auth?.AUTH_ALLOWED_EMAIL_DOMAIN
          ? { allowedEmailDomain: config.env.auth.AUTH_ALLOWED_EMAIL_DOMAIN }
          : {}),
      }),
    );
  }
  return out;
}

function serviceEnv(ctx: DockerCtx, service: ServiceName): Record<string, string> {
  const { config } = ctx;
  const out: Record<string, string> = {};
  if (ctx.signingSecret) out.CORE_SIGNING_SECRET = ctx.signingSecret;
  if (service === "core") {
    Object.assign(out, orgEnv("core", config.orgId, config.publicUrl, config.services.includes("portal")));
    out.PORT = "8080";
    out.DATA_DIR = "/data";
    out.SESSION_STORE = "postgres";
    out.RUN_STORE = "postgres";
    out.DATABASE_URL = ctx.databaseUrl;
    if (config.model) out.PI_MODEL = config.model;
    if (config.modelProvider) out.MODEL_PROVIDER = config.modelProvider;
    if (!isSandboxDisabled(config)) {
      const layerSubs = existingLayerSubdirs(ctx);
      if (layerSubs.length) out.DEPLOYMENT_LAYER = "/layer";
    }
    Object.assign(out, ctx.sandboxEnv);
  } else {
    Object.assign(out, dockerServiceEnv(config, service));
  }
  const virtualEnv = service === "core" ? virtualServiceEnv(config.services, config.env) : {};
  const env = {
    ...out,
    ...virtualEnv,
    ...config.env[service],
    ...(service === "core" ? securityScreenEnv(config) : {}),
    ...secretValues(ctx, service),
  };
  if (ctx.signingSecret) env.CORE_SIGNING_SECRET = ctx.signingSecret;
  if (service === "core") {
    env.DATABASE_URL = ctx.databaseUrl;
    if (config.sandbox?.backend === "disabled") {
      env.SANDBOX_BACKEND = "disabled";
      delete env.SANDBOX_SECONDARY_BACKEND;
    }
    for (const key of ctx.sandboxSecretKeys) {
      const value = out[key];
      if (value !== undefined) env[key] = value;
      else delete env[key];
    }
  }
  return env;
}

function secretEnvKeys(ctx: DockerCtx, service: string): Set<string> {
  const keys = new Set(Object.keys(secretValues(ctx, service)));
  if (ctx.signingSecret) keys.add("CORE_SIGNING_SECRET");
  if (service === "core") {
    keys.add("DATABASE_URL");
    for (const key of ctx.sandboxSecretKeys) keys.add(key);
  }
  return keys;
}

function writeSecretEnvFile(entries: Record<string, string>): { path: string; cleanup: () => void } {
  for (const [key, value] of Object.entries(entries)) {
    if (/[\r\n]/.test(value)) {
      throw new CliError(
        `secret ${key} contains a newline — docker --env-file is line-based and cannot carry it. ` +
          `Provide a single-line value (e.g. base64-encode PEM keys and decode in the consumer).`,
      );
    }
  }
  const dir = mkdtempSync(join(tmpdir(), "qm-env-"));
  const path = join(dir, "secrets.env");
  writeFileSync(
    path,
    `${Object.entries(entries)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n")}\n`,
    { mode: 0o600 },
  );
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function pushEnvArgs(args: string[], env: Record<string, string>, secretKeys: Set<string>): () => void {
  const secrets: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (secretKeys.has(k)) secrets[k] = v;
    else args.push("-e", `${k}=${v}`);
  }
  if (!Object.keys(secrets).length) return () => {};
  const file = writeSecretEnvFile(secrets);
  args.push("--env-file", file.path);
  return file.cleanup;
}

function runArgs(ctx: DockerCtx, service: ServiceName, image: string): { args: string[]; cleanup: () => void } {
  const def = serviceDef(service);
  const args = [
    "run",
    "-d",
    "--name",
    cname(ctx, service),
    ...orgLabelArgs(ctx),
    "--network",
    ctx.network,
    "--network-alias",
    service,
    "--restart",
    "no",
  ];
  const cleanup = pushEnvArgs(args, serviceEnv(ctx, service), secretEnvKeys(ctx, service));
  if (service === "core") {
    args.push("-v", `${ctx.prefix}-coredata:/data`);
    if (!isSandboxDisabled(ctx.config)) {
      for (const m of layerMounts(ctx)) args.push("-v", m);
      for (const m of skillMounts(ctx)) args.push("-v", m);
    }
  }
  if (def.docker.hostPortOffset !== undefined) {
    args.push("-p", `127.0.0.1:${baseHostPort(ctx) + def.docker.hostPortOffset}:${def.docker.internalPort}`);
  }
  args.push(image);
  return { args, cleanup };
}

function skillMounts(ctx: DockerCtx): string[] {
  return ctx.config.skills.map((s, i) => `${resolve(ctx.configDir, s)}:/app/plugins/deployment-skills-${i}/skills:ro`);
}

function existingLayerSubdirs(ctx: DockerCtx): Array<"skills" | "tools"> {
  return (["skills", "tools"] as const).filter((s) => existsSync(join(ctx.sandboxDir, s)));
}

function layerMounts(ctx: DockerCtx): string[] {
  return existingLayerSubdirs(ctx).map((sub) => `${join(ctx.sandboxDir, sub)}:/layer/${sub}:ro`);
}

function noteLogTail(name: string, logs: string): void {
  note(`--- ${name} logs (tail) ---`);
  note(tailString(logs, 25));
}

export function defaultLoopbackHealthProbe(url: string): Promise<boolean> {
  const target = new URL(url);
  const port = Number(target.port);
  if (
    target.protocol !== "http:" ||
    target.hostname !== "127.0.0.1" ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535
  ) {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    let settled = false;
    let socket: ReturnType<typeof connect> | undefined;
    const finish = (healthy: boolean): void => {
      if (settled) return;
      settled = true;
      socket?.removeAllListeners();
      socket?.destroy();
      resolve(healthy);
    };
    let response = "";
    try {
      socket = connect({ host: "127.0.0.1", port, family: 4 });
      socket.once("connect", () => {
        socket?.write(
          `GET ${target.pathname}${target.search} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`,
        );
      });
      socket.on("data", (chunk: Buffer) => {
        response += chunk.toString("latin1");
        const end = response.indexOf("\r\n");
        if (end === -1) return;
        finish(/^HTTP\/1\.[01] 2\d\d(?:\s|$)/.test(response.slice(0, end)));
      });
      socket.once("error", () => finish(false));
      socket.once("close", () => finish(false));
      socket.setTimeout(2_000, () => finish(false));
    } catch {
      finish(false);
    }
  });
}

async function waitReady(ctx: DockerCtx, service: ServiceName): Promise<void> {
  const def = serviceDef(service);
  const name = cname(ctx, service);
  const hostPort = def.docker.hostPortOffset === undefined ? undefined : baseHostPort(ctx) + def.docker.hostPortOffset;
  const healthUrl = hostPort === undefined ? undefined : `http://127.0.0.1:${hostPort}/healthz`;
  for (let i = 0; i < 90; i++) {
    try {
      if (healthUrl) {
        if (isLocalDockerTextOnlyProfile(ctx.config)) {
          if (!(await ctx.loopbackHealthProbe(healthUrl))) throw new Error("loopback health probe failed");
        } else {
          const response = await ctx.fetchImpl(healthUrl, { signal: AbortSignal.timeout(2_000) });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
        }
      } else {
        docker([
          "exec",
          name,
          "node",
          "--input-type=module",
          "-e",
          "const response = await fetch('http://127.0.0.1:8080/healthz'); process.exit(response.ok ? 0 : 1)",
        ]);
      }
      persistRestart(name);
      return;
    } catch {
      void 0;
    }
    if (!containerRunning(name)) {
      noteLogTail(name, captureBoth("docker", ["logs", name]));
      throw new CliError(`${service} exited before becoming ready (see logs above)`);
    }
    await sleep(1000);
  }
  throw new CliError(
    `${service} did not respond successfully to ${healthUrl ?? "its internal /healthz endpoint"} in 90s`,
  );
}

export function defaultIpv6Probe(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let socket: ReturnType<typeof connect> | undefined;
    const finish = (reachable: boolean): void => {
      if (settled) return;
      settled = true;
      socket?.removeAllListeners();
      socket?.destroy();
      resolve(reachable);
    };
    try {
      socket = connect({ host: "::1", port, family: 6 });
      socket.once("connect", () => finish(true));
      socket.once("error", () => finish(false));
      socket.setTimeout(2_000, () => finish(false));
    } catch {
      finish(false);
    }
  });
}

async function assertLocalDockerLoopbackPublish(ctx: DockerCtx, service: ServiceName): Promise<void> {
  if (!isLocalDockerTextOnlyProfile(ctx.config)) return;
  const def = serviceDef(service);
  if (def.docker.hostPortOffset === undefined) return;
  const hostPort = baseHostPort(ctx) + def.docker.hostPortOffset;
  const raw = docker(["inspect", "--format", "{{json .NetworkSettings.Ports}}", cname(ctx, service)]);
  let ports: unknown;
  try {
    ports = JSON.parse(raw);
  } catch {
    throw new CliError(`docker inspect returned invalid published-port data for ${service}`);
  }
  const bindings =
    typeof ports === "object" && ports !== null
      ? (ports as Record<string, unknown>)[`${def.docker.internalPort}/tcp`]
      : undefined;
  if (!Array.isArray(bindings) || bindings.length !== 1) {
    throw new CliError(`docker inspect did not report one published loopback port for ${service}`);
  }
  const binding = bindings[0];
  if (
    typeof binding !== "object" ||
    binding === null ||
    (binding as Record<string, unknown>).HostIp !== "127.0.0.1" ||
    (binding as Record<string, unknown>).HostPort !== String(hostPort)
  ) {
    throw new CliError(`docker inspect shows ${service} is not published only as 127.0.0.1:${hostPort}`);
  }
  if (await ctx.ipv6Probe(hostPort)) {
    throw new CliError(`local Docker text-only profile unexpectedly accepts IPv6 connections on [::1]:${hostPort}`);
  }
}

async function waitPluginUp(name: string): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await sleep(1000);
    if (!containerRunning(name)) {
      noteLogTail(name, captureBoth("docker", ["logs", name]));
      throw new CliError(`plugin ${name} exited on boot (see logs above) — check the image and its env`);
    }
  }
  persistRestart(name);
}

function buildCtx(
  config: QmConfig,
  configDir: string,
  opts: {
    sandboxDir?: string;
    buildFrom: boolean;
    buildFromPath?: string;
    envFile?: string;
    fetchImpl?: typeof fetch;
    ipv6Probe?: Ipv6Probe;
    loopbackHealthProbe?: LoopbackHealthProbe;
  },
): DockerCtx {
  const prefix = dockerPrefix(config);
  const envFile = opts.envFile ? resolve(opts.envFile) : join(configDir, ".env");
  if (opts.envFile && !existsSync(envFile)) throw new CliError(`--env-file not found: ${opts.envFile}`);
  const ctx: DockerCtx = {
    config,
    configDir,
    sandboxDir: resolve(opts.sandboxDir ?? join(configDir, "sandbox")),
    network: prefix,
    prefix,
    databaseUrl: "",
    sandboxEnv: {},
    sandboxSecretKeys: new Set((config.sandbox?.secretEnv ?? []).map((name) => `FLY_RESIDENT_ENV_${name}`)),
    missingSandboxSecrets: [],
    buildFrom: opts.buildFrom,
    fetchImpl: opts.fetchImpl ?? fetch,
    ipv6Probe: opts.ipv6Probe ?? defaultIpv6Probe,
    loopbackHealthProbe: opts.loopbackHealthProbe ?? defaultLoopbackHealthProbe,
  };
  if (existsSync(envFile)) ctx.envFile = envFile;
  if (isLocalDockerTextOnlyProfile(config) && externalDatabaseUrl(ctx)) {
    throw new CliError("local Docker text-only profile does not allow DATABASE_URL; it always starts its local Postgres container");
  }
  const signingSecret = deploymentSecretValue("CORE_SIGNING_SECRET", readEnvValue(ctx.envFile, "CORE_SIGNING_SECRET"));
  if (signingSecret) ctx.signingSecret = signingSecret;
  const lookup = (name: string): string | undefined => deploymentSecretValue(name, readEnvValue(ctx.envFile, name));
  const sb = sandboxCoreEnv(config, lookup);
  ctx.sandboxEnv = sb.env;
  ctx.missingSandboxSecrets = sb.missingSecrets;
  if (opts.buildFrom) {
    ctx.repoRoot = resolveBuildRepoRoot(opts.buildFromPath, runnableServices(config.services));
    const build = sourceBuildInfo(ctx.repoRoot);
    if (isLocalDockerTextOnlyProfile(config) && (!build.gitCommit || build.dirty === undefined)) {
      throw new CliError("local Docker text-only source builds require a Git checkout with readable HEAD and dirty state");
    }
    ctx.buildInfo = build;
  }
  return ctx;
}

function assertLocalDockerTextOnlySecretSeparation(ctx: DockerCtx): void {
  if (!isLocalDockerTextOnlyProfile(ctx.config)) return;
  const namesByValue = new Map<string, string[]>();
  for (const name of localDockerDistinctSecretNames) {
    const value = deploymentSecretValue(name, readEnvValue(ctx.envFile, name))?.trim();
    if (!value) continue;
    namesByValue.set(value, [...(namesByValue.get(value) ?? []), name]);
  }
  const reused = [...namesByValue.values()].find((names) => names.length > 1);
  if (reused) {
    throw new CliError(`local Docker text-only profile requires distinct secret values for ${reused.join(", ")}`);
  }
}

function warnUnforwardedEnvKeys(ctx: DockerCtx): void {
  if (!ctx.envFile) return;
  const injected = new Set(computedSecrets(ctx.config).map((secret) => secret.name));
  const blocked = isLocalDockerTextOnlyProfile(ctx.config) ? localDockerHostOnlyEnvNames : new Set<string>();
  injected.add("CORE_SIGNING_SECRET");
  injected.add("DATABASE_URL");
  const dropped = [...readEnvFile(ctx.envFile).keys()].filter((key) => blocked.has(key) || !injected.has(key));
  if (!dropped.length) return;
  warn(
    `.env keys not forwarded to any container: ${dropped.join(", ")} — only computed secret names are ` +
      `injected. Move non-secret settings to "env.<service>" in the QM deployment config.`,
  );
}

function missingRequiredOperatorSecrets(ctx: DockerCtx): string[] {
  const lookup = (name: string): string | undefined => deploymentSecretValue(name, readEnvValue(ctx.envFile, name));
  return computedSecrets(ctx.config)
    .filter(
      (secret) =>
        secret.required && secret.managedBy === "operator" && isInvalidSecret(secret.name, lookup(secret.name)),
    )
    .map((secret) => secret.name);
}

export async function dockerUp(
  config: QmConfig,
  configDir: string,
  opts: {
    sandboxDir?: string;
    buildFrom?: boolean;
    buildFromPath?: string;
    envFile?: string;
    dryRun?: boolean;
    fetchImpl?: typeof fetch;
    ipv6Probe?: Ipv6Probe;
    loopbackHealthProbe?: LoopbackHealthProbe;
  } = {},
): Promise<void> {
  validateLocalDockerTextOnlyProfile(config, "local Docker configuration");
  if (!opts.dryRun) requireDocker();
  if (!opts.dryRun) assertLocalDockerDaemon(config);
  const ctx = buildCtx(config, configDir, {
    sandboxDir: opts.sandboxDir,
    buildFrom: opts.buildFrom ?? false,
    buildFromPath: opts.buildFromPath,
    envFile: opts.envFile,
    fetchImpl: opts.fetchImpl,
    ipv6Probe: opts.ipv6Probe,
    loopbackHealthProbe: opts.loopbackHealthProbe,
  });
  assertLocalDockerTextOnlySecretSeparation(ctx);
  const plugins = discoverPlugins(configDir, config).plugins;
  if (isSandboxDisabled(config) && plugins.length) {
    throw new CliError("a disabled sandbox does not allow plugins");
  }
  if (isSandboxDisabled(config) && existingLayerSubdirs(ctx).length) {
    throw new CliError("a disabled sandbox does not allow a sandbox layer");
  }

  header(`qm up — ${config.orgId} (target: docker${opts.buildFrom ? ", build-from-source" : ""})`);
  if (opts.dryRun) note(bold("DRY RUN — no containers will be started.\n"));
  warnUnforwardedEnvKeys(ctx);
  for (const name of ctx.missingSandboxSecrets) {
    warn(`sandbox.secretEnv "${name}" has no value in .env or the environment — it won't be set in the sandbox.`);
  }
  const missingRequired = missingRequiredOperatorSecrets(ctx);
  if (opts.dryRun && missingRequired.length) {
    warn(`MISSING required secrets — add them to .env before up: ${missingRequired.join(", ")}`);
  }

  if (opts.dryRun) {
    ctx.databaseUrl = ensurePostgres(ctx, true);
    step(`network: ${ctx.network}`);
    for (const def of ordered(runnableServices(config.services))) {
      const ports =
        def.docker.hostPortOffset !== undefined ? ` (host :${baseHostPort(ctx) + def.docker.hostPortOffset})` : "";
      step(
        `${def.name}: image ${ctx.buildFrom ? `build deploy/${def.name}/Dockerfile` : imageRef(ctx, def.name)}${ports}`,
      );
      note(`     env: ${Object.keys(serviceEnv(ctx, def.name)).join(", ") || "(none)"}`);
      if (def.name === "core") {
        if (isSandboxDisabled(config)) note("     layer: disabled");
        else {
          const subs = existingLayerSubdirs(ctx);
          note(
            `     layer: ${subs.length ? `${ctx.sandboxDir} → /layer (${subs.join(", ")})` : `(no skills/ or tools/ in ${ctx.sandboxDir})`}`,
          );
        }
      }
    }
    for (const p of plugins) {
      step(
        p.kind === "image"
          ? `plugin ${p.name}: pull ${p.image}`
          : `plugin ${p.name}: build plugins/${p.name}/Dockerfile`,
      );
    }
    note("\n" + bold("Plan only. Re-run without --dry-run to apply."));
    return;
  }

  if (missingRequired.length) {
    throw new CliError(
      `required secrets have no value in ./.env or the environment: ${missingRequired.join(", ")}\n` +
        `Add them to .env (see .env.example; generate signing secrets with: openssl rand -hex 32).`,
    );
  }

  ensureNetwork(ctx);
  ctx.databaseUrl = ensurePostgres(ctx, false);
  if (!externalDatabaseUrl(ctx)) {
    await waitPostgres(ctx);
    recordDockerImageEvidence(ctx, "pg", dockerImageEvidence(ctx, "pg", dockerPostgresImage(config)));
  }

  for (const def of ordered(runnableServices(config.services))) {
    const image = resolveImage(ctx, def.name);
    docker(["rm", "-f", cname(ctx, def.name)], /No such container|is not running/);
    step(`starting ${def.name}`);
    const run = runArgs(ctx, def.name, image);
    try {
      docker(run.args);
    } finally {
      run.cleanup();
    }
    await waitReady(ctx, def.name);
    await assertLocalDockerLoopbackPublish(ctx, def.name);
    recordDockerImageEvidence(ctx, def.name, dockerImageEvidence(ctx, def.name, image));
    ok(`${def.name} ready`);
    if (isLocalDockerTextOnlyProfile(config)) {
      note(`     loopback: 127.0.0.1:${baseHostPort(ctx) + def.docker.hostPortOffset!}; [::1] not listening`);
    }
  }

  for (const p of plugins) {
    const image = resolvePluginImage(ctx, p);
    docker(["rm", "-f", cname(ctx, p.name)], /No such container|is not running/);
    step(`starting plugin ${p.name} (${image})`);
    const args = [
      "run",
      "-d",
      "--name",
      cname(ctx, p.name),
      ...orgLabelArgs(ctx),
      "--network",
      ctx.network,
      "--network-alias",
      p.name,
      "--restart",
      "no",
    ];
    const wiring = {
      CORE_API_URL: "http://core:8080",
      ...orgEnv(p.name, config.orgId, config.publicUrl, config.services.includes("portal")),
      PORT: "8080",
    };
    const env = {
      ...wiring,
      ...p.env,
      ...(ctx.signingSecret ? { CORE_SIGNING_SECRET: ctx.signingSecret } : {}),
      ...secretValues(ctx, p.name),
    };
    const cleanup = pushEnvArgs(args, env, secretEnvKeys(ctx, p.name));
    args.push(image);
    try {
      docker(args);
    } finally {
      cleanup();
    }
    await waitPluginUp(cname(ctx, p.name));
    ok(`plugin ${p.name} running`);
  }

  printUrls(ctx);
}

function printUrls(ctx: DockerCtx): void {
  note("");
  ok(`stack up — ${ctx.config.orgId}`);
  const has = (s: ServiceName): boolean => ctx.config.services.includes(s);
  const url = (s: ServiceName): string =>
    `http://127.0.0.1:${baseHostPort(ctx) + serviceDef(s).docker.hostPortOffset!}`;
  if (has("portal")) {
    note(`   portal : ${url("portal")}  (${isLocalDockerTextOnlyProfile(ctx.config) ? "health-only" : "public front door"})`);
  }
  if (has("auth"))
    note(`   auth   : ${url("portal")}/idp/authorize  (sign-in broker, published only through the portal)`);
  if (has("web-ui")) note(`   web-ui : ${url("web-ui")}`);
  if (has("admin")) note(`   admin  : ${url("admin")}/admin`);
  note(`   core   : ${url("core")}`);
  note(`   status : qm status   ·   logs: qm logs core   ·   stop: qm down`);
}

export function dockerStatus(config: QmConfig): void {
  requireDocker();
  assertLocalDockerDaemon(config);
  header(`qm status — ${config.orgId}`);
  dockerInherit([
    "ps",
    "-a",
    "--filter",
    `label=${ORG_LABEL_KEY}=${config.orgId}`,
    "--format",
    "table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}",
  ]);
  const names = listDeploymentContainers(config.orgId);
  if (names.length) {
    note("image content IDs:");
    for (const name of names) note(`   ${name}: ${docker(["inspect", "--format", "{{.Image}}", name]).trim()}`);
  }
  const prefix = dockerPrefix(config);
  note("volumes:");
  for (const name of [`${prefix}-pgdata`, `${prefix}-coredata`]) {
    note(`   ${name}: ${volumeExists(name) ? "present" : "absent"}`);
  }
  const evidence = readDeploymentState(config.orgId)?.images;
  if (evidence && Object.keys(evidence).length) {
    note("recorded image evidence:");
    for (const [service, image] of Object.entries(evidence).sort(([a], [b]) => a.localeCompare(b))) {
      const provenance =
        image.kind === "build-from"
          ? `build ${image.gitCommit}${image.dirty ? " (dirty)" : ""}`
          : `release ${image.releaseDigest ?? image.source}`;
      note(`   ${service}: ${provenance}; content ${image.imageId}`);
    }
  }
  if (config.services.includes("slack")) note("slack: virtual service running in the core container");
}

function psNames(args: string[]): string[] {
  return docker(["ps", ...args, "--format", "{{.Names}}"])
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

function listDeploymentContainers(orgId: string): string[] {
  return psNames(["-a", "--filter", `label=${ORG_LABEL_KEY}=${orgId}`]);
}

export async function dockerLogs(config: QmConfig, service: string | undefined, opts: LogOpts = {}): Promise<void> {
  requireDocker();
  assertLocalDockerDaemon(config);
  const prefix = dockerPrefix(config);
  const tail = String(opts.tail ?? 200);

  if (service) {
    const resolved = service === "slack" ? "core" : service;
    if (service === "slack") note("slack is a virtual service; showing core logs");
    const name = `${prefix}-${resolved}`;
    if (!containerExists(name)) die(`no container ${name} (is the stack up? services: ${config.services.join(", ")})`);
    const args = ["logs", "--tail", tail];
    if (opts.follow) args.push("-f");
    args.push(name);
    dockerInherit(args);
    return;
  }

  const names = listDeploymentContainers(config.orgId);
  if (names.length === 0) die(`no containers for ${config.orgId} (is the stack up? run \`qm up\`)`);
  await streamPrefixedLogs(names, prefix, { follow: opts.follow ?? false, tail });
}

function streamPrefixedLogs(names: string[], prefix: string, opts: { follow: boolean; tail: string }): Promise<void> {
  return streamLabeled(
    names.map((name) => ({
      label: name.slice(prefix.length + 1),
      command: "docker",
      args: ["logs", "--tail", opts.tail, ...(opts.follow ? ["-f"] : []), name],
    })),
    (label, line) => note(`${dim(label)} | ${line}`),
  );
}

export async function dockerDown(config: QmConfig, opts: { purge?: boolean } = {}): Promise<void> {
  requireDocker();
  assertLocalDockerDaemon(config);
  const prefix = dockerPrefix(config);
  header(`qm down — ${config.orgId}`);
  const serviceNames = teardownOrdered(runnableServices(config.services)).map((d) => `${prefix}-${d.name}`);
  const pgName = `${prefix}-pg`;
  const known = new Set([...serviceNames, pgName]);
  const pluginNames = [
    ...new Set([
      ...config.plugins.map((p) => `${prefix}-${p.name}`),
      ...listDeploymentContainers(config.orgId).filter((n) => !known.has(n)),
    ]),
  ];
  const candidates = [...pluginNames, ...serviceNames, pgName];
  const present = new Set(psNames(["-a"]));
  for (const name of candidates) {
    if (!present.has(name)) continue;
    step(`removing ${name}`);
    docker(["rm", "-f", name], /No such container/);
  }
  if (opts.purge) {
    warn("purging the network and Postgres volume (durable data will be lost)");
    docker(["network", "rm", prefix], /not found|No such/);
    docker(["volume", "rm", `${prefix}-pgdata`, `${prefix}-coredata`], /No such volume|not found|in use/);
  }
  ok("down.");
}
