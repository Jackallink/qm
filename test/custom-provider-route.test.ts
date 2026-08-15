import "./support/auto-fake-sprites.ts";

import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, afterEach } from "node:test";
import { createInsecureTestServer } from "../src/api/server.ts";
import { buildApp, type BuiltApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";
import { resolveModel } from "../src/model/pi-models.ts";
import { setCustomProviders } from "../src/model/custom-providers.ts";
import { createCustomProviderStore, type CustomProviderStore, type StoredCustomProvider } from "../src/model/custom-provider-store.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { scopeId } from "../src/types.ts";

const ADMIN = { "content-type": "application/json", "x-admin-actor": "admin-alice@default-org" };
const USER = { "content-type": "application/json", "x-admin-actor": "bob@default-org" };

afterEach(() => setCustomProviders([]));

function start(
  modelCredentialFetch: typeof fetch = async () => new Response(null, { status: 200 }),
  harness: "mock" | "pi" = "mock",
  customProviderOverride?: CustomProviderStore,
  textOnly = false,
): {
  base: string;
  built: BuiltApp;
  customProviders: CustomProviderStore;
  close: () => Promise<void>;
} {
  const built = buildApp(testConfig({
    dataDir: mkdtempSync(join(tmpdir(), "custom-provider-route-")),
    harness,
    ...(textOnly
      ? { sandboxBackend: "disabled", textOnlyMode: true, memoryRecall: "off", memoryCapture: "off" }
      : {}),
  }), {
    modelCredentialFetch,
  });
  const customProviders = customProviderOverride ?? built.customProviders;
  const refreshCustomProviders = customProviderOverride
    ? async () => setCustomProviders(await customProviderOverride.enabled())
    : built.refreshCustomProviders;
  const server = createInsecureTestServer(built.app, {
    config: built.config,
    modelCredentials: built.modelCredentials,
    customProviders,
    refreshCustomProviders,
    modelCredentialFetch,
    harnessId: "pi",
    providerKeys: { anthropic: true, openai: false, openrouter: false },
    admin: built.admin,
    auditLog: built.auditLog,
    ...(textOnly ? { textOnly: true } : {}),
  });
  server.listen(0);
  return {
    base: `http://localhost:${(server.address() as AddressInfo).port}`,
    built,
    customProviders,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const BODY = {
  name: "Acme Gateway",
  protocol: "openai",
  baseUrl: "https://llm.acme.internal/v1",
  models: [{ id: "acme-large", name: "Acme Large" }],
  apiKey: "sk-acme-secret",
};

test("custom provider lifecycle: register, list, resolve, delete — admin only, no key leakage", async () => {
  const validated: string[] = [];
  const srv = start(async (input) => {
    validated.push(String(input));
    return new Response(null, { status: 200 });
  }, "pi");
  try {
    // Register (validates against the endpoint's /models).
    const put = await fetch(`${srv.base}/v1/admin/custom-providers/acme-gateway`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify(BODY),
    });
    assert.equal(put.status, 200);
    assert.ok(validated.some((u) => u === "https://llm.acme.internal/v1/models"));
    const putBody = (await put.json()) as { status: { hasKey: boolean } };
    assert.equal(putBody.status.hasKey, true);
    assert.equal(JSON.stringify(putBody).includes("sk-acme-secret"), false);

    // The runtime registry serves the model immediately.
    assert.equal(String(resolveModel("acme-large")?.provider), "acme-gateway");

    const runtime = await fetch(`${srv.base}/v1/runtime-config?principalId=alice&scopeId=personal%3Aalice`);
    assert.equal(runtime.status, 200);
    const runtimeBody = (await runtime.json()) as {
      modelsByHarness: Record<string, string[]>;
      modelCatalog: Record<string, { name: string; provider: string; api: string }>;
    };
    assert.ok(runtimeBody.modelsByHarness.pi?.includes("acme-large"));
    assert.deepEqual(runtimeBody.modelCatalog["acme-large"], {
      name: "Acme Large",
      provider: "acme-gateway",
      api: "openai-completions",
    });

    const turn = await fetch(`${srv.base}/v1/turns?async=1`, {
      method: "POST",
      headers: ADMIN,
      body: JSON.stringify({
        surface: "web",
        actor: { externalId: "alice" },
        conversation: { kind: "dm", threadRef: "web:alice:custom-provider-runtime" },
        text: "hello",
        harness: "pi",
        model: "acme-large",
      }),
    });
    assert.equal(turn.status, 202);
    assert.equal(((await turn.json()) as { status: string }).status, "queued");

    // List never leaks the key.
    const list = await fetch(`${srv.base}/v1/admin/custom-providers`, { headers: ADMIN });
    assert.equal(list.status, 200);
    const listBody = await list.text();
    assert.equal(listBody.includes("sk-acme-secret"), false);
    assert.ok(listBody.includes("acme-gateway"));

    // Non-admin gets refused.
    const denied = await fetch(`${srv.base}/v1/admin/custom-providers`, { headers: USER });
    assert.notEqual(denied.status, 200);

    // Delete disables and clears the registry.
    const del = await fetch(`${srv.base}/v1/admin/custom-providers/acme-gateway`, {
      method: "DELETE",
      headers: ADMIN,
    });
    assert.equal(del.status, 200);
    assert.equal(resolveModel("acme-large"), undefined);
  } finally {
    await srv.close();
  }
});

test("a rejected key blocks registration unless validate:false", async () => {
  const srv = start(async () => new Response(null, { status: 401 }));
  try {
    const put = await fetch(`${srv.base}/v1/admin/custom-providers/acme-gateway`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify(BODY),
    });
    assert.equal(put.status, 400);
    assert.equal(((await put.json()) as { error: string }).error, "invalid_api_key");

    const skip = await fetch(`${srv.base}/v1/admin/custom-providers/acme-gateway`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ ...BODY, validate: false }),
    });
    assert.equal(skip.status, 200);
  } finally {
    await srv.close();
  }
});

test("Anthropic provider validation rejects a cross-origin redirect without forwarding its key", async () => {
  let targetHits = 0;
  let originKey: string | string[] | undefined;
  const target = createServer((_request, response) => {
    targetHits++;
    response.writeHead(200).end();
  });
  await new Promise<void>((resolve, reject) => target.listen(0, "127.0.0.1", (error?: Error) => (error ? reject(error) : resolve())));
  const targetPort = (target.address() as AddressInfo).port;
  const origin = createServer((request, response) => {
    originKey = request.headers["x-api-key"];
    response.writeHead(307, { location: `http://127.0.0.1:${targetPort}/collect` }).end();
  });
  await new Promise<void>((resolve, reject) => origin.listen(0, "127.0.0.1", (error?: Error) => (error ? reject(error) : resolve())));
  const originPort = (origin.address() as AddressInfo).port;
  const srv = start(fetch);
  try {
    const put = await fetch(`${srv.base}/v1/admin/custom-providers/acme-anthropic`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({
        ...BODY,
        protocol: "anthropic",
        baseUrl: `http://127.0.0.1:${originPort}`,
        models: [{ id: "acme-anthropic-model", name: "Acme Anthropic Model" }],
      }),
    });
    assert.equal(put.status, 400);
    assert.equal(originKey, "sk-acme-secret");
    assert.equal(targetHits, 0);
    assert.deepEqual(await srv.customProviders.statuses(), []);
  } finally {
    await srv.close();
    await new Promise<void>((resolve, reject) => origin.close((error) => (error ? reject(error) : resolve())));
    await new Promise<void>((resolve, reject) => target.close((error) => (error ? reject(error) : resolve())));
  }
});

test("invalid provider definitions are rejected before endpoint validation", async () => {
  let calls = 0;
  const srv = start(async () => {
    calls += 1;
    return new Response(null, { status: 200 });
  });
  try {
    const put = await fetch(`${srv.base}/v1/admin/custom-providers/deepseek`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify(BODY),
    });
    assert.equal(put.status, 400);
    assert.equal(calls, 0);
  } finally {
    await srv.close();
  }
});

test("text-only registration rejects HTTP before provider-key validation", async () => {
  let validations = 0;
  const srv = start(
    async () => {
      validations += 1;
      return new Response(null, { status: 200 });
    },
    "pi",
    undefined,
    true,
  );
  try {
    const put = await fetch(`${srv.base}/v1/admin/custom-providers/acme-gateway`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ ...BODY, baseUrl: "http://llm.acme.internal/v1" }),
    });
    assert.equal(put.status, 400);
    assert.deepEqual(await put.json(), {
      error: "bad_request",
      message: "text-only mode requires an HTTPS custom-provider endpoint",
    });
    assert.equal(validations, 0);
    assert.deepEqual(await srv.customProviders.statuses(), []);
  } finally {
    await srv.close();
  }
});

test("an active legacy Pi provider can rotate its key but a legacy core provider stays rejected", async () => {
  const backing = createMemoryMap<StoredCustomProvider>();
  const store = createCustomProviderStore({ backing, keyMaterial: "legacy-route-key" });
  const alias = {
    id: "deepseek-local",
    name: "DeepSeek",
    protocol: "openai" as const,
    baseUrl: "https://api.deepseek.com",
    models: [{ id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" }],
  };
  await store.upsert(alias, "sk-old", "admin@example.com");
  const saved = await backing.get(alias.id);
  assert.ok(saved);
  await backing.delete(alias.id);
  await backing.put("deepseek", { ...saved, id: "deepseek" });
  await backing.put("openai", { ...saved, id: "openai", models: [{ id: "legacy-openai-model" }] });
  const srv = start(undefined, "pi", store);
  try {
    const rotated = await fetch(`${srv.base}/v1/admin/custom-providers/deepseek`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ ...alias, apiKey: "sk-new", validate: false }),
    });
    assert.equal(rotated.status, 200);
    assert.equal(await store.resolveKey("deepseek"), "sk-new");

    const core = await fetch(`${srv.base}/v1/admin/custom-providers/openai`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ ...BODY, validate: false }),
    });
    assert.equal(core.status, 400);
    assert.match(((await core.json()) as { message: string }).message, /reserved/);
  } finally {
    await srv.close();
  }
});

test("a QM-native model collision is neither advertised nor admitted as a custom model", async () => {
  const srv = start(undefined, "pi");
  const collision = { ...BODY, models: [{ id: "gpt-4o-mini", name: "Gateway GPT" }] };
  try {
    const put = await fetch(`${srv.base}/v1/admin/custom-providers/acme-gateway`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ ...collision, validate: false }),
    });
    assert.equal(put.status, 400);
    assert.match(((await put.json()) as { message: string }).message, /conflicts with a built-in model/);

    setCustomProviders([
      {
        id: "acme-gateway",
        name: collision.name,
        protocol: "openai",
        baseUrl: collision.baseUrl,
        models: collision.models,
      },
    ]);
    const runtime = await fetch(`${srv.base}/v1/runtime-config?principalId=alice&scopeId=personal%3Aalice`);
    assert.equal(runtime.status, 200);
    const runtimeBody = (await runtime.json()) as { modelsByHarness: Record<string, string[]> };
    assert.equal(runtimeBody.modelsByHarness.pi?.includes("gpt-4o-mini"), false);

    const turn = await fetch(`${srv.base}/v1/turns?async=1`, {
      method: "POST",
      headers: ADMIN,
      body: JSON.stringify({
        surface: "web",
        actor: { externalId: "alice" },
        conversation: { kind: "dm", threadRef: "web:alice:native-collision" },
        text: "hello",
        harness: "pi",
        model: "gpt-4o-mini",
      }),
    });
    assert.equal(turn.status, 403);
  } finally {
    await srv.close();
  }
});

test("a model id cannot be registered by two enabled custom providers", async () => {
  const srv = start();
  try {
    const first = await fetch(`${srv.base}/v1/admin/custom-providers/acme-gateway`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ ...BODY, validate: false }),
    });
    assert.equal(first.status, 200);

    const second = await fetch(`${srv.base}/v1/admin/custom-providers/second-gateway`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ ...BODY, name: "Second Gateway", validate: false }),
    });
    assert.equal(second.status, 400);
    assert.match(((await second.json()) as { message: string }).message, /already registered by provider/);
  } finally {
    await srv.close();
  }
});

test("an endpoint change without a new key is refused and preserves the old provider", async () => {
  const srv = start();
  try {
    const first = await fetch(`${srv.base}/v1/admin/custom-providers/acme-gateway`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ ...BODY, validate: false }),
    });
    assert.equal(first.status, 200);
    const changed = await fetch(`${srv.base}/v1/admin/custom-providers/acme-gateway`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ ...BODY, baseUrl: "https://replacement.example.com/v1", apiKey: undefined, validate: false }),
    });
    assert.equal(changed.status, 400);
    assert.match(((await changed.json()) as { message: string }).message, /requires a new API key/);
    const status = (await srv.built.customProviders.statuses())[0]!;
    assert.equal(status.baseUrl, BODY.baseUrl);
    assert.equal(status.hasKey, true);
  } finally {
    await srv.close();
  }
});

test("concurrent provider writes allow only one owner for a model id", async () => {
  let arrivals = 0;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const srv = start(async (input) => {
    if (String(input).endsWith("/models")) {
      arrivals += 1;
      if (arrivals === 2) release();
      await barrier;
    }
    return new Response(null, { status: 200 });
  });
  try {
    const [first, second] = await Promise.all([
      fetch(`${srv.base}/v1/admin/custom-providers/acme-gateway`, {
        method: "PUT",
        headers: ADMIN,
        body: JSON.stringify(BODY),
      }),
      fetch(`${srv.base}/v1/admin/custom-providers/second-gateway`, {
        method: "PUT",
        headers: ADMIN,
        body: JSON.stringify({ ...BODY, name: "Second Gateway" }),
      }),
    ]);
    assert.deepEqual([first.status, second.status].sort(), [200, 400]);
    const providers = await srv.built.customProviders.enabled();
    assert.equal(providers.length, 1);
    assert.equal(providers[0]!.models[0]!.id, "acme-large");
  } finally {
    await srv.close();
  }
});

test("custom provider models are available to Pi but not OpenCode", async () => {
  const srv = start(undefined, "pi");
  try {
    const put = await fetch(`${srv.base}/v1/admin/custom-providers/acme-gateway`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ ...BODY, validate: false }),
    });
    assert.equal(put.status, 200);
    srv.built.config.setApprovedHarnesses(["pi", "opencode"]);
    await srv.built.config.flushScope(scopeId("org", "default-org"));

    const runtime = await fetch(`${srv.base}/v1/runtime-config?principalId=alice&scopeId=personal%3Aalice`);
    assert.equal(runtime.status, 200);
    const runtimeBody = (await runtime.json()) as { modelsByHarness: Record<string, string[]> };
    assert.ok(runtimeBody.modelsByHarness.pi?.includes("acme-large"));
    assert.equal(runtimeBody.modelsByHarness.opencode?.includes("acme-large"), false);

    const selection = await fetch(`${srv.base}/v1/runtime-config`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ principalId: "alice", scopeId: "personal:alice", harnessId: "opencode", modelId: "acme-large" }),
    });
    assert.equal(selection.status, 400);
    assert.equal(((await selection.json()) as { error: string }).error, "model_not_supported");
  } finally {
    await srv.close();
  }
});

test("runtime reads refresh a stale custom-provider registry from durable state", async () => {
  const srv = start(undefined, "pi");
  try {
    await srv.built.customProviders.upsert(
      {
        id: "fresh-gateway",
        name: "Fresh Gateway",
        protocol: "openai",
        baseUrl: "https://fresh.example.com/v1",
        models: [{ id: "fresh-model", name: "Fresh Model" }],
      },
      "sk-fresh",
      "admin@example.com",
    );
    setCustomProviders([]);
    const runtime = await fetch(`${srv.base}/v1/runtime-config?principalId=alice&scopeId=personal%3Aalice`);
    assert.equal(runtime.status, 200);
    const body = (await runtime.json()) as { modelsByHarness: Record<string, string[]> };
    assert.ok(body.modelsByHarness.pi?.includes("fresh-model"));
    assert.equal(String(resolveModel("fresh-model")?.provider), "fresh-gateway");

    setCustomProviders([]);
    const turn = await fetch(`${srv.base}/v1/turns?async=1`, {
      method: "POST",
      headers: ADMIN,
      body: JSON.stringify({
        surface: "web",
        actor: { externalId: "alice" },
        conversation: { kind: "dm", threadRef: "web:alice:fresh-custom-provider" },
        text: "hello",
        harness: "pi",
        model: "fresh-model",
      }),
    });
    assert.equal(turn.status, 202);
    assert.equal(((await turn.json()) as { status: string }).status, "queued");
  } finally {
    await srv.close();
  }
});

test("runtime config preserves an Anthropic-compatible custom provider protocol", async () => {
  const srv = start();
  try {
    const put = await fetch(`${srv.base}/v1/admin/custom-providers/acme-anthropic`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({
        ...BODY,
        protocol: "anthropic",
        models: [{ id: "acme-claude", name: "Acme Claude" }],
      }),
    });
    assert.equal(put.status, 200);

    const runtime = await fetch(`${srv.base}/v1/runtime-config?principalId=alice&scopeId=personal%3Aalice`);
    assert.equal(runtime.status, 200);
    const body = (await runtime.json()) as {
      modelCatalog: Record<string, { name: string; provider: string; api: string }>;
    };
    assert.deepEqual(body.modelCatalog["acme-claude"], {
      name: "Acme Claude",
      provider: "acme-anthropic",
      api: "anthropic-messages",
    });
  } finally {
    await srv.close();
  }
});

test("bad specs are refused with a reason", async () => {
  const srv = start();
  try {
    for (const [patch, reason] of [
      [{ models: [] }, /at least one model/],
      [{ protocol: "grpc" }, /protocol/],
      [{ baseUrl: "https://x?y=1" }, /query/],
    ] as const) {
      const res = await fetch(`${srv.base}/v1/admin/custom-providers/acme-gateway`, {
        method: "PUT",
        headers: ADMIN,
        body: JSON.stringify({ ...BODY, ...patch, validate: false }),
      });
      assert.equal(res.status, 400);
      assert.match(((await res.json()) as { message: string }).message, reason);
    }
    // Reserved slug via the path.
    const reserved = await fetch(`${srv.base}/v1/admin/custom-providers/openai`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ ...BODY, validate: false }),
    });
    assert.equal(reserved.status, 400);
    assert.match(((await reserved.json()) as { message: string }).message, /reserved/);

    const piReserved = await fetch(`${srv.base}/v1/admin/custom-providers/deepseek`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ ...BODY, validate: false }),
    });
    assert.equal(piReserved.status, 400);
    assert.match(((await piReserved.json()) as { message: string }).message, /reserved/);

    const alias = await fetch(`${srv.base}/v1/admin/custom-providers/deepseek-local`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ ...BODY, models: [{ id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" }], validate: false }),
    });
    assert.equal(alias.status, 200);
    assert.equal(String(resolveModel("deepseek-v4-flash")?.provider), "deepseek-local");
  } finally {
    await srv.close();
  }
});
