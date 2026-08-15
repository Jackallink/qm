import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { createPiHarness } from "../src/harness/pi-harness.ts";
import type { HarnessTurnInput } from "../src/harness/harness.ts";
import type { OrchestratorInput } from "../src/core/orchestrator.ts";
import { textOnlyModelRefusal, textOnlyNoRedirectFetch, textOnlyTurnRefusal } from "../src/core/text-only.ts";
import { buildApp } from "../src/wiring.ts";
import type { TurnRequest } from "../src/types.ts";
import { testConfig } from "./support/test-config.ts";
import { createInsecureTestServer } from "../src/api/server.ts";

const productionSecrets = {
  NODE_ENV: "production",
  CORE_SIGNING_SECRET: "core-signing-secret-0123456789abcdef",
  SKILL_SIGNING_SECRET: "skill-signing-secret-0123456789abcdef",
  CAPABILITY_SECRET: "capability-secret-0123456789abcdef",
  PORTAL_IDENTITY_SECRET: "portal-identity-secret-0123456789abcdef",
  CONNECTOR_SECRET_KEY: "connector-secret-0123456789abcdef",
} as const;

function turn(): HarnessTurnInput {
  return {
    session: { id: "text-only-turn" } as HarnessTurnInput["session"],
    input: "say hello",
    systemPrompt: "You are a concise assistant.",
    history: [],
    tools: new Proxy(
      {},
      {
        get() {
          throw new Error("text-only Pi turn must not dispatch ToolContext");
        },
      },
    ) as HarnessTurnInput["tools"],
    scopeLabel: "personal:alice" as HarnessTurnInput["scopeLabel"],
    orgScopeId: "org:acme" as HarnessTurnInput["orgScopeId"],
    emit: async (entry) => ({ ...entry, seq: 1 }) as Awaited<ReturnType<HarnessTurnInput["emit"]>>,
    recordModelCall() {},
  };
}

function reply(model: string, text: string): Response {
  const chunk = (delta: Record<string, unknown>, finish_reason: string | null) =>
    `data: ${JSON.stringify({
      id: "cmpl",
      object: "chat.completion.chunk",
      model,
      choices: [{ index: 0, delta, finish_reason }],
    })}\n\n`;
  return new Response(`${chunk({ role: "assistant", content: text }, null)}${chunk({}, "stop")}data: [DONE]\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function providerRefusal(): Response {
  return new Response(
    JSON.stringify({
      type: "error",
      error: {
        type: "invalid_request_error",
        message:
          "This request was blocked as it seems to violate Anthropic's Terms of Service restrictions. API integrators: you can reduce refusals for your users by configuring a fallback model.",
      },
    }),
    { status: 400, headers: { "content-type": "application/json" } },
  );
}

test("TEXT_ONLY_MODE requires Pi, disabled sandbox, and disabled memory", () => {
  const config = loadConfig({
    ...productionSecrets,
    HARNESS: "pi",
    SANDBOX_BACKEND: "disabled",
    TEXT_ONLY_MODE: "true",
    MEMORY_RECALL: "off",
    MEMORY_CAPTURE: "off",
  });
  assert.equal(config.textOnlyMode, true);
  assert.equal(config.seedSkills, false);

  for (const env of [
    { HARNESS: "mock" },
    { SANDBOX_BACKEND: "local" },
    { MEMORY_RECALL: "visible" },
    { MEMORY_CAPTURE: "writable" },
    {
      SECURITY_SCREEN_BACKEND: "proxy",
      SECURITY_SCREEN_PROXY_PROVIDER: "screen",
      SECURITY_SCREEN_PROXY_ENDPOINT: "https://screen.example.test/classify",
      SECURITY_SCREEN_PROXY_TOKEN: "screen-token",
      SECURITY_SCREEN_PROXY_ROLLOUT: "enforce",
    },
  ]) {
    assert.throws(
      () =>
        loadConfig({
          ...productionSecrets,
          HARNESS: "pi",
          SANDBOX_BACKEND: "disabled",
          TEXT_ONLY_MODE: "true",
          MEMORY_RECALL: "off",
          MEMORY_CAPTURE: "off",
          ...env,
        }),
      /TEXT_ONLY_MODE/,
    );
  }
});

test("text-only admission permits only direct human web text", () => {
  const accepted = {
    surface: "web",
    text: "hello",
    liveActor: true,
    conversation: { kind: "dm" },
  } as const;
  assert.equal(textOnlyTurnRefusal(accepted), undefined);
  for (const input of [
    { ...accepted, attachments: [{}] },
    { ...accepted, images: [{}] },
    { ...accepted, surfaceTools: true },
    { ...accepted, proactiveOpener: true },
    { ...accepted, conversationHeader: "external context" },
    { ...accepted, model: "another-model" },
    { ...accepted, approval: { requestId: "approval", approved: true } },
    { ...accepted, spawned: true },
    { ...accepted, origin: { kind: "automation" as const } },
    { ...accepted, surface: "slack" },
  ]) {
    assert.match(textOnlyTurnRefusal(input) ?? "", /text-only mode/);
  }
});

test("text-only model admission requires an HTTPS custom-provider endpoint", () => {
  const snapshot = {
    providers: [
      {
        id: "legacy-http-gateway",
        name: "Legacy HTTP gateway",
        protocol: "openai" as const,
        baseUrl: "http://legacy-http.example.test/v1",
        models: [{ id: "legacy-http-model", name: "Legacy HTTP model" }],
      },
    ],
    keys: { "legacy-http-gateway": "sk-legacy-http" },
  };
  assert.equal(
    textOnlyModelRefusal(snapshot, "legacy-http-model"),
    "text-only mode requires an HTTPS custom-provider endpoint",
  );
});

test("text-only admission never fetches the managed-provider model catalog", async () => {
  let catalogFetches = 0;
  const built = buildApp(
    testConfig({
      harness: "pi",
      sandboxBackend: "disabled",
      textOnlyMode: true,
      memoryRecall: "off",
      memoryCapture: "off",
      openrouterApiKey: "legacy-openrouter-key",
    }),
    {
      modelCredentialFetch: async () => {
        catalogFetches++;
        return Response.json({ data: [] });
      },
    },
  );
  const provider = {
    id: "text-only-catalog-gateway",
    name: "Text-only catalog gateway",
    protocol: "openai" as const,
    baseUrl: "https://text-only-catalog.example.test/v1",
    models: [{ id: "text-only-catalog-model", name: "Text-only Catalog Model" }],
  };
  try {
    await built.customProviders.upsert(provider, "sk-text-only-catalog", "admin");
    await built.refreshCustomProviders();
    await built.config.setApprovedHarnesses(["pi"]);
    await built.config.setRuntimeSelectionLatest("org:default-org", {
      harnessId: "pi",
      modelId: "text-only-catalog-model",
    });
    await built.config.flushScope("org:default-org");
    assert.equal(
      (
        await built.app.turn({
          surface: "web",
          actor: { externalId: "U1" },
          conversation: { kind: "dm", threadRef: "web:U1:text-only-catalog" },
          liveActor: true,
          text: "hello",
          async: true,
        })
      ).status,
      "queued",
    );
    assert.equal(catalogFetches, 0);
  } finally {
    await built.runtime.stop();
  }
});

test("text-only Pi sends no tool definitions and cannot dispatch ToolContext", async () => {
  const provider = {
    id: "text-only-gateway",
    name: "Text-only gateway",
    protocol: "openai" as const,
    baseUrl: "https://text-only.example.test/v1",
    models: [{ id: "text-only-model", name: "Text-only Model" }],
  };
  const harness = createPiHarness({
    textOnly: true,
    modelId: "text-only-model",
    titleModelId: "text-only-model",
    resolveProviderKeys: async () => {
      throw new Error("text-only mode must not resolve managed provider keys");
    },
    resolveCustomProviderSnapshot: async () => ({ providers: [provider], keys: { [provider.id]: "sk-text-only" } }),
  });
  const realFetch = globalThis.fetch;
  const requests: Record<string, unknown>[] = [];
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    return reply("text-only-model", "hello");
  }) as typeof globalThis.fetch;
  try {
    const result = await harness.turns.runTurn(turn());
    assert.equal(result.reply, "hello");
    assert.equal(await harness.models.generateTitle?.("hello"), undefined);
    assert.equal(await harness.models.judge?.("system", "hello"), undefined);
    assert.equal(requests.length, 1);
    assert.deepEqual(
      requests.flatMap((request) => request.tools ?? []),
      [],
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("text-only Pi rejects provider redirects before the target receives prompt or key", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = textOnlyNoRedirectFetch(realFetch);
  try {
    for (const protocol of ["openai", "anthropic"] as const) {
      const key = `sk-sentinel-${protocol}`;
      let originBody = "";
      let originKey: string | undefined;
      let targetHits = 0;
      let targetBody = "";
      let targetKey: string | undefined;
      const target = createServer((request, response) => {
        targetHits++;
        const header = protocol === "openai" ? request.headers.authorization : request.headers["x-api-key"];
        targetKey = Array.isArray(header) ? header[0] : header;
        request.on("data", (chunk) => {
          targetBody += String(chunk);
        });
        request.on("end", () => response.writeHead(200).end());
      });
      await new Promise<void>((resolve, reject) =>
        target.listen(0, "127.0.0.1", (error?: Error) => (error ? reject(error) : resolve())),
      );
      const targetPort = (target.address() as AddressInfo).port;
      const origin = createServer((request, response) => {
        const header = protocol === "openai" ? request.headers.authorization : request.headers["x-api-key"];
        originKey = Array.isArray(header) ? header[0] : header;
        request.on("data", (chunk) => {
          originBody += String(chunk);
        });
        request.on("end", () => response.writeHead(307, { location: `http://127.0.0.1:${targetPort}/capture` }).end());
      });
      await new Promise<void>((resolve, reject) =>
        origin.listen(0, "127.0.0.1", (error?: Error) => (error ? reject(error) : resolve())),
      );
      const originPort = (origin.address() as AddressInfo).port;
      const provider = {
        id: `redirect-${protocol}-gateway`,
        name: `Redirect ${protocol} gateway`,
        protocol,
        baseUrl: protocol === "openai" ? `http://127.0.0.1:${originPort}/v1` : `http://127.0.0.1:${originPort}`,
        models: [{ id: `redirect-${protocol}-model`, name: `Redirect ${protocol} model` }],
      };
      const harness = createPiHarness({
        modelId: provider.models[0]!.id,
        resolveCustomProviderSnapshot: async () => ({ providers: [provider], keys: { [provider.id]: key } }),
      });
      try {
        await assert.rejects(harness.turns.runTurn(turn()));
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.match(originBody, /say hello/);
        assert.equal(originKey, protocol === "openai" ? `Bearer ${key}` : key);
        assert.equal(targetHits, 0);
        assert.equal(targetBody, "");
        assert.equal(targetKey, undefined);
      } finally {
        await new Promise<void>((resolve, reject) => origin.close((error) => (error ? reject(error) : resolve())));
        await new Promise<void>((resolve, reject) => target.close((error) => (error ? reject(error) : resolve())));
      }
    }
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("text-only Pi does not fall back to a different provider after a refusal", async () => {
  const provider = {
    id: "text-only-refusal-gateway",
    name: "Text-only refusal gateway",
    protocol: "openai" as const,
    baseUrl: "https://text-only-refusal.example.test/v1",
    models: [{ id: "text-only-refusal-model", name: "Text-only Refusal Model" }],
  };
  const harness = createPiHarness({
    textOnly: true,
    modelId: "text-only-refusal-model",
    apiKey: "sk-anthropic-must-not-be-used",
    resolveCustomProviderSnapshot: async () => ({ providers: [provider], keys: { [provider.id]: "sk-text-only" } }),
  });
  const realFetch = globalThis.fetch;
  const requests: Array<{ url: string; model?: string }> = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
    requests.push({ url: String(url), model: body.model });
    return providerRefusal();
  }) as typeof globalThis.fetch;
  try {
    await assert.rejects(harness.turns.runTurn(turn()), /Terms of Service/);
    assert.deepEqual(requests, [
      { url: "https://text-only-refusal.example.test/v1/chat/completions", model: "text-only-refusal-model" },
    ]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("text-only dispatch rejects a legacy Pi builtin selection before any provider request", async () => {
  const direct = createPiHarness({ textOnly: true, modelId: "claude-opus-5", apiKey: "sk-anthropic-must-not-be-used" });
  const realFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = (async () => {
    fetches++;
    return reply("claude-opus-5", "unexpected");
  }) as typeof globalThis.fetch;
  try {
    await assert.rejects(direct.turns.runTurn(turn()), /text-only mode requires an enabled custom-provider model/);
    assert.equal(fetches, 0);
  } finally {
    globalThis.fetch = realFetch;
  }

  const built = buildApp(
    testConfig({
      harness: "pi",
      sandboxBackend: "disabled",
      textOnlyMode: true,
      memoryRecall: "off",
      memoryCapture: "off",
    }),
  );
  const request: OrchestratorInput = {
    surface: "web",
    actor: { id: "U1", type: "internal" },
    conversation: {
      kind: "dm",
      threadRef: "web:U1:text-only-legacy-builtin",
      audience: [{ id: "U1", type: "internal" }],
    },
    origin: { kind: "human" },
    text: "this legacy queued request must not reach Anthropic",
  };
  let workerFetches = 0;
  globalThis.fetch = (async () => {
    workerFetches++;
    return reply("claude-opus-5", "unexpected");
  }) as typeof globalThis.fetch;
  try {
    await built.config.setApprovedHarnesses(["pi"]);
    await built.config.setRuntimeSelectionLatest("org:default-org", {
      harnessId: "pi",
      modelId: "claude-opus-5",
    });
    await built.config.flushScope("org:default-org");
    const { run } = await built.runs.enqueue({ sessionId: request.conversation.threadRef, request, maxAttempts: 1 });
    built.runtime.start();
    let stored = await built.runs.get(run.id);
    for (let i = 0; i < 100 && stored?.status !== "failed"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      stored = await built.runs.get(run.id);
    }
    assert.equal(stored?.status, "failed");
    assert.equal(workerFetches, 0);
  } finally {
    globalThis.fetch = realFetch;
    await built.runtime.stop();
  }
});

test("text-only dispatch rejects a persisted HTTP custom provider before any provider request", async () => {
  const built = buildApp(
    testConfig({
      harness: "pi",
      sandboxBackend: "disabled",
      textOnlyMode: true,
      memoryRecall: "off",
      memoryCapture: "off",
    }),
  );
  const request: OrchestratorInput = {
    surface: "web",
    actor: { id: "U1", type: "internal" },
    conversation: {
      kind: "dm",
      threadRef: "web:U1:text-only-legacy-http",
      audience: [{ id: "U1", type: "internal" }],
    },
    origin: { kind: "human" },
    text: "this legacy HTTP provider must not receive a request",
  };
  const provider = {
    id: "legacy-http-gateway",
    name: "Legacy HTTP gateway",
    protocol: "openai" as const,
    baseUrl: "http://legacy-http.example.test/v1",
    models: [{ id: "legacy-http-model", name: "Legacy HTTP model" }],
  };
  const realFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = (async () => {
    fetches++;
    return reply("legacy-http-model", "unexpected");
  }) as typeof globalThis.fetch;
  try {
    await built.customProviders.upsert(provider, "sk-legacy-http", "admin");
    await built.refreshCustomProviders();
    await built.config.setApprovedHarnesses(["pi"]);
    await built.config.setRuntimeSelectionLatest("org:default-org", {
      harnessId: "pi",
      modelId: "legacy-http-model",
    });
    await built.config.flushScope("org:default-org");
    const { run } = await built.runs.enqueue({ sessionId: request.conversation.threadRef, request, maxAttempts: 1 });
    built.runtime.start();
    let stored = await built.runs.get(run.id);
    for (let i = 0; i < 100 && stored?.status !== "failed"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      stored = await built.runs.get(run.id);
    }
    assert.equal(stored?.status, "failed");
    assert.equal(fetches, 0);
  } finally {
    globalThis.fetch = realFetch;
    await built.runtime.stop();
  }
});

test("text-only mode rejects nontext input before enqueue and from a legacy queued run", async () => {
  const built = buildApp(
    testConfig({
      harness: "pi",
      sandboxBackend: "disabled",
      textOnlyMode: true,
      memoryRecall: "off",
      memoryCapture: "off",
    }),
  );
  const request: TurnRequest = {
    surface: "web",
    actor: { externalId: "U1" },
    conversation: { kind: "dm", threadRef: "web:U1:text-only" },
    liveActor: true,
    text: "summarize this attachment",
    attachments: [{ name: "report.txt", mimetype: "text/plain", sizeBytes: 1, blobId: "missing" }],
  };
  try {
    built.config.setApprovedHarnesses(["pi", "mock"]);
    await built.config.setRuntimeSelectionLatest("org:default-org", {
      harnessId: "mock",
      modelId: "claude-opus-5",
    });
    await built.config.flushScope("org:default-org");
    assert.deepEqual(await built.app.turn({ ...request, text: "hello", attachments: undefined }), {
      status: "refused",
      reason: "runtime mock/claude-opus-5 is not permitted in this mode",
    });

    await built.config.setRuntimeSelectionLatest("org:default-org", {
      harnessId: "pi",
      modelId: "claude-opus-5",
    });
    await built.config.flushScope("org:default-org");
    assert.deepEqual(await built.app.turn({ ...request, text: "hello", attachments: undefined }), {
      status: "refused",
      reason: "text-only mode requires an enabled custom-provider model with a configured key",
    });

    const rejected = await built.app.turn(request);
    assert.deepEqual(rejected, {
      status: "refused",
      reason: "text-only mode does not permit tools, files, or automated input",
    });
    assert.equal((await built.runs.list({ limit: 10 })).length, 0);

    const queuedRequest: OrchestratorInput = {
      ...request,
      actor: { id: "U1", type: "internal" },
      conversation: {
        kind: "dm",
        threadRef: request.conversation.threadRef,
        audience: [{ id: "U1", type: "internal" }],
      },
      origin: { kind: "human" },
    };
    const { run } = await built.runs.enqueue({
      sessionId: request.conversation.threadRef,
      request: queuedRequest,
      maxAttempts: 1,
    });
    built.runtime.start();
    let stored = await built.runs.get(run.id);
    for (let i = 0; i < 100 && stored?.status !== "done"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      stored = await built.runs.get(run.id);
    }
    assert.equal(stored?.status, "done");
    assert.deepEqual(stored?.result, rejected);
  } finally {
    await built.runtime.stop();
  }
});

test("text-only mode never replays a terminal steer as a fresh turn", async () => {
  const built = buildApp(
    testConfig({
      harness: "pi",
      sandboxBackend: "disabled",
      textOnlyMode: true,
      memoryRecall: "off",
      memoryCapture: "off",
    }),
  );
  const actor = { id: "U1", type: "internal" as const };
  const request: OrchestratorInput = {
    surface: "web",
    actor,
    conversation: { kind: "dm", threadRef: "web:U1:text-only-terminal", audience: [actor] },
    origin: { kind: "human" },
    text: "hello",
  };
  try {
    const { run } = await built.runs.enqueue({ sessionId: request.conversation.threadRef, request });
    const claimed = await built.runs.claimById(run.id, "text-only-terminal", 5_000);
    assert.ok(claimed);
    await built.runs.complete(run.id, claimed!.leaseToken!, { status: "ok", reply: "done" });

    assert.deepEqual(await built.app.signalRun(run.id, { kind: "steer", text: "please continue" }), {
      accepted: false,
      reason: "signals_unavailable",
    });
    assert.equal((await built.runs.list({ limit: 10 })).length, 1);
  } finally {
    await built.runtime.stop();
  }
});

test("text-only mode disables the run-signal route", async () => {
  const built = buildApp(
    testConfig({
      harness: "pi",
      sandboxBackend: "disabled",
      textOnlyMode: true,
      memoryRecall: "off",
      memoryCapture: "off",
    }),
  );
  const server = createInsecureTestServer(built.app, { textOnly: true });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  try {
    const response = await fetch(`${base}/v1/runs/any-run/signal`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "steer", text: "do not forward this" }),
    });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { accepted: false, reason: "signals_unavailable" });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await built.runtime.stop();
  }
});

test("text-only mode does not wire manual cron fire", async () => {
  const built = buildApp(
    testConfig({
      harness: "pi",
      sandboxBackend: "disabled",
      textOnlyMode: true,
      memoryRecall: "off",
      memoryCapture: "off",
    }),
  );
  const cron = await built.app.createCron({
    schedule: { everyMs: 60_000 },
    message: "legacy cron delivery",
    owner: "U1",
    createdBy: "U1",
    ownerScopeId: "personal:U1",
    destination: { type: "slack", target: "U1", audienceScopeId: "personal:U1" },
  });
  const server = createInsecureTestServer(built.app, { textOnly: true });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  try {
    const response = await fetch(`${base}/v1/crons/${encodeURIComponent(cron.id)}/run`, { method: "POST" });
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "not_found", message: "scheduler not wired" });
    assert.deepEqual(await built.deliveries.pending("slack"), []);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await built.runtime.stop();
  }
});

test("text-only mode does not rehydrate images from a preexisting session tape", async () => {
  const built = buildApp(
    testConfig({
      harness: "pi",
      sandboxBackend: "disabled",
      textOnlyMode: true,
      memoryRecall: "off",
      memoryCapture: "off",
    }),
  );
  const provider = {
    id: "text-only-tape-gateway",
    name: "Text-only tape gateway",
    protocol: "openai" as const,
    baseUrl: "https://text-only-tape.example.test/v1",
    models: [{ id: "text-only-tape-model", name: "Text-only Tape Model" }],
  };
  const threadRef = "web:U1:text-only-tape";
  const actor = { id: "U1", type: "internal" as const };
  const scope = "personal:U1" as const;
  const realFetch = globalThis.fetch;
  const originalGet = built.files.get.bind(built.files);
  const originalEnsureScope = built.workspace.ensureScope.bind(built.workspace);
  let artifactReads = 0;
  let workspaceEnsures = 0;
  let request: Record<string, unknown> | undefined;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    request = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    return reply("text-only-tape-model", "hello");
  }) as typeof globalThis.fetch;
  built.files.get = async (...args) => {
    artifactReads++;
    return originalGet(...args);
  };
  built.workspace.ensureScope = async () => {
    workspaceEnsures++;
  };
  try {
    await built.customProviders.upsert(provider, "sk-text-only-tape", "admin");
    await built.refreshCustomProviders();
    await built.config.setApprovedHarnesses(["pi"]);
    await built.config.setRuntimeSelectionLatest("org:default-org", {
      harnessId: "pi",
      modelId: "text-only-tape-model",
    });
    await built.config.flushScope("org:default-org");
    const session = await built.sessions.getOrCreateByThread(threadRef, "dm", scope, undefined, "web");
    const { lease } = await built.sessions.acquireLease(session.id);
    assert.ok(lease);
    await built.sessions.appendTape(lease!, {
      kind: "message",
      harness: "pi",
      scopeLabel: scope,
      entrySeq: 0,
      payload: {
        role: "user",
        content: [{ type: "image", artifactRef: "legacy-image", mimeType: "image/png" }],
        timestamp: 1,
      },
    });
    await built.sessions.appendTape(lease!, {
      kind: "annotation",
      scopeLabel: scope,
      entrySeq: 0,
      payload: { turnEnd: true },
    });
    await built.sessions.append(lease!, {
      type: "tool_call",
      payload: { callId: "legacy-tool", tool: "execute", command: "cat secret" },
      scopeLabel: scope,
    });
    await built.sessions.append(lease!, {
      type: "tool_result",
      payload: { callId: "legacy-tool", result: "LEGACY_SECRET_AUDIT" },
      scopeLabel: scope,
    });
    await built.sessions.releaseLease(lease!);
    const { run } = await built.runs.enqueue({
      sessionId: threadRef,
      request: {
        surface: "web",
        actor,
        conversation: { kind: "dm", threadRef, audience: [actor] },
        origin: { kind: "human" },
        text: "hello",
      },
      maxAttempts: 1,
    });
    built.runtime.start();
    let stored = await built.runs.get(run.id);
    for (let i = 0; i < 100 && stored?.status !== "done" && stored?.status !== "failed"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      stored = await built.runs.get(run.id);
    }
    assert.equal(stored?.status, "done");
    assert.equal(artifactReads, 0);
    assert.equal(workspaceEnsures, 0);
    assert.deepEqual(request?.tools ?? [], []);
    assert.doesNotMatch(JSON.stringify(request), /LEGACY_SECRET_AUDIT|tool_calls|"role":"tool"/);
  } finally {
    built.files.get = originalGet;
    built.workspace.ensureScope = originalEnsureScope;
    globalThis.fetch = realFetch;
    await built.runtime.stop();
  }
});

test("text-only mode does not replay hidden or steered legacy history", async () => {
  const built = buildApp(
    testConfig({
      harness: "pi",
      sandboxBackend: "disabled",
      textOnlyMode: true,
      memoryRecall: "off",
      memoryCapture: "off",
    }),
  );
  const provider = {
    id: "text-only-history-gateway",
    name: "Text-only history gateway",
    protocol: "openai" as const,
    baseUrl: "https://text-only-history.example.test/v1",
    models: [{ id: "text-only-history-model", name: "Text-only History Model" }],
  };
  const threadRef = "web:U1:text-only-history";
  const actor = { id: "U1", type: "internal" as const };
  const scope = "personal:U1" as const;
  const realFetch = globalThis.fetch;
  let request: Record<string, unknown> | undefined;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    request = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    return reply("text-only-history-model", "hello");
  }) as typeof globalThis.fetch;
  try {
    await built.customProviders.upsert(provider, "sk-text-only-history", "admin");
    await built.refreshCustomProviders();
    await built.config.setApprovedHarnesses(["pi"]);
    await built.config.setRuntimeSelectionLatest("org:default-org", {
      harnessId: "pi",
      modelId: "text-only-history-model",
    });
    await built.config.flushScope("org:default-org");
    const session = await built.sessions.getOrCreateByThread(threadRef, "dm", scope, undefined, "web");
    const { lease } = await built.sessions.acquireLease(session.id);
    assert.ok(lease);
    await built.sessions.append(lease!, {
      type: "user",
      payload: { text: "LEGACY_VISIBLE_HUMAN_TEXT" },
      scopeLabel: scope,
    });
    await built.sessions.append(lease!, {
      type: "user",
      payload: { text: "LEGACY_HIDDEN_AUTOMATION_TEXT", hidden: true },
      scopeLabel: scope,
    });
    await built.sessions.append(lease!, {
      type: "user",
      payload: { text: "LEGACY_STEER_TEXT", steered: true },
      scopeLabel: scope,
    });
    await built.sessions.releaseLease(lease!);
    const { run } = await built.runs.enqueue({
      sessionId: threadRef,
      request: {
        surface: "web",
        actor,
        conversation: { kind: "dm", threadRef, audience: [actor] },
        origin: { kind: "human" },
        text: "CURRENT_HUMAN_TEXT",
      },
      maxAttempts: 1,
    });
    built.runtime.start();
    let stored = await built.runs.get(run.id);
    for (let i = 0; i < 100 && stored?.status !== "done" && stored?.status !== "failed"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      stored = await built.runs.get(run.id);
    }
    assert.equal(stored?.status, "done");
    assert.match(JSON.stringify(request), /LEGACY_VISIBLE_HUMAN_TEXT|CURRENT_HUMAN_TEXT/);
    assert.doesNotMatch(JSON.stringify(request), /LEGACY_HIDDEN_AUTOMATION_TEXT|LEGACY_STEER_TEXT/);
  } finally {
    globalThis.fetch = realFetch;
    await built.runtime.stop();
  }
});

test("text-only mode skips seed skills and legacy skill/deployment prompt ingress", async () => {
  const skillsSeedDir = mkdtempSync(join(tmpdir(), "qm-text-only-seed-"));
  const seedSkillDir = join(skillsSeedDir, "blocked-seed");
  mkdirSync(seedSkillDir);
  writeFileSync(
    join(seedSkillDir, "SKILL.md"),
    "---\nname: blocked-seed\ndescription: BLOCKED_SEED_SKILL_DESCRIPTION\n---\n\n# blocked seed\n",
  );
  const built = buildApp(
    testConfig({
      harness: "pi",
      sandboxBackend: "disabled",
      textOnlyMode: true,
      memoryRecall: "off",
      memoryCapture: "off",
      seedSkills: true,
      skillsSeedDir,
    }),
  );
  const provider = {
    id: "text-only-skills-gateway",
    name: "Text-only skills gateway",
    protocol: "openai" as const,
    baseUrl: "https://text-only-skills.example.test/v1",
    models: [{ id: "text-only-skills-model", name: "Text-only Skills Model" }],
  };
  const threadRef = "web:U1:text-only-skills";
  const actor = { id: "U1", type: "internal" as const };
  const realFetch = globalThis.fetch;
  const originalVisibleFor = built.skills.visibleFor.bind(built.skills);
  let skillReads = 0;
  let request: Record<string, unknown> | undefined;
  built.skills.visibleFor = async (scopes) => {
    skillReads++;
    return originalVisibleFor(scopes);
  };
  built.deploymentLayer.hints.push("LEGACY_DEPLOYMENT_HINT");
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    request = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    return reply("text-only-skills-model", "hello");
  }) as typeof globalThis.fetch;
  try {
    const legacy = await built.skills.create({
      scopeId: "org:default-org",
      manifest: {
        name: "legacy-skill",
        description: "LEGACY_SKILL_DESCRIPTION",
        requiredCapabilities: [],
        body: "# legacy skill",
      },
      createdBy: "legacy",
    });
    await built.skills.review(legacy.id, "reviewer", []);
    await built.skills.publish(legacy.id);
    await built.customProviders.upsert(provider, "sk-text-only-skills", "admin");
    await built.refreshCustomProviders();
    await built.config.setApprovedHarnesses(["pi"]);
    await built.config.setRuntimeSelectionLatest("org:default-org", {
      harnessId: "pi",
      modelId: "text-only-skills-model",
    });
    await built.config.flushScope("org:default-org");
    const { run } = await built.runs.enqueue({
      sessionId: threadRef,
      request: {
        surface: "web",
        actor,
        conversation: { kind: "dm", threadRef, audience: [actor] },
        origin: { kind: "human" },
        text: "CURRENT_HUMAN_TEXT",
      },
      maxAttempts: 1,
    });
    built.runtime.start();
    let stored = await built.runs.get(run.id);
    for (let i = 0; i < 100 && stored?.status !== "done" && stored?.status !== "failed"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      stored = await built.runs.get(run.id);
    }
    assert.equal(stored?.status, "done");
    assert.equal(skillReads, 0);
    assert.deepEqual(
      (await built.skills.list()).map((skill) => skill.manifest.name),
      ["legacy-skill"],
    );
    assert.doesNotMatch(
      JSON.stringify(request),
      /## Skills|BLOCKED_SEED_SKILL_DESCRIPTION|LEGACY_SKILL_DESCRIPTION|LEGACY_DEPLOYMENT_HINT/,
    );
  } finally {
    built.skills.visibleFor = originalVisibleFor;
    globalThis.fetch = realFetch;
    await built.runtime.stop();
    rmSync(skillsSeedDir, { recursive: true, force: true });
  }
});

test("text-only mode rejects non-Pi runtime mutations", async () => {
  const built = buildApp(
    testConfig({
      harness: "pi",
      sandboxBackend: "disabled",
      textOnlyMode: true,
      memoryRecall: "off",
      memoryCapture: "off",
    }),
  );
  const server = createInsecureTestServer(built.app, {
    config: built.config,
    admin: built.admin,
    auditLog: built.auditLog,
    customProviders: built.customProviders,
    harnessId: "pi",
    textOnly: true,
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const adminHeaders = { "content-type": "application/json", "x-admin-actor": "admin-alice@default-org" };
  try {
    await built.customProviders.upsert(
      {
        id: "text-only-admin-gateway",
        name: "Text-only admin gateway",
        protocol: "openai",
        baseUrl: "https://text-only-admin.example.test/v1",
        models: [{ id: "text-only-admin-model", name: "Text-only Admin Model" }],
      },
      "sk-text-only-admin",
      "admin-alice",
    );
    await built.refreshCustomProviders();
    const [runtime, approved, personal] = await Promise.all([
      fetch(`${base}/v1/admin/scopes/org:default-org/runtime`, {
        method: "PUT",
        headers: adminHeaders,
        body: JSON.stringify({ harnessId: "codex", modelId: "gpt-5.6-sol" }),
      }),
      fetch(`${base}/v1/admin/scopes/org:default-org/approved-harnesses`, {
        method: "PUT",
        headers: adminHeaders,
        body: JSON.stringify({ ids: ["pi", "codex"] }),
      }),
      fetch(`${base}/v1/runtime-config`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          principalId: "alice",
          scopeId: "personal:alice",
          harnessId: "codex",
          modelId: "gpt-5.6-sol",
        }),
      }),
    ]);
    const builtin = await fetch(`${base}/v1/admin/scopes/org:default-org/runtime`, {
      method: "PUT",
      headers: adminHeaders,
      body: JSON.stringify({ harnessId: "pi", modelId: "claude-opus-5" }),
    });
    const custom = await fetch(`${base}/v1/admin/scopes/org:default-org/runtime`, {
      method: "PUT",
      headers: adminHeaders,
      body: JSON.stringify({ harnessId: "pi", modelId: "text-only-admin-model" }),
    });
    assert.equal(runtime.status, 400);
    assert.equal(approved.status, 400);
    assert.equal(personal.status, 400);
    assert.equal(builtin.status, 400);
    assert.equal(custom.status, 200);
    assert.deepEqual(await runtime.json(), {
      error: "bad_request",
      message: "text-only mode only permits the pi harness",
    });
    assert.deepEqual(await approved.json(), {
      error: "bad_request",
      message: "text-only mode requires approved harnesses to be [pi]",
    });
    assert.deepEqual(await personal.json(), { error: "harness_not_approved" });
    assert.deepEqual(await builtin.json(), {
      error: "bad_request",
      message: "text-only mode requires an enabled custom-provider model with a configured key",
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await built.runtime.stop();
  }
});
