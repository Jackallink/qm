import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { countTokens } from "../src/util/tokens.ts";
import { createPiHarness } from "../src/harness/pi-harness.ts";
import type { HarnessTurnInput } from "../src/harness/harness.ts";
import { createHarnessRouter, resolveRuntimeChoiceDurable } from "../src/harness/harness-router.ts";
import { setCustomProviders } from "../src/model/custom-providers.ts";
import { createMemoryConfigStore } from "../src/resolution/config-store.ts";

const RACE_A = {
  id: "race-gateway",
  name: "Race Gateway",
  protocol: "openai" as const,
  baseUrl: "https://old.example.com/v1",
  models: [{ id: "race-model", name: "Race Model" }],
};

const RACE_B = {
  ...RACE_A,
  baseUrl: "https://new.example.com/v1",
};

function snapshot(spec: typeof RACE_A, key: string) {
  return { providers: [spec], keys: { [spec.id]: key } };
}

function streamingReply(model: string, content: string): Response {
  return new Response(
    `data: ${JSON.stringify({
      id: "cmpl",
      object: "chat.completion.chunk",
      model,
      choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }],
    })}\n\ndata: ${JSON.stringify({
      id: "cmpl",
      object: "chat.completion.chunk",
      model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    })}\n\ndata: [DONE]\n\n`,
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

function countTempDirs(prefix: string): number {
  return readdirSync(tmpdir()).filter((name) => name.startsWith(prefix)).length;
}

function recordingTurn(
  systemPrompt: string,
  recorded: Array<{ model: string; inputTokens: number; entryCount: number }>,
  sessionId: string,
): HarnessTurnInput {
  return {
    session: { id: sessionId } as HarnessTurnInput["session"],
    input: "hi",
    systemPrompt,
    history: [],
    tools: {} as HarnessTurnInput["tools"],
    scopeLabel: "scope" as HarnessTurnInput["scopeLabel"],
    orgScopeId: "org:test" as HarnessTurnInput["orgScopeId"],
    emit: async (entry) => ({ ...entry, seq: 1 }) as Awaited<ReturnType<HarnessTurnInput["emit"]>>,
    recordModelCall: (rec) => recorded.push(rec),
  };
}

async function runIgnoringPromptError(
  harness: ReturnType<typeof createPiHarness>,
  turn: HarnessTurnInput,
): Promise<void> {
  try {
    await harness.turns.runTurn(turn);
  } catch {
    return;
  }
}

test("every turn composes the freshly resolved system prompt", async () => {
  const harness = createPiHarness();
  const recorded: Array<{ model: string; inputTokens: number; entryCount: number }> = [];
  const first = "BASE\n\n## What you remember\nA";
  const second = "BASE\n\n## What you remember\nBBBBBBBBBBBBBBBBBBBB";

  await runIgnoringPromptError(harness, recordingTurn(first, recorded, "fresh-prompt"));
  await runIgnoringPromptError(harness, recordingTurn(second, recorded, "fresh-prompt"));

  assert.equal(recorded[0]!.inputTokens, countTokens(first) + countTokens("hi"));
  assert.equal(recorded[1]!.inputTokens, countTokens(second) + countTokens("hi"));
});

test("each turn removes its isolated resource directories", async () => {
  const prefix = `pi-turn-${process.pid}`;
  const harness = createPiHarness({ tempDirPrefix: prefix });
  const recorded: Array<{ model: string; inputTokens: number; entryCount: number }> = [];

  await runIgnoringPromptError(harness, recordingTurn("BASE", recorded, "cleanup"));

  assert.equal(countTempDirs(`${prefix}-cwd-`), 0);
  assert.equal(countTempDirs(`${prefix}-agent-`), 0);
});

test("the Pi harness exposes no session-reset hook after removing session state", () => {
  assert.equal(createPiHarness().turns.resetSession, undefined);
});

test("ack emoji keeps working on a non-Anthropic base model when an Anthropic key is present", async () => {
  const harness = createPiHarness({
    defaultModelId: "gpt-5.6-sol",
    resolveProviderKeys: async () => ({ anthropic: "sk-ant-test" }),
  });
  const realFetch = globalThis.fetch;
  const calls: Array<{ url: string; model: unknown }> = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), model: JSON.parse(String(init?.body ?? "{}")).model });
    return new Response(JSON.stringify({ content: [{ type: "text", text: '{"emoji":"eyes"}' }] }), { status: 200 });
  }) as typeof globalThis.fetch;
  try {
    const picked = await harness.models.pickAckEmoji?.("ship it", ["eyes", "rocket"]);
    assert.equal(picked, "eyes", "the pick still lands even though the base model is OpenAI");
    assert.equal(calls.length, 1, "the Anthropic ack call was actually attempted");
    assert.match(calls[0]!.url, /anthropic/, "it went to the Anthropic API");
    assert.equal(calls[0]!.model, "claude-haiku-4-5", "it used the Anthropic auxiliary, not the OpenAI judge model");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("ack emoji stays home when the deployment has no Anthropic key at all", async () => {
  const harness = createPiHarness({
    defaultModelId: "gpt-5.6-sol",
    resolveProviderKeys: async () => ({ openai: "sk-openai-test" }),
  });
  const realFetch = globalThis.fetch;
  let called = 0;
  globalThis.fetch = (async () => {
    called += 1;
    return new Response("{}", { status: 200 });
  }) as typeof globalThis.fetch;
  try {
    assert.equal(await harness.models.pickAckEmoji?.("ship it", ["eyes"]), undefined);
    assert.equal(called, 0, "no Anthropic call without an Anthropic key");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("model utilities resolve provider credentials for every call", async () => {
  let resolutions = 0;
  const harness = createPiHarness({
    resolveProviderKeys: async () => {
      resolutions += 1;
      return {};
    },
  });

  assert.equal(await harness.models.oneShot?.("system", "first"), undefined);
  assert.equal(await harness.models.oneShot?.("system", "second"), undefined);
  assert.equal(resolutions, 2);
});

test("Pi refreshes custom providers before resolving a configured model", async () => {
  let refreshes = 0;
  const harness = createPiHarness({
    modelId: "fresh-model",
    refreshCustomProviders: async () => {
      refreshes += 1;
      setCustomProviders([
        {
          id: "fresh-gateway",
          name: "Fresh Gateway",
          protocol: "openai",
          baseUrl: "https://fresh.example.com/v1",
          models: [{ id: "fresh-model", name: "Fresh Model" }],
        },
      ]);
    },
    resolveProviderKeys: async () => ({ "fresh-gateway": "sk-fresh" }),
  });
  const realFetch = globalThis.fetch;
  const calls: Array<{ url: string; model: unknown }> = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), model: JSON.parse(String(init?.body ?? "{}")).model });
    return new Response("data: {\"id\":\"cmpl\",\"object\":\"chat.completion.chunk\",\"model\":\"fresh-model\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"fresh\"},\"finish_reason\":null}]}\n\ndata: {\"id\":\"cmpl\",\"object\":\"chat.completion.chunk\",\"model\":\"fresh-model\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n", {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as typeof globalThis.fetch;
  try {
    assert.equal(await harness.models.oneShot?.("system", "hello"), "fresh");
    assert.ok(refreshes > 0);
    assert.deepEqual(calls, [{ url: "https://fresh.example.com/v1/chat/completions", model: "fresh-model" }]);
  } finally {
    globalThis.fetch = realFetch;
    setCustomProviders([]);
  }
});

test("Pi oneShot keeps a custom model endpoint and key from one snapshot", async () => {
  let current = snapshot(RACE_A, "sk-old");
  setCustomProviders([RACE_A]);
  const harness = createPiHarness({
    modelId: "race-model",
    resolveCustomProviderSnapshot: async () => {
      const selected = current;
      current = snapshot(RACE_B, "sk-new");
      setCustomProviders([RACE_B]);
      return selected;
    },
  });
  const realFetch = globalThis.fetch;
  const calls: Array<{ url: string; auth?: string }> = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") ?? undefined });
    return streamingReply("race-model", "stable");
  }) as typeof globalThis.fetch;
  try {
    assert.equal(await harness.models.oneShot?.("system", "hello"), "stable");
    assert.deepEqual(calls, [{ url: "https://old.example.com/v1/chat/completions", auth: "Bearer sk-old" }]);
  } finally {
    globalThis.fetch = realFetch;
    setCustomProviders([]);
  }
});

test("Pi turn keeps a custom model endpoint and key from one snapshot", async () => {
  let current = snapshot(RACE_A, "sk-old");
  setCustomProviders([RACE_A]);
  const harness = createPiHarness({
    modelId: "race-model",
    resolveCustomProviderSnapshot: async () => {
      const selected = current;
      current = snapshot(RACE_B, "sk-new");
      setCustomProviders([RACE_B]);
      return selected;
    },
  });
  const realFetch = globalThis.fetch;
  const calls: Array<{ url: string; auth?: string }> = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") ?? undefined });
    return streamingReply("race-model", "stable");
  }) as typeof globalThis.fetch;
  try {
    const result = await harness.turns.runTurn(recordingTurn("BASE", [], "snapshot-turn"));
    assert.equal(result.reply, "stable");
    assert.deepEqual(calls, [{ url: "https://old.example.com/v1/chat/completions", auth: "Bearer sk-old" }]);
  } finally {
    globalThis.fetch = realFetch;
    setCustomProviders([]);
  }
});

test("the router leaves a persisted Pi custom model for its provider snapshot", async () => {
  const org = "org:test" as HarnessTurnInput["orgScopeId"];
  const scope = "personal:alice" as HarnessTurnInput["scopeLabel"];
  const config = createMemoryConfigStore("test");
  config.setApprovedHarnesses(["pi"]);
  await config.setRuntimeSelectionLatest(org, { harnessId: "pi", modelId: "race-model" });
  const pi = createPiHarness({ resolveCustomProviderSnapshot: async () => snapshot(RACE_A, "sk-old") });
  const router = createHarnessRouter(
    new Map([["pi", pi]]),
    pi,
    (input) =>
      resolveRuntimeChoiceDurable(config, org, input.scopeLabel, {
        harnessId: "pi",
        modelId: "claude-opus-4-8",
      }),
  );
  setCustomProviders([]);
  const realFetch = globalThis.fetch;
  const calls: Array<{ url: string; auth?: string }> = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") ?? undefined });
    return streamingReply("race-model", "stable");
  }) as typeof globalThis.fetch;
  try {
    const turn = recordingTurn("BASE", [], "router-custom-snapshot");
    turn.scopeLabel = scope;
    turn.orgScopeId = org;
    assert.equal((await router.turns.runTurn(turn)).reply, "stable");
    assert.deepEqual(calls, [{ url: "https://old.example.com/v1/chat/completions", auth: "Bearer sk-old" }]);
  } finally {
    globalThis.fetch = realFetch;
    setCustomProviders([]);
  }
});

test("Pi rejects a deleted custom model instead of falling back to a built-in", async () => {
  setCustomProviders([RACE_A]);
  const harness = createPiHarness({
    modelId: "race-model",
    resolveCustomProviderSnapshot: async () => {
      setCustomProviders([]);
      return { providers: [], keys: {} };
    },
  });
  let called = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    called += 1;
    return streamingReply("race-model", "wrong");
  }) as typeof globalThis.fetch;
  try {
    await assert.rejects(harness.turns.runTurn(recordingTurn("BASE", [], "deleted-custom-model")), /Unsupported model: race-model/);
    assert.equal(called, 0);
  } finally {
    globalThis.fetch = realFetch;
    setCustomProviders([]);
  }
});

test("prior-turn bootstrap is taped as a retry-idempotent import before the first prompt", async () => {
  const harness = createPiHarness();
  const records: Array<{ kind: string; payload: unknown }> = [];
  const turn = recordingTurn("BASE", [], "prior-bootstrap");
  turn.priorTurns = [
    { role: "assistant", text: "I opened this thread with the release result" },
    { role: "user", name: "Jordan", text: "tell me more" },
  ];
  turn.tape = async (record) => {
    records.push({ kind: record.kind, payload: record.payload });
  };
  await runIgnoringPromptError(harness, turn);
  const bootstrap = records.filter((record) => record.kind === "context_event");
  assert.equal(bootstrap.length, 1);
  assert.equal((bootstrap[0]!.payload as { event?: string }).event, "legacy_import");
  assert.match(JSON.stringify(bootstrap[0]), /release result/);
  assert.match(JSON.stringify(bootstrap[0]), /tell me more/);
});
