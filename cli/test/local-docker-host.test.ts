import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { verifyPortalIdentity } from "../../plugins/chassis/src/portal-identity.ts";
import { verifyPortalIdentity as verifyCorePortalIdentity } from "../../src/auth/portal-identity.ts";
import { CONFIG_FILENAME, loadConfigAt } from "../src/config.ts";
import {
  runLocalDockerBootstrap,
  runLocalDockerVerifier,
  type LocalCustomProviderInput,
} from "../src/commands/local-docker.ts";

const secrets = [
  "CAPABILITY_SECRET=capability-secret-capability-secret-capability-secret",
  "CONNECTOR_SECRET_KEY=connector-secret-connector-secret-connector-secret",
  "CORE_SIGNING_SECRET=core-signing-secret-core-signing-secret-core-signing-secret",
  "PORTAL_IDENTITY_SECRET=portal-identity-secret-portal-identity-secret",
  "SKILL_SIGNING_SECRET=skill-signing-secret-skill-signing-secret",
  "PORTAL_SESSION_SECRET=portal-session-secret-portal-session-secret",
  "ADMIN_GRANTS=local-admin:org_admin",
  "D0L_PROVIDER_API_KEY=provider-key-must-never-be-printed",
  "",
].join("\n");

const provider: LocalCustomProviderInput = {
  id: "deepseek-local",
  name: "DeepSeek",
  protocol: "openai",
  baseUrl: "https://api.deepseek.example/v1",
  model: {
    id: "deepseek-v4-flash",
    name: "DeepSeek V4 Flash",
    contextWindow: 128000,
    maxTokens: 8192,
  },
};

function fixture(basePort = 18128): { dir: string; envFile: string; config: ReturnType<typeof loadConfigAt>["config"] } {
  const dir = mkdtempSync(join(tmpdir(), "qm-d0l-host-"));
  writeFileSync(
    join(dir, CONFIG_FILENAME),
    JSON.stringify({
      contract: 1,
      orgId: "acme",
      publicUrl: `http://127.0.0.1:${basePort + 1}`,
      target: "docker",
      basePort,
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
  const envFile = join(dir, ".env");
  writeFileSync(envFile, secrets, { mode: 0o600 });
  chmodSync(envFile, 0o600);
  return { dir, envFile, config: loadConfigAt(join(dir, CONFIG_FILENAME)).config };
}

function startServer(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
}

function stopServer(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test("local Docker bootstrap dual-signs only the three allowed Core mutations", async () => {
  const f = fixture();
  const requests: Array<{ url: string; init: RequestInit }> = [];
  try {
    const result = await runLocalDockerBootstrap({
      config: f.config,
      configDir: f.dir,
      envFile: f.envFile,
      principal: "local-admin",
      provider,
      now: () => 1_000,
      fetchImpl: async (url, init) => {
        requests.push({ url: String(url), init: init ?? {} });
        return Response.json({ ok: true });
      },
    });
    assert.deepEqual(result, {
      coreUrl: "http://127.0.0.1:18128",
      modelId: "deepseek-v4-flash",
      providerId: "deepseek-local",
      scopeId: "org:acme",
    });
    assert.equal(requests.length, 3);
    for (const request of requests) {
      const headers = new Headers(request.init.headers);
      assert.equal(request.init.redirect, "manual");
      assert.match(headers.get("x-signature") ?? "", /^v0=/);
      assert.ok(headers.get("x-timestamp"));
      assert.equal(headers.get("x-admin-actor"), null);
      const identity = headers.get("x-portal-identity");
      assert.ok(identity);
      assert.equal(verifyPortalIdentity(identity!, "portal-identity-secret-portal-identity-secret", 1_000)?.p, "local-admin");
      assert.equal(
        (await verifyCorePortalIdentity(identity!, "portal-identity-secret-portal-identity-secret", 1_000))?.p,
        "local-admin",
      );
      assert.doesNotMatch(JSON.stringify([...headers]), /provider-key-must-never-be-printed/);
    }
    const first = JSON.parse(String(requests[0]!.init.body));
    const second = JSON.parse(String(requests[1]!.init.body));
    const third = JSON.parse(String(requests[2]!.init.body));
    assert.deepEqual(first, { ids: ["pi"] });
    assert.equal(second.apiKey, "provider-key-must-never-be-printed");
    assert.deepEqual(third, { harnessId: "pi", modelId: "deepseek-v4-flash" });
    assert.match(requests[0]!.url, /\/v1\/admin\/scopes\/org%3Aacme\/approved-harnesses\?d0l=/);
    assert.match(requests[1]!.url, /\/v1\/admin\/custom-providers\/deepseek-local\?d0l=/);
    assert.match(requests[2]!.url, /\/v1\/admin\/scopes\/org%3Aacme\/runtime\?d0l=/);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("local Docker bootstrap refuses a non-loopback target or an ungranted principal before mutation", async () => {
  const f = fixture();
  let calls = 0;
  try {
    await assert.rejects(
      () =>
        runLocalDockerBootstrap({
          config: f.config,
          configDir: f.dir,
          envFile: f.envFile,
          coreUrl: "http://localhost:18128",
          principal: "local-admin",
          provider,
          fetchImpl: async () => {
            calls++;
            return Response.json({ ok: true });
          },
        }),
      /loopback Core URL/,
    );
    await assert.rejects(
      () =>
        runLocalDockerBootstrap({
          config: f.config,
          configDir: f.dir,
          envFile: f.envFile,
          principal: "not-an-admin",
          provider,
          fetchImpl: async () => {
            calls++;
            return Response.json({ ok: true });
          },
        }),
      /ADMIN_GRANTS/,
    );
    assert.equal(calls, 0);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("local Docker host commands reject proxy configuration before any loopback request", async () => {
  const f = fixture();
  const originalHttpProxy = process.env.HTTP_PROXY;
  const originalNodeOptions = process.env.NODE_OPTIONS;
  const originalNodeUseEnvProxy = process.env.NODE_USE_ENV_PROXY;
  let calls = 0;
  process.env.HTTP_PROXY = "http://proxy.example.test:8080";
  try {
    await assert.rejects(
      () =>
        runLocalDockerBootstrap({
          config: f.config,
          configDir: f.dir,
          envFile: f.envFile,
          principal: "local-admin",
          provider,
          fetchImpl: async () => {
            calls++;
            return Response.json({ ok: true });
          },
        }),
      /proxy environment to be disabled/,
    );
    delete process.env.HTTP_PROXY;
    process.env.NODE_USE_ENV_PROXY = "1";
    await assert.rejects(
      () =>
        runLocalDockerVerifier({
          config: f.config,
          configDir: f.dir,
          envFile: f.envFile,
          principal: "local-admin",
          text: "hello",
          fetchImpl: async () => {
            calls++;
            return Response.json({ status: "queued", runId: "unexpected" });
          },
        }),
      /proxy environment to be disabled/,
    );
    delete process.env.NODE_USE_ENV_PROXY;
    process.env.NODE_OPTIONS = "--use-env-proxy";
    await assert.rejects(
      () =>
        runLocalDockerVerifier({
          config: f.config,
          configDir: f.dir,
          envFile: f.envFile,
          principal: "local-admin",
          text: "hello",
          fetchImpl: async () => {
            calls++;
            return Response.json({ status: "queued", runId: "unexpected" });
          },
        }),
      /proxy environment to be disabled/,
    );
    assert.equal(calls, 0);
  } finally {
    if (originalHttpProxy === undefined) delete process.env.HTTP_PROXY;
    else process.env.HTTP_PROXY = originalHttpProxy;
    if (originalNodeOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = originalNodeOptions;
    if (originalNodeUseEnvProxy === undefined) delete process.env.NODE_USE_ENV_PROXY;
    else process.env.NODE_USE_ENV_PROXY = originalNodeUseEnvProxy;
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("local Docker verifier sends only text and threadRef through loopback Web then requires a complete reply", async () => {
  const f = fixture();
  const requests: Array<{ url: string; init: RequestInit }> = [];
  try {
    const result = await runLocalDockerVerifier({
      config: f.config,
      configDir: f.dir,
      envFile: f.envFile,
      principal: "local-admin",
      text: "Reply with one word.",
      now: () => 1_000,
      sleep: async () => {},
      fetchImpl: async (url, init) => {
        requests.push({ url: String(url), init: init ?? {} });
        if (requests.length === 1) return Response.json({ status: "queued", runId: "run-1" }, { status: 202 });
        return Response.json({ status: "done", result: { status: "ok", reply: "done" }, replyComplete: true });
      },
    });
    assert.deepEqual(result, { runId: "run-1", reply: "done" });
    assert.equal(requests.length, 2);
    assert.equal(requests[0]!.url, "http://127.0.0.1:18130/api/turn");
    assert.deepEqual(JSON.parse(String(requests[0]!.init.body)), {
      text: "Reply with one word.",
      threadRef: "web:local-admin:d0l-smoke",
    });
    assert.equal(new Headers(requests[0]!.init.headers).get("x-signature"), null);
    assert.ok(new Headers(requests[0]!.init.headers).get("x-portal-identity"));
    assert.equal(requests[0]!.init.redirect, "manual");
    assert.equal(requests[1]!.url, "http://127.0.0.1:18130/api/runs/run-1");
    assert.equal(requests[1]!.init.redirect, "manual");
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("local Docker bootstrap surfaces the Core error body with the failure", async () => {
  const f = fixture();
  try {
    await assert.rejects(
      () =>
        runLocalDockerBootstrap({
          config: f.config,
          configDir: f.dir,
          envFile: f.envFile,
          principal: "local-admin",
          provider,
          fetchImpl: async () =>
            new Response(JSON.stringify({ error: "provider key rejected by upstream" }), {
              status: 400,
              headers: { "content-type": "application/json" },
            }),
        }),
      /approved harnesses failed with HTTP 400: \{"error":"provider key rejected by upstream"\}/,
    );
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("local Docker host commands refuse redirects without forwarding bootstrap or verifier payloads", async () => {
  const f = fixture();
  const bootstrapRequests: Array<{ url: string; init: RequestInit }> = [];
  const verifierRequests: Array<{ url: string; init: RequestInit }> = [];
  try {
    await assert.rejects(
      () =>
        runLocalDockerBootstrap({
          config: f.config,
          configDir: f.dir,
          envFile: f.envFile,
          principal: "local-admin",
          provider,
          fetchImpl: async (url, init) => {
            bootstrapRequests.push({ url: String(url), init: init ?? {} });
            return Response.redirect("https://not-loopback.example/collect", 307);
          },
        }),
      /approved harnesses failed with HTTP 307/,
    );
    assert.equal(bootstrapRequests.length, 1);
    assert.equal(bootstrapRequests[0]!.init.redirect, "manual");

    await assert.rejects(
      () =>
        runLocalDockerVerifier({
          config: f.config,
          configDir: f.dir,
          envFile: f.envFile,
          principal: "local-admin",
          text: "hello",
          fetchImpl: async (url, init) => {
            verifierRequests.push({ url: String(url), init: init ?? {} });
            return Response.redirect("https://not-loopback.example/collect", 307);
          },
        }),
      /turn was refused with HTTP 307/,
    );
    assert.equal(verifierRequests.length, 1);
    assert.equal(verifierRequests[0]!.init.redirect, "manual");
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("local Docker verifier bounds an unresponsive loopback Web request", async () => {
  const f = fixture();
  try {
    await assert.rejects(
      () =>
        runLocalDockerVerifier({
          config: f.config,
          configDir: f.dir,
          envFile: f.envFile,
          principal: "local-admin",
          text: "hello",
          timeoutMs: 1,
          fetchImpl: async () => new Promise<Response>(() => {}),
        }),
      /timed out before a complete reply/,
    );
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("local Docker verifier bounds an unresponsive loopback Web response body", async () => {
  const f = fixture();
  try {
    await assert.rejects(
      () =>
        runLocalDockerVerifier({
          config: f.config,
          configDir: f.dir,
          envFile: f.envFile,
          principal: "local-admin",
          text: "hello",
          timeoutMs: 1,
          fetchImpl: async () =>
            new Response(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(new TextEncoder().encode('{"status":"queued"'));
                },
              }),
              { status: 202, headers: { "content-type": "application/json" } },
            ),
        }),
      /timed out before a complete reply/,
    );
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("local Docker host commands abort real unfinished loopback response bodies", async () => {
  const core = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.write('{"ok":true');
  });
  let coreClosed = 0;
  core.on("connection", (socket) => socket.once("close", () => coreClosed++));
  const corePort = await startServer(core);
  const coreFixture = fixture(corePort);
  try {
    await runLocalDockerBootstrap({
      config: coreFixture.config,
      configDir: coreFixture.dir,
      envFile: coreFixture.envFile,
      principal: "local-admin",
      provider,
    });
    await pause(50);
    assert.ok(coreClosed >= 1);
  } finally {
    rmSync(coreFixture.dir, { recursive: true, force: true });
    await stopServer(core);
  }

  const web = createServer((_request, response) => {
    response.writeHead(202, { "content-type": "application/json" });
    response.write('{"status":"queued"');
  });
  let webClosed = 0;
  web.on("connection", (socket) => socket.once("close", () => webClosed++));
  const webPort = await startServer(web);
  const webFixture = fixture(webPort - 2);
  try {
    await assert.rejects(
      () =>
        runLocalDockerVerifier({
          config: webFixture.config,
          configDir: webFixture.dir,
          envFile: webFixture.envFile,
          principal: "local-admin",
          text: "hello",
          timeoutMs: 25,
        }),
      /timed out before a complete reply/,
    );
    await pause(50);
    assert.ok(webClosed >= 1);
  } finally {
    rmSync(webFixture.dir, { recursive: true, force: true });
    await stopServer(web);
  }
});

test("local Docker verifier refuses permissive secret-file modes and unsuccessful terminal runs", async () => {
  const f = fixture();
  try {
    chmodSync(f.envFile, 0o644);
    await assert.rejects(
      () =>
        runLocalDockerVerifier({
          config: f.config,
          configDir: f.dir,
          envFile: f.envFile,
          principal: "local-admin",
          text: "hello",
          fetchImpl: async () => Response.json({}),
        }),
      /permissions 0600 or stricter/,
    );
    chmodSync(f.envFile, 0o600);
    await assert.rejects(
      () =>
        runLocalDockerVerifier({
          config: f.config,
          configDir: f.dir,
          envFile: f.envFile,
          principal: "local-admin",
          text: "hello",
          now: () => 1_000,
          fetchImpl: async (_url, init) =>
            init?.method === "POST"
              ? Response.json({ status: "queued", runId: "run-1" }, { status: 202 })
              : Response.json({ status: "failed", result: { status: "failed", reason: "provider rejected" } }),
        }),
      /failed before a complete reply/,
    );
    await assert.rejects(
      () =>
        runLocalDockerVerifier({
          config: f.config,
          configDir: f.dir,
          envFile: f.envFile,
          principal: "local-admin",
          text: "hello",
          now: () => 1_000,
          fetchImpl: async (_url, init) =>
            init?.method === "POST"
              ? Response.json({ status: "queued", runId: "run-1" }, { status: 202 })
              : Response.json({ status: "done", result: { status: "ok", reply: "partial" } }),
        }),
      /failed before a complete reply/,
    );
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});
