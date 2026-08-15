import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  setCustomProviders,
  resolveCustomModel,
  isCustomModelId,
  customModelCatalog,
  customModelsJson,
  customProvidersVersion,
  validateCustomProviderSpec,
} from "../src/model/custom-providers.ts";
import { builtInModelCatalog } from "../src/model/model-catalog.ts";
import { createCustomProviderStore } from "../src/model/custom-provider-store.ts";
import { modelSupportedByHarness, modelServiceable, resolveModel } from "../src/model/pi-models.ts";
import { createMemoryAdvisoryLock } from "../src/persistence/advisory-lock.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import type { StoredCustomProvider } from "../src/model/custom-provider-store.ts";
import { stream as streamOpenAICompletions } from "@earendil-works/pi-ai/api/openai-completions";
import type { Context, Model } from "@earendil-works/pi-ai";

afterEach(() => setCustomProviders([]));

const GATEWAY = {
  id: "acme-gateway",
  name: "Acme Gateway",
  protocol: "openai" as const,
  baseUrl: "https://llm.acme.internal/v1",
  models: [{ id: "acme-large", name: "Acme Large", contextWindow: 200_000, maxTokens: 16_000, input: 2, output: 8 }],
};

test("a registered custom model resolves with the provider's protocol and base URL", () => {
  setCustomProviders([GATEWAY]);
  const model = resolveCustomModel("acme-large");
  assert.ok(model);
  assert.equal(model.provider, "acme-gateway");
  assert.equal(model.api, "openai-completions");
  assert.equal(model.baseUrl, "https://llm.acme.internal/v1");
  assert.equal(model.contextWindow, 200_000);
  assert.equal(model.cost.input, 2);
});

test("anthropic-protocol providers produce anthropic-messages models with defaults", () => {
  setCustomProviders([
    {
      id: "eu-anthropic",
      name: "EU Anthropic-compatible",
      protocol: "anthropic",
      baseUrl: "https://eu.example.com",
      models: [{ id: "eu-claude" }],
    },
  ]);
  const model = resolveCustomModel("eu-claude");
  assert.ok(model);
  assert.equal(model.api, "anthropic-messages");
  assert.equal(model.contextWindow, 128_000);
  assert.equal(model.cost.input, 0);
});

test("resolveModel falls back to custom models; built-ins shadow custom ids", () => {
  setCustomProviders([{ ...GATEWAY, models: [{ id: "acme-large" }, { id: "claude-opus-5", name: "impostor" }] }]);
  assert.equal(resolveModel("acme-large")?.provider, "acme-gateway");
  // The built-in claude-opus-5 must win over a custom model claiming its id.
  assert.equal(String(resolveModel("claude-opus-5")?.provider), "anthropic");
});

test("reserved QM model ids are rejected and ignored as custom models", () => {
  for (const id of ["gpt-4o-mini", "claude-opus-5", "gpt-5.6-sol"]) {
    const collision = { ...GATEWAY, models: [{ id, name: "Gateway model" }] };
    assert.throws(() => validateCustomProviderSpec(collision), /conflicts with a built-in model/);
    setCustomProviders([collision]);
    assert.equal(isCustomModelId(id), false);
    assert.equal(customModelCatalog().some((model) => model.id === id), false);
  }
});

test("duplicate custom model ids are ignored by the runtime registry", () => {
  setCustomProviders([
    GATEWAY,
    {
      ...GATEWAY,
      id: "second-gateway",
      models: [{ id: "acme-large", name: "Second Acme Large" }],
    },
  ]);
  assert.equal(isCustomModelId("acme-large"), false);
  assert.equal(customModelCatalog().some((model) => model.id === "acme-large"), false);
});

test("custom models are gated to pi and mock harnesses", () => {
  setCustomProviders([GATEWAY]);
  assert.equal(modelSupportedByHarness("acme-large", "pi"), true);
  assert.equal(modelSupportedByHarness("acme-large", "mock"), true);
  assert.equal(modelSupportedByHarness("acme-large", "claude"), false);
  assert.equal(modelSupportedByHarness("acme-large", "codex"), false);
  assert.equal(modelSupportedByHarness("acme-large", "opencode"), false);
});

test("a registered custom model is serviceable regardless of built-in key availability", () => {
  setCustomProviders([GATEWAY]);
  assert.equal(modelServiceable("acme-large", { anthropic: false, openai: false, openrouter: false }), true);
});

test("catalog lists custom models; clearing the registry removes them", () => {
  setCustomProviders([GATEWAY]);
  assert.deepEqual(customModelCatalog(), [{ id: "acme-large", name: "Acme Large", provider: "acme-gateway" }]);
  setCustomProviders([]);
  assert.equal(isCustomModelId("acme-large"), false);
  assert.equal(resolveModel("acme-large"), undefined);
});

test("spec validation rejects reserved ids, bad slugs, bad URLs, and empty model lists", () => {
  assert.throws(() => validateCustomProviderSpec({ ...GATEWAY, id: "openai" }), /reserved/);
  assert.throws(() => validateCustomProviderSpec({ ...GATEWAY, id: "deepseek" }), /reserved/);
  assert.throws(() => validateCustomProviderSpec({ ...GATEWAY, id: "radius" }), /reserved/);
  assert.throws(() => validateCustomProviderSpec({ ...GATEWAY, id: "Not A Slug" }), /slug/);
  assert.throws(() => validateCustomProviderSpec({ ...GATEWAY, baseUrl: "ftp://x" }), /http/);
  assert.throws(() => validateCustomProviderSpec({ ...GATEWAY, baseUrl: "https://x?y=1" }), /query/);
  assert.throws(() => validateCustomProviderSpec({ ...GATEWAY, models: [] }), /at least one model/);
  assert.throws(() => validateCustomProviderSpec({ ...GATEWAY, models: [{ id: "a" }, { id: "a" }] }), /duplicate/);
});

test("store round-trip: upsert encrypts the key, statuses never leak it, delete disables", async () => {
  const backing = createMemoryMap<StoredCustomProvider>();
  const store = createCustomProviderStore({ backing, keyMaterial: "test-key-material" });

  await store.upsert(GATEWAY, "sk-secret-123", "admin@example.com");
  const statuses = await store.statuses();
  assert.equal(statuses.length, 1);
  assert.equal(statuses[0]!.hasKey, true);
  assert.equal(JSON.stringify(statuses).includes("sk-secret-123"), false);

  const raw = await backing.get("acme-gateway");
  assert.ok(raw?.apiKeyEnc);
  assert.equal(raw!.apiKeyEnc!.includes("sk-secret-123"), false);

  assert.equal(await store.resolveKey("acme-gateway"), "sk-secret-123");
  assert.deepEqual(await store.enabled(), [GATEWAY]);

  // Upsert without a key keeps the existing one.
  await store.upsert({ ...GATEWAY, name: "Renamed" }, undefined, "admin@example.com");
  assert.equal(await store.resolveKey("acme-gateway"), "sk-secret-123");

  assert.equal(await store.delete("acme-gateway", "admin@example.com"), true);
  assert.equal(await store.resolveKey("acme-gateway"), null);
  assert.deepEqual(await store.enabled(), []);
  assert.equal((await store.statuses())[0]!.disabled, true);
  assert.equal(await store.delete("never-existed", "admin@example.com"), false);
});

test("store validates specs on upsert", async () => {
  const store = createCustomProviderStore({
    backing: createMemoryMap<StoredCustomProvider>(),
    keyMaterial: "k",
  });
  await assert.rejects(store.upsert({ ...GATEWAY, id: "anthropic" }, "k", "a@b.c"), /reserved/);
});

test("store excludes legacy custom model ids that collide with QM-managed models", async () => {
  const backing = createMemoryMap<StoredCustomProvider>();
  await backing.put("acme-gateway", {
    ...GATEWAY,
    models: [
      { id: "gpt-4o-mini", name: "Gateway GPT" },
      { id: "claude-opus-5", name: "Gateway Claude" },
    ],
    disabled: false,
    updatedAt: 1,
    updatedBy: "admin@example.com",
  });
  const store = createCustomProviderStore({ backing, keyMaterial: "k" });
  assert.deepEqual(await store.enabled(), []);
});

test("a custom provider alias can use a Pi-native model id", () => {
  const provider = {
    ...GATEWAY,
    id: "deepseek-local",
    name: "DeepSeek Local",
    models: [{ id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" }],
  };
  validateCustomProviderSpec(provider);
  setCustomProviders([provider]);
  assert.equal(resolveModel("deepseek-v4-flash")?.provider, "deepseek-local");
});

test("a DeepSeek alias preserves thinking and tool replay semantics", async () => {
  const provider = {
    ...GATEWAY,
    id: "deepseek-local",
    name: "DeepSeek Local",
    models: [{ id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" }],
  };
  setCustomProviders([provider]);
  const model = resolveModel("deepseek-v4-flash");
  assert.ok(model);
  const compat = model.compat as
    | { thinkingFormat?: string; requiresReasoningContentOnAssistantMessages?: boolean }
    | undefined;
  assert.equal(model.reasoning, true);
  assert.equal(compat?.thinkingFormat, "deepseek");
  assert.equal(compat?.requiresReasoningContentOnAssistantMessages, true);
  assert.equal(model.thinkingLevelMap?.high, "high");
  const modelJson = customModelsJson();
  const modelJsonEntry = (
    modelJson?.providers["deepseek-local"] as { models?: Array<{ reasoning?: boolean; compat?: { thinkingFormat?: string } }> }
  ).models?.[0];
  assert.equal(modelJsonEntry?.reasoning, true);
  assert.equal(modelJsonEntry?.compat?.thinkingFormat, "deepseek");

  const context = {
    systemPrompt: "Use the tool result.",
    messages: [
      { role: "user", content: "Look this up.", timestamp: 1 },
      {
        role: "assistant",
        api: "openai-completions",
        provider: "deepseek-local",
        model: "deepseek-v4-flash",
        content: [{ type: "toolCall", id: "call_1", name: "lookup", arguments: {} }],
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "toolUse",
        timestamp: 2,
      },
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "lookup",
        content: [{ type: "text", text: "found it" }],
        isError: false,
        timestamp: 3,
      },
    ],
    tools: [{ name: "lookup", description: "Looks up a record.", parameters: { type: "object", properties: {} } }],
  } as unknown as Context;
  const realFetch = globalThis.fetch;
  let payload: Record<string, unknown> | undefined;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    payload = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    return new Response(
      `data: ${JSON.stringify({ id: "cmpl", object: "chat.completion.chunk", model: "deepseek-v4-flash", choices: [{ index: 0, delta: { role: "assistant", content: "done" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "cmpl", object: "chat.completion.chunk", model: "deepseek-v4-flash", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  }) as typeof globalThis.fetch;
  try {
    await streamOpenAICompletions(model as Model<"openai-completions">, context, {
      apiKey: "sk-deepseek-local",
      reasoningEffort: "high",
    }).result();
    assert.deepEqual(payload?.thinking, { type: "enabled" });
    assert.equal(payload?.reasoning_effort, "high");
    const assistant = (payload?.messages as Array<{ role?: string; reasoning_content?: string }>).find(
      (message) => message.role === "assistant",
    );
    assert.equal(assistant?.reasoning_content, "");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a legacy Pi provider slug remains available until an explicit migration", async () => {
  const backing = createMemoryMap<StoredCustomProvider>();
  await backing.put("deepseek", {
    id: "deepseek",
    name: "DeepSeek",
    protocol: "openai",
    baseUrl: "https://api.deepseek.com",
    models: [{ id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" }],
    disabled: false,
    updatedAt: 1,
    updatedBy: "admin@example.com",
  });
  const store = createCustomProviderStore({ backing, keyMaterial: "k" });
  assert.deepEqual((await store.enabled()).map((provider) => provider.id), ["deepseek"]);
});

test("legacy core-provider records cannot enter a runtime snapshot", async () => {
  const backing = createMemoryMap<StoredCustomProvider>();
  const store = createCustomProviderStore({ backing, keyMaterial: "k" });
  await store.upsert(GATEWAY, "sk-custom", "admin@example.com");
  const saved = await backing.get("acme-gateway");
  assert.ok(saved);
  await backing.delete("acme-gateway");
  await backing.put("openai", {
    ...saved,
    id: "openai",
    name: "Legacy OpenAI",
    models: [{ id: "legacy-openai-model" }],
  });
  await backing.put("deepseek", {
    ...saved,
    id: "deepseek",
    name: "Legacy DeepSeek",
    models: [{ id: "deepseek-v4-flash" }],
  });

  assert.deepEqual((await store.enabled()).map((provider) => provider.id), ["deepseek"]);
  const snapshot = await store.runtimeSnapshot();
  assert.deepEqual(snapshot.providers.map((provider) => provider.id), ["deepseek"]);
  assert.deepEqual(snapshot.keys, { deepseek: "sk-custom" });
});

test("a grandfathered Pi provider can rotate its key but cannot be recreated after deletion", async () => {
  const backing = createMemoryMap<StoredCustomProvider>();
  const store = createCustomProviderStore({ backing, keyMaterial: "k" });
  const alias = { ...GATEWAY, id: "deepseek-local", models: [{ id: "deepseek-v4-flash" }] };
  await store.upsert(alias, "sk-old", "admin@example.com");
  const saved = await backing.get("deepseek-local");
  assert.ok(saved);
  await backing.delete("deepseek-local");
  await backing.put("deepseek", { ...saved, id: "deepseek", name: "DeepSeek" });
  const legacy = { ...alias, id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com" };

  assert.equal(await store.canUpdateGrandfatheredProvider("deepseek"), true);
  await store.upsert(legacy, "sk-new", "admin@example.com");
  assert.equal(await store.resolveKey("deepseek"), "sk-new");

  await store.delete("deepseek", "admin@example.com");
  assert.equal(await store.canUpdateGrandfatheredProvider("deepseek"), false);
  await assert.rejects(store.upsert(legacy, "sk-newer", "admin@example.com"), /reserved/);

  await backing.put("openai", { ...saved, id: "openai", name: "OpenAI" });
  await assert.rejects(
    store.upsert({ ...alias, id: "openai", name: "OpenAI" }, "sk-openai", "admin@example.com"),
    /reserved/,
  );
});

test("store rejects a custom model id already used by another enabled provider", async () => {
  const store = createCustomProviderStore({
    backing: createMemoryMap<StoredCustomProvider>(),
    keyMaterial: "k",
  });
  await store.upsert(GATEWAY, "k", "admin@example.com");
  await assert.rejects(
    store.upsert(
      {
        ...GATEWAY,
        id: "second-gateway",
        models: [{ id: "acme-large", name: "Second Acme Large" }],
      },
      "k",
      "admin@example.com",
    ),
    /already registered by provider/,
  );
});

test("store requires a new key before an endpoint or protocol change", async () => {
  const store = createCustomProviderStore({
    backing: createMemoryMap<StoredCustomProvider>(),
    keyMaterial: "k",
  });
  await store.upsert(GATEWAY, "sk-original", "admin@example.com");
  await assert.rejects(
    store.upsert({ ...GATEWAY, baseUrl: "https://replacement.example.com/v1" }, undefined, "admin@example.com"),
    /requires a new API key/,
  );
  assert.equal(await store.resolveKey("acme-gateway"), "sk-original");
  assert.equal((await store.enabled())[0]!.baseUrl, GATEWAY.baseUrl);
});

test("shared mutation lock allows only one concurrent provider to claim a model id", async () => {
  const backing = createMemoryMap<StoredCustomProvider>();
  const advisoryLock = createMemoryAdvisoryLock();
  const first = createCustomProviderStore({ backing, keyMaterial: "k", advisoryLock });
  const second = createCustomProviderStore({ backing, keyMaterial: "k", advisoryLock });
  let arrived = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const claim = async (store: typeof first, spec: typeof GATEWAY): Promise<void> => {
    arrived++;
    if (arrived === 2) release();
    await gate;
    await store.upsert(spec, "k", "admin@example.com");
  };
  const results = await Promise.allSettled([
    claim(first, GATEWAY),
    claim(second, { ...GATEWAY, id: "second-gateway", name: "Second Gateway" }),
  ]);
  assert.deepEqual(
    results.map((result) => result.status).sort(),
    ["fulfilled", "rejected"],
  );
  assert.equal((await first.enabled()).length, 1);
});

test("shared mutation lock serializes deletion before a replacement model claim", async () => {
  const backing = createMemoryMap<StoredCustomProvider>();
  const advisoryLock = createMemoryAdvisoryLock();
  const first = createCustomProviderStore({ backing, keyMaterial: "k", advisoryLock });
  const second = createCustomProviderStore({ backing, keyMaterial: "k", advisoryLock });
  await first.upsert(GATEWAY, "k", "admin@example.com");
  const results = await Promise.allSettled([
    first.delete("acme-gateway", "admin@example.com"),
    second.upsert(
      { ...GATEWAY, id: "second-gateway", name: "Second Gateway" },
      "k",
      "admin@example.com",
    ),
  ]);
  assert.deepEqual(results.map((result) => result.status), ["fulfilled", "fulfilled"]);
  assert.deepEqual(
    (await first.enabled()).map((provider) => provider.id),
    ["second-gateway"],
  );
});

test("registered models surface in the catalog and vanish on unregister", () => {
  setCustomProviders([
    {
      id: "deepseek",
      name: "DeepSeek",
      protocol: "openai",
      baseUrl: "https://api.deepseek.com/v1",
      models: [{ id: "deepseek-chat", name: "DeepSeek Chat" }],
    },
  ]);
  const catalog = builtInModelCatalog();
  const entry = catalog.find((m) => m.id === "deepseek-chat");
  assert.ok(entry, "custom model appears in the catalog");
  assert.equal(entry!.provider, "deepseek");
  setCustomProviders([]);
  assert.ok(!builtInModelCatalog().some((m) => m.id === "deepseek-chat"));
});

test("opencode modelRef routes slashed custom model ids to the registered provider, not a phantom slash-prefix", async () => {
  const { modelRef } = await import("../src/harness/opencode-harness.ts");
  setCustomProviders([
    {
      id: "litellm",
      name: "LiteLLM",
      protocol: "openai",
      baseUrl: "https://litellm.example.com/v1",
      models: [{ id: "bedrock/claude-opus-5" }],
    },
  ]);
  try {
    assert.deepEqual(modelRef("bedrock/claude-opus-5"), { providerID: "litellm", modelID: "bedrock/claude-opus-5" });
    // built-in slash convention untouched
    assert.deepEqual(modelRef("openrouter/auto"), { providerID: "openrouter", modelID: "auto" });
  } finally {
    setCustomProviders([]);
  }
});

test("catalog cache invalidates immediately when the custom registry changes", async () => {
  const { selectableModelCatalog } = await import("../src/model/model-catalog.ts");
  const fetcher: typeof fetch = async () => new Response(JSON.stringify({ data: [] }), { status: 200 });
  setCustomProviders([]);
  const before = await selectableModelCatalog(fetcher);
  assert.ok(!before.some((m) => m.id === "fresh-model"));
  setCustomProviders([
    {
      id: "freshco",
      name: "FreshCo",
      protocol: "openai",
      baseUrl: "https://fresh.example.com/v1",
      models: [{ id: "fresh-model" }],
    },
  ]);
  try {
    const after = await selectableModelCatalog(fetcher);
    assert.ok(
      after.some((m) => m.id === "fresh-model"),
      "new registration visible without waiting out the TTL",
    );
  } finally {
    setCustomProviders([]);
  }
  const cleared = await selectableModelCatalog(fetcher);
  assert.ok(!cleared.some((m) => m.id === "fresh-model"), "removal visible immediately too");
});

test("a failed OpenRouter refresh still applies the current custom-provider registry", async () => {
  const { selectableModelCatalog } = await import("../src/model/model-catalog.ts");
  let fail = false;
  const fetcher: typeof fetch = async () =>
    fail
      ? new Response(null, { status: 503 })
      : new Response(JSON.stringify({ data: [{ id: "deepseek/deepseek-chat-v3.1", name: "Fresh", supported_parameters: ["tools"] }] }), {
          status: 200,
        });
  const stale = { ...GATEWAY, models: [{ id: "stale-model", name: "Stale Model" }] };
  const fresh = { ...GATEWAY, id: "fresh-gateway", models: [{ id: "fresh-model", name: "Fresh Model" }] };
  setCustomProviders([stale]);
  const initial = await selectableModelCatalog(fetcher);
  assert.ok(initial.some((model) => model.id === "stale-model"));
  setCustomProviders([fresh]);
  fail = true;
  const updated = await selectableModelCatalog(fetcher);
  assert.ok(updated.some((model) => model.id === "fresh-model"));
  assert.equal(updated.some((model) => model.id === "stale-model"), false);
  assert.ok(updated.some((model) => model.id === "deepseek/deepseek-chat-v3.1"));
});

test("unchanged durable provider snapshots do not invalidate the custom registry", () => {
  setCustomProviders([]);
  const before = customProvidersVersion();
  setCustomProviders([GATEWAY]);
  const afterFirst = customProvidersVersion();
  setCustomProviders([{ ...GATEWAY, models: [...GATEWAY.models] }]);
  assert.ok(afterFirst > before);
  assert.equal(customProvidersVersion(), afterFirst);
});
