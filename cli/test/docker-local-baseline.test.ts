import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_FILENAME, D0_LOCAL_POSTGRES_IMAGE, loadConfigAt, type QmConfig } from "../src/config.ts";
import { dockerUp } from "../src/backends/docker.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function fakeDocker(dir: string): { argv: string; env: string } {
  const argv = join(dir, "docker-argv.log");
  const env = join(dir, "docker-env.log");
  const state = join(dir, "docker-state.json");
  const bin = join(dir, "docker");
  writeFileSync(argv, "");
  writeFileSync(env, "");
  writeFileSync(state, "{}");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(argv)}, JSON.stringify(args) + "\\n");
const readState = () => JSON.parse(fs.readFileSync(${JSON.stringify(state)}, "utf8"));
const writeState = (next) => fs.writeFileSync(${JSON.stringify(state)}, JSON.stringify(next));
const imageId = (value) => {
  const marker = value.includes("core") ? "a" : value.includes("web-ui") ? "b" : value.includes("admin") ? "c" : "d";
  return "sha256:" + marker.repeat(64);
};
if (args[0] === "version") { console.log("25.0"); process.exit(0); }
if (args[0] === "context") { console.log("unix:///tmp/qm-test.sock"); process.exit(0); }
if (args[0] === "inspect") {
  if (args.includes("{{json .NetworkSettings.Ports}}")) {
    const binding = readState()[args.at(-1)];
    console.log(JSON.stringify(binding ? { [binding.internalPort + "/tcp"]: [{ HostIp: binding.hostIp, HostPort: binding.hostPort }] } : {}));
    process.exit(0);
  }
  if (args.includes("{{.Image}}")) { console.log(imageId(args.at(-1))); process.exit(0); }
  if (String(args.at(-1)).endsWith("-pg")) { console.error("No such object"); process.exit(1); }
  console.log("true");
  process.exit(0);
}
if (args[0] === "image" && args[1] === "inspect") {
  console.log(JSON.stringify([
    "registry.invalid/qm/qm-core@sha256:" + "a".repeat(64),
    ${JSON.stringify(D0_LOCAL_POSTGRES_IMAGE)}
  ]));
  process.exit(0);
}
if (args[0] === "volume") { console.error("No such volume"); process.exit(1); }
if (args[0] === "run") {
  const name = args[args.indexOf("--name") + 1];
  const publishIndex = args.indexOf("-p");
  const publish = publishIndex === -1 ? undefined : args[publishIndex + 1];
  if (name && publish) {
    const [hostIp, hostPort, internalPort] = publish.split(":");
    writeState({ ...readState(), [name]: { hostIp, hostPort, internalPort } });
  }
  const i = args.indexOf("--env-file");
  if (i !== -1) fs.appendFileSync(${JSON.stringify(env)}, fs.readFileSync(args[i + 1], "utf8") + "---\\n");
  console.log("cid");
  process.exit(0);
}
process.exit(0);
`,
  );
  chmodSync(bin, 0o755);
  return { argv, env };
}

test(
  "Docker local text-only profile starts only its five-container control plane on loopback",
  { timeout: 30_000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "qm-docker-local-"));
    const xdg = mkdtempSync(join(tmpdir(), "qm-docker-local-xdg-"));
    const priorPath = process.env.PATH;
    const priorXdg = process.env.XDG_CONFIG_HOME;
    const priorDatabaseUrl = process.env.DATABASE_URL;
    const priorBasePort = process.env.QM_BASE_PORT;
    const priorDockerHost = process.env.DOCKER_HOST;
    const requests: string[] = [];
    let fetchCalls = 0;
    const ipv6Ports: number[] = [];
    try {
      writeFileSync(
        join(dir, CONFIG_FILENAME),
        JSON.stringify({
          contract: 1,
          orgId: "localtest",
          publicUrl: "http://127.0.0.1:18129",
          target: "docker",
          basePort: 18128,
          services: ["core", "web-ui", "admin", "portal"],
          plugins: [],
          skills: [],
          sandbox: { backend: "disabled" },
          env: {
            core: {
              HARNESS: "pi",
              NODE_ENV: "production",
              TEXT_ONLY_MODE: "true",
              MEMORY_RECALL: "off",
              MEMORY_CAPTURE: "off",
            },
            portal: { NODE_ENV: "development" },
          },
          secretEnv: { core: { ADMIN_GRANTS: "ADMIN_GRANTS" } },
        }),
      );
      writeFileSync(
        join(dir, ".env"),
        [
          "CAPABILITY_SECRET=capability-secret",
          "CONNECTOR_SECRET_KEY=connector-secret-connector-secret",
          "CORE_SIGNING_SECRET=core-signing-secret-core-signing-secret",
          "PORTAL_IDENTITY_SECRET=portal-identity-secret",
          "SKILL_SIGNING_SECRET=skill-signing-secret-skill-signing-secret",
          "PORTAL_SESSION_SECRET=portal-session-secret-portal-session-secret",
          "ADMIN_GRANTS=local-admin:org_admin",
          "ANTHROPIC_API_KEY=stale-anthropic-key",
          "OPENAI_API_KEY=stale-openai-key",
          "OPENROUTER_API_KEY=stale-openrouter-key",
          "D0L_PROVIDER_API_KEY=stale-d0l-provider-key",
          "",
        ].join("\n"),
      );
      const dockerLog = fakeDocker(dir);
      process.env.PATH = `${dir}:${priorPath}`;
      process.env.XDG_CONFIG_HOME = xdg;
      delete process.env.DATABASE_URL;
      delete process.env.QM_BASE_PORT;
      delete process.env.DOCKER_HOST;
      const { config } = loadConfigAt(join(dir, CONFIG_FILENAME));
      await dockerUp(config, dir, {
        fetchImpl: async () => {
          fetchCalls++;
          return new Response(null, { status: 200 });
        },
        loopbackHealthProbe: async (url) => {
          requests.push(url);
          return true;
        },
        ipv6Probe: async (port) => {
          ipv6Ports.push(port);
          return false;
        },
      });

      const calls = readFileSync(dockerLog.argv, "utf8");
      const injected = readFileSync(dockerLog.env, "utf8");
      const recorded = JSON.parse(
        readFileSync(join(xdg, "qm", "deployments", "localtest", "state.json"), "utf8"),
      ) as {
        images?: Record<string, { kind?: string; releaseDigest?: string; imageId?: string }>;
      };
      for (const port of [18128, 18129, 18130, 18131]) {
        assert.match(calls, new RegExp(`127\\.0\\.0\\.1:${port}:8080`));
      }
      assert.doesNotMatch(calls, /\["logs"/, "readiness must not be inferred from container logs");
      assert.doesNotMatch(calls, /DEPLOYMENT_LAYER/);
      assert.doesNotMatch(calls, /\/layer\//);
      assert.doesNotMatch(calls, /deployment-skills/);
      assert.doesNotMatch(calls, /stale-anthropic-key|stale-openai-key|stale-openrouter-key|stale-d0l-provider-key/);
      assert.doesNotMatch(injected, /ANTHROPIC_API_KEY=|OPENAI_API_KEY=|OPENROUTER_API_KEY=|D0L_PROVIDER_API_KEY=/);
      assert.deepEqual(Object.keys(recorded.images ?? {}).sort(), ["admin", "core", "pg", "portal", "web-ui"]);
      for (const image of Object.values(recorded.images ?? {})) {
        assert.equal(image.kind, "release");
        assert.match(image.releaseDigest ?? "", /^sha256:[a-f0-9]{64}$/);
        assert.match(image.imageId ?? "", /^sha256:[a-f0-9]{64}$/);
      }
      assert.equal(requests.length, 4);
      assert.equal(fetchCalls, 0, "D0-L readiness must not use the proxy-aware fetch implementation");
      assert.deepEqual(ipv6Ports.sort((a, b) => a - b), [18128, 18129, 18130, 18131]);
      assert.deepEqual(
        new Set(requests),
        new Set([
          "http://127.0.0.1:18128/healthz",
          "http://127.0.0.1:18129/healthz",
          "http://127.0.0.1:18130/healthz",
          "http://127.0.0.1:18131/healthz",
        ]),
      );
      config.postgresImage = `postgres@sha256:${"e".repeat(64)}`;
      await assert.rejects(
        () => dockerUp(config, dir, { loopbackHealthProbe: async () => true, ipv6Probe: async () => false }),
        /docker container qm-localtest-pg does not match its required image digest/,
      );
    } finally {
      process.env.PATH = priorPath;
      if (priorXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = priorXdg;
      if (priorDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = priorDatabaseUrl;
      if (priorBasePort === undefined) delete process.env.QM_BASE_PORT;
      else process.env.QM_BASE_PORT = priorBasePort;
      if (priorDockerHost === undefined) delete process.env.DOCKER_HOST;
      else process.env.DOCKER_HOST = priorDockerHost;
      rmSync(dir, { recursive: true, force: true });
      rmSync(xdg, { recursive: true, force: true });
    }
  },
);

test("Docker local text-only profile fail-closes unsafe in-memory service environment", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-docker-local-host-key-"));
  const priorDatabaseUrl = process.env.DATABASE_URL;
  const priorBasePort = process.env.QM_BASE_PORT;
  try {
    delete process.env.DATABASE_URL;
    delete process.env.QM_BASE_PORT;
    writeFileSync(
      join(dir, CONFIG_FILENAME),
      JSON.stringify({
        contract: 1,
        orgId: "localhostkey",
        publicUrl: "http://127.0.0.1:18129",
        target: "docker",
        basePort: 18128,
        services: ["core", "web-ui", "admin", "portal"],
        plugins: [],
        skills: [],
        sandbox: { backend: "disabled" },
        env: {
          core: {
            HARNESS: "pi",
            NODE_ENV: "production",
            TEXT_ONLY_MODE: "true",
            MEMORY_RECALL: "off",
            MEMORY_CAPTURE: "off",
          },
          portal: { NODE_ENV: "development" },
        },
        secretEnv: { core: { ADMIN_GRANTS: "ADMIN_GRANTS" } },
      }),
    );
    for (const [service, values, error] of [
      ["web-ui", { OPENAI_API_KEY: "must-not-reach-a-container" }, /env\.web-ui\.OPENAI_API_KEY/],
      ["web-ui", { NODE_ENV: "test", ALLOW_UNSIGNED_TEST_IDENTITY: "1" }, /only permits env\.core/],
      ["web-ui", { CORE_API_URL: "http://not-core:8080" }, /only permits env\.core/],
      ["core", { CORE_API_URL: "http://not-core:8080" }, /only permits env\.core/],
    ] as const) {
      const { config } = loadConfigAt(join(dir, CONFIG_FILENAME));
      config.env[service] = { ...(config.env[service] ?? {}), ...values };
      await assert.rejects(() => dockerUp(config, dir, { dryRun: true }), error);
    }
    for (const [mutate, error] of [
      [(config: QmConfig) => (config.model = "builtin-model"), /selects its model only through host bootstrap/],
      [(config: QmConfig) => (config.modelProvider = "openai"), /selects its model only through host bootstrap/],
      [(config: QmConfig) => config.skills.push("./skills/not-allowed"), /does not allow "skills"/],
      [
        (config: QmConfig) => (config.secretEnv = { ...config.secretEnv, "web-ui": { LEAK: "OPENAI_API_KEY" } }),
        /only permits secretEnv\.core\.ADMIN_GRANTS/,
      ],
      [
        (config: QmConfig) => (config.sandbox = { ...config.sandbox, app: "must-not-be-used" }),
        /"sandbox\.backend": "disabled" does not allow "sandbox\.app"/,
      ],
      [(config: QmConfig) => (config.imageOverrides.core = "registry.example.test/qm-core:latest"), /digest-pinned/],
    ] as const) {
      const { config } = loadConfigAt(join(dir, CONFIG_FILENAME));
      mutate(config);
      await assert.rejects(() => dockerUp(config, dir, { dryRun: true }), error);
    }
  } finally {
    if (priorDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = priorDatabaseUrl;
    if (priorBasePort === undefined) delete process.env.QM_BASE_PORT;
    else process.env.QM_BASE_PORT = priorBasePort;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Docker local text-only profile rejects an external database URL", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-docker-local-db-"));
  const priorBasePort = process.env.QM_BASE_PORT;
  const priorDatabaseUrl = process.env.DATABASE_URL;
  try {
    delete process.env.QM_BASE_PORT;
    delete process.env.DATABASE_URL;
    writeFileSync(
      join(dir, CONFIG_FILENAME),
      JSON.stringify({
        contract: 1,
        orgId: "localdb",
        publicUrl: "http://127.0.0.1:18129",
        target: "docker",
        basePort: 18128,
        services: ["core", "web-ui", "admin", "portal"],
        plugins: [],
        skills: [],
        sandbox: { backend: "disabled" },
        env: {
          core: {
            HARNESS: "pi",
            NODE_ENV: "production",
            TEXT_ONLY_MODE: "true",
            MEMORY_RECALL: "off",
            MEMORY_CAPTURE: "off",
          },
          portal: { NODE_ENV: "development" },
        },
        secretEnv: { core: { ADMIN_GRANTS: "ADMIN_GRANTS" } },
      }),
    );
    writeFileSync(join(dir, ".env"), "DATABASE_URL=postgres://outside/qm\n");
    const { config } = loadConfigAt(join(dir, CONFIG_FILENAME));
    await assert.rejects(
      () => dockerUp(config, dir, { dryRun: true }),
      /local Docker text-only profile does not allow DATABASE_URL/,
    );
  } finally {
    if (priorBasePort === undefined) delete process.env.QM_BASE_PORT;
    else process.env.QM_BASE_PORT = priorBasePort;
    if (priorDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = priorDatabaseUrl;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Docker local text-only profile rejects reused control-plane secrets", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-docker-local-secrets-"));
  const priorBasePort = process.env.QM_BASE_PORT;
  try {
    delete process.env.QM_BASE_PORT;
    writeFileSync(
      join(dir, CONFIG_FILENAME),
      JSON.stringify({
        contract: 1,
        orgId: "localsecrets",
        publicUrl: "http://127.0.0.1:18129",
        target: "docker",
        basePort: 18128,
        services: ["core", "web-ui", "admin", "portal"],
        plugins: [],
        skills: [],
        sandbox: { backend: "disabled" },
        env: {
          core: {
            HARNESS: "pi",
            NODE_ENV: "production",
            TEXT_ONLY_MODE: "true",
            MEMORY_RECALL: "off",
            MEMORY_CAPTURE: "off",
          },
          portal: { NODE_ENV: "development" },
        },
        secretEnv: { core: { ADMIN_GRANTS: "ADMIN_GRANTS" } },
      }),
    );
    writeFileSync(
      join(dir, ".env"),
      [
        "CAPABILITY_SECRET=reused-local-secret",
        "CORE_SIGNING_SECRET=reused-local-secret",
        "PORTAL_IDENTITY_SECRET=portal-identity-secret",
        "CONNECTOR_SECRET_KEY=connector-secret-connector-secret",
        "SKILL_SIGNING_SECRET=skill-signing-secret-skill-signing-secret",
        "ADMIN_GRANTS=local-admin:org_admin",
        "",
      ].join("\n"),
    );
    const { config } = loadConfigAt(join(dir, CONFIG_FILENAME));
    await assert.rejects(
      () => dockerUp(config, dir, { dryRun: true }),
      /local Docker text-only profile requires distinct secret values for CAPABILITY_SECRET, CORE_SIGNING_SECRET/,
    );
  } finally {
    if (priorBasePort === undefined) delete process.env.QM_BASE_PORT;
    else process.env.QM_BASE_PORT = priorBasePort;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Docker local text-only profile rejects an IPv6 listener after its loopback inspect check", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-docker-local-ipv6-"));
  const xdg = mkdtempSync(join(tmpdir(), "qm-docker-local-ipv6-xdg-"));
  const priorPath = process.env.PATH;
  const priorXdg = process.env.XDG_CONFIG_HOME;
  const priorDockerHost = process.env.DOCKER_HOST;
  try {
    writeFileSync(
      join(dir, CONFIG_FILENAME),
      JSON.stringify({
        contract: 1,
        orgId: "localipv6",
        publicUrl: "http://127.0.0.1:18129",
        target: "docker",
        basePort: 18128,
        services: ["core", "web-ui", "admin", "portal"],
        plugins: [],
        skills: [],
        sandbox: { backend: "disabled" },
        env: {
          core: {
            HARNESS: "pi",
            NODE_ENV: "production",
            TEXT_ONLY_MODE: "true",
            MEMORY_RECALL: "off",
            MEMORY_CAPTURE: "off",
          },
          portal: { NODE_ENV: "development" },
        },
        secretEnv: { core: { ADMIN_GRANTS: "ADMIN_GRANTS" } },
      }),
    );
    writeFileSync(
      join(dir, ".env"),
      [
        "CAPABILITY_SECRET=capability-secret",
        "CONNECTOR_SECRET_KEY=connector-secret-connector-secret",
        "CORE_SIGNING_SECRET=core-signing-secret-core-signing-secret",
        "PORTAL_IDENTITY_SECRET=portal-identity-secret",
        "SKILL_SIGNING_SECRET=skill-signing-secret-skill-signing-secret",
        "PORTAL_SESSION_SECRET=portal-session-secret-portal-session-secret",
        "ADMIN_GRANTS=local-admin:org_admin",
        "",
      ].join("\n"),
    );
    fakeDocker(dir);
    process.env.PATH = `${dir}:${priorPath}`;
    process.env.XDG_CONFIG_HOME = xdg;
    delete process.env.DOCKER_HOST;
    const { config } = loadConfigAt(join(dir, CONFIG_FILENAME));
    await assert.rejects(
      () => dockerUp(config, dir, { loopbackHealthProbe: async () => true, ipv6Probe: async () => true }),
      /unexpectedly accepts IPv6 connections on \[::1\]:18128/,
    );
  } finally {
    process.env.PATH = priorPath;
    if (priorXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = priorXdg;
    if (priorDockerHost === undefined) delete process.env.DOCKER_HOST;
    else process.env.DOCKER_HOST = priorDockerHost;
    rmSync(dir, { recursive: true, force: true });
    rmSync(xdg, { recursive: true, force: true });
  }
});

test("Docker local text-only source builds record Git and image content evidence", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-docker-local-build-"));
  const xdg = mkdtempSync(join(tmpdir(), "qm-docker-local-build-xdg-"));
  const priorPath = process.env.PATH;
  const priorXdg = process.env.XDG_CONFIG_HOME;
  const priorDockerHost = process.env.DOCKER_HOST;
  try {
    writeFileSync(
      join(dir, CONFIG_FILENAME),
      JSON.stringify({
        contract: 1,
        orgId: "localbuild",
        publicUrl: "http://127.0.0.1:18129",
        target: "docker",
        basePort: 18128,
        services: ["core", "web-ui", "admin", "portal"],
        plugins: [],
        skills: [],
        sandbox: { backend: "disabled" },
        env: {
          core: {
            HARNESS: "pi",
            NODE_ENV: "production",
            TEXT_ONLY_MODE: "true",
            MEMORY_RECALL: "off",
            MEMORY_CAPTURE: "off",
          },
          portal: { NODE_ENV: "development" },
        },
        secretEnv: { core: { ADMIN_GRANTS: "ADMIN_GRANTS" } },
      }),
    );
    writeFileSync(
      join(dir, ".env"),
      [
        "CAPABILITY_SECRET=capability-secret",
        "CONNECTOR_SECRET_KEY=connector-secret-connector-secret",
        "CORE_SIGNING_SECRET=core-signing-secret-core-signing-secret",
        "PORTAL_IDENTITY_SECRET=portal-identity-secret",
        "SKILL_SIGNING_SECRET=skill-signing-secret-skill-signing-secret",
        "PORTAL_SESSION_SECRET=portal-session-secret-portal-session-secret",
        "ADMIN_GRANTS=local-admin:org_admin",
        "",
      ].join("\n"),
    );
    fakeDocker(dir);
    process.env.PATH = `${dir}:${priorPath}`;
    process.env.XDG_CONFIG_HOME = xdg;
    delete process.env.DOCKER_HOST;
    const { config } = loadConfigAt(join(dir, CONFIG_FILENAME));
    await dockerUp(config, dir, {
      buildFrom: true,
      buildFromPath: repoRoot,
      loopbackHealthProbe: async () => true,
      ipv6Probe: async () => false,
    });
    const recorded = JSON.parse(
      readFileSync(join(xdg, "qm", "deployments", "localbuild", "state.json"), "utf8"),
    ) as {
      images?: Record<
        string,
        { kind?: string; source?: string; releaseDigest?: string; gitCommit?: string; dirty?: unknown; imageId?: string }
      >;
    };
    assert.deepEqual(Object.keys(recorded.images ?? {}).sort(), ["admin", "core", "pg", "portal", "web-ui"]);
    const pg = recorded.images?.pg;
    assert.equal(pg?.kind, "release");
    assert.match(pg?.releaseDigest ?? "", /^sha256:[a-f0-9]{64}$/);
    assert.match(pg?.imageId ?? "", /^sha256:[a-f0-9]{64}$/);
    for (const [service, image] of Object.entries(recorded.images ?? {})) {
      if (service === "pg") continue;
      assert.equal(image.kind, "build-from");
      assert.equal(image.source, repoRoot);
      assert.match(image.gitCommit ?? "", /^[a-f0-9]{40}$/);
      assert.equal(typeof image.dirty, "boolean");
      assert.match(image.imageId ?? "", /^sha256:[a-f0-9]{64}$/);
    }
  } finally {
    process.env.PATH = priorPath;
    if (priorXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = priorXdg;
    if (priorDockerHost === undefined) delete process.env.DOCKER_HOST;
    else process.env.DOCKER_HOST = priorDockerHost;
    rmSync(dir, { recursive: true, force: true });
    rmSync(xdg, { recursive: true, force: true });
  }
});
