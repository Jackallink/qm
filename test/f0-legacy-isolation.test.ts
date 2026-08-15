import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { loadConfig } from "../src/config.ts";
import { createServer } from "../src/api/server.ts";
import { apiRoutes } from "../src/api/routes/index.ts";
import { findRoute } from "../src/api/routes/route.ts";
import { createMemoryConfigStore } from "../src/resolution/config-store.ts";
import type { PersistedApprovedHarnesses, PersistedBaseModel } from "../src/resolution/config-store.ts";
import { resolveRuntimeChoice, resolveRuntimeChoiceDurable } from "../src/harness/harness-router.ts";
import { HARNESS_IDS, isHarnessId } from "../src/model/pi-models.ts";
import { signedHeaders } from "../plugins/chassis/src/core-client.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { testConfig } from "./support/test-config.ts";

const unexpectedFactory = (name: string) => () => {
  throw new Error(`legacy factory invoked: ${name}`);
};

mock.module(new URL("../src/harness/prime-harness.ts", import.meta.url).href, {
  namedExports: { createPrimeHarness: unexpectedFactory("prime") },
});
mock.module(new URL("../src/harness/hermes-harness.ts", import.meta.url).href, {
  namedExports: { createHermesHarness: unexpectedFactory("hermes") },
});
mock.module(new URL("../src/harness/claw-harness.ts", import.meta.url).href, {
  namedExports: { createClawHarness: unexpectedFactory("claw") },
});
mock.module(new URL("../src/agent/agent-registry.ts", import.meta.url).href, {
  namedExports: { createAgentRegistryStore: unexpectedFactory("agent registry") },
});
mock.module(new URL("../src/agent/sop-store.ts", import.meta.url).href, {
  namedExports: { createSopRunStore: unexpectedFactory("SOP store") },
});
mock.module(new URL("../src/agent/messenger-store.ts", import.meta.url).href, {
  namedExports: { createMessengerStore: unexpectedFactory("messenger store") },
});
mock.module(new URL("../src/agent/scheduler-store.ts", import.meta.url).href, {
  namedExports: { createSchedulerStore: unexpectedFactory("Agent Scheduler store") },
});

const { buildApp } = await import("../src/wiring.ts");

const ORG = "org:default-org" as const;
const PERSONAL = "personal:f0-user" as const;
const FALLBACK = { harnessId: "pi" as const, modelId: "gpt-5.6-sol" };

test("legacy runtime identifiers and environment options cannot enter normal runtime selection", () => {
  for (const id of ["prime", "hermes", "claw"]) {
    assert.equal(HARNESS_IDS.includes(id as never), false, `${id} must not be a current harness`);
    assert.equal(isHarnessId(id), false, `${id} must not pass request or persisted selection validation`);
  }
  const config = loadConfig({
    PRIME_MODEL: "legacy-model",
    PRIME_BIN: "/tmp/legacy-bin",
    PRIME_SESSION_DIR: "/tmp/legacy-session",
    PRIME_ARGS: "--unsafe",
    PRIME_SANDBOX: "true",
    HERMES_BASE_URL: "https://legacy.example",
    HERMES_MODEL: "legacy-model",
    HERMES_API_KEY: "legacy-key",
    CLAW_BASE_URL: "https://legacy.example",
    CLAW_MODEL: "legacy-model",
    CLAW_API_TOKEN: "legacy-token",
  });
  for (const key of [
    "primeModel",
    "primeBinPath",
    "primeSessionDir",
    "primeArgs",
    "primeSandbox",
    "hermesBaseUrl",
    "hermesModel",
  ])
    assert.equal(key in config, false, `${key} must not be a runtime configuration field`);
});

test("legacy persisted and requested runtime selections cannot reactivate a legacy adapter", async () => {
  const baseModels = createMemoryMap<PersistedBaseModel>();
  const approvedHarnesses = createMemoryMap<PersistedApprovedHarnesses>();
  const config = createMemoryConfigStore("default-org", { baseModels, approvedHarnesses });
  config.setApprovedHarnesses(["prime", "codex"]);
  config.setRuntimeSelection(ORG, { harnessId: "prime", modelId: "gpt-5.6-sol" });
  assert.deepEqual(resolveRuntimeChoice(config, ORG, PERSONAL, FALLBACK), {
    harnessId: "codex",
    modelId: "gpt-5.6-sol",
  });
  assert.throws(
    () =>
      resolveRuntimeChoice(config, ORG, PERSONAL, FALLBACK, {
        harnessId: "prime" as never,
        modelId: "gpt-5.6-sol",
      }),
    /not approved/,
  );

  await config.flushScope(ORG);
  const reader = createMemoryConfigStore("default-org", {
    baseModels,
    approvedHarnesses,
  });
  assert.deepEqual(await resolveRuntimeChoiceDurable(reader, ORG, PERSONAL, FALLBACK), {
    harnessId: "codex",
    modelId: "gpt-5.6-sol",
  });

  const legacyOnly = createMemoryConfigStore("default-org");
  legacyOnly.setApprovedHarnesses(["prime"]);
  legacyOnly.setRuntimeSelection(ORG, { harnessId: "prime", modelId: "gpt-5.6-sol" });
  assert.deepEqual(resolveRuntimeChoice(legacyOnly, ORG, PERSONAL, FALLBACK), FALLBACK);
});

test("production wiring has no legacy adapters or legacy control-plane stores", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "f0-isolation-")) }));
  try {
    for (const key of ["agentRegistry", "sopStore", "messengerStore", "schedulerStore"])
      assert.equal(key in built, false, `${key} must not be exposed by buildApp`);
  } finally {
    await built.runtime.stop();
  }
});

test("legacy Agent control-plane paths are absent from the route table and HTTP surface", async () => {
  const legacyRoutes: ReadonlyArray<readonly [string, string]> = [
    ["GET", "/v1/agent-templates"],
    ["GET", "/v1/admin/workspaces/workspace/agents"],
    ["POST", "/v1/admin/workspaces/workspace/agents"],
    ["GET", "/v1/admin/workspaces/workspace/agents/agent"],
    ["PUT", "/v1/admin/workspaces/workspace/agents/agent"],
    ["DELETE", "/v1/admin/workspaces/workspace/agents/agent"],
    ["GET", "/v1/admin/agents/health"],
    ["GET", "/v1/admin/agents/agent/health"],
    ["POST", "/v1/admin/agents/agent/control-heartbeat"],
    ["GET", "/v1/admin/agents/running"],
    ["GET", "/v1/admin/workspaces/workspace/sop-runs"],
    ["POST", "/v1/admin/workspaces/workspace/sop-runs"],
    ["GET", "/v1/sop-runs/run"],
    ["POST", "/v1/sop-runs/run/gates/gate/sign"],
    ["POST", "/v1/sop-runs/run/gates/gate/rollback"],
    ["GET", "/v1/sop-runs/run/history"],
    ["POST", "/v1/admin/agents/agent/messages"],
    ["GET", "/v1/admin/agents/agent/inbox"],
    ["POST", "/v1/admin/agents/agent/inbox/message/ack"],
    ["POST", "/v1/admin/agents/agent/subscribe"],
    ["POST", "/v1/admin/agents/agent/heartbeat"],
    ["GET", "/v1/admin/scheduler/jobs"],
    ["POST", "/v1/admin/scheduler/jobs"],
    ["POST", "/v1/admin/scheduler/jobs/job/pause"],
    ["POST", "/v1/admin/scheduler/jobs/job/resume"],
    ["POST", "/v1/admin/scheduler/check-loop"],
    ["POST", "/v1/admin/emergency/skills/skill/disable"],
    ["POST", "/v1/admin/emergency/agents/agent/revoke-tokens"],
    ["POST", "/v1/admin/emergency/circuit-break"],
    ["POST", "/v1/admin/emergency/sessions/session/kill"],
    ["GET", "/v1/admin/dashboard/summary"],
    ["GET", "/v1/admin/dashboard/token-trends"],
    ["GET", "/v1/admin/dashboard/agent-activity"],
  ];
  for (const [method, pathname] of legacyRoutes)
    assert.equal(findRoute(apiRoutes, method, pathname), null, `${method} ${pathname} must be absent`);

  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "f0-http-")) }));
  const secret = "f0-route-isolation-secret".repeat(3);
  const server = createServer(built.app, { signingSecret: secret, runs: built.runs, sessions: built.sessions });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  try {
    const port = (server.address() as AddressInfo).port;
    for (const [method, pathname] of legacyRoutes) {
      const body = method === "GET" || method === "DELETE" ? undefined : "{}";
      const response = await fetch(`http://localhost:${port}${pathname}`, {
        method,
        headers: {
          ...signedHeaders(secret, method, pathname, body ?? ""),
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { body } : {}),
      });
      assert.equal(response.status, 404, `${method} ${pathname} must remain unreachable over HTTP`);
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await built.runtime.stop();
  }
});

test("an approved current harness still completes a normal QM turn", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "f0-normal-turn-")) }));
  try {
    built.config.setApprovedHarnesses(["mock"]);
    const result = await built.app.turn({
      surface: "test",
      actor: { externalId: "f0-user" },
      conversation: { kind: "dm", threadRef: "f0:normal-turn" },
      text: "normal approved turn",
    });
    assert.equal(result.status, "ok");
  } finally {
    await built.runtime.stop();
  }
});

test("a mock deployment never dispatches a durable real runtime selection", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "f0-mock-only-turn-")) }));
  try {
    built.config.setApprovedHarnesses(["pi"]);
    await built.config.setRuntimeSelectionLatest(ORG, { harnessId: "pi", modelId: "claude-opus-4-8" });
    await built.config.setRuntimeSelectionLatest(PERSONAL, { harnessId: "pi", modelId: "claude-sonnet-5" });
    await built.config.flushScope(ORG);
    await built.config.flushScope(PERSONAL);

    const result = await built.app.turn({
      surface: "test",
      actor: { externalId: "f0-user" },
      conversation: { kind: "dm", threadRef: "f0:mock-only-turn" },
      text: "mock deployment remains mock",
    });
    assert.equal(result.status, "ok");
    assert.match(result.reply ?? "", /You said: mock deployment remains mock/);
  } finally {
    await built.runtime.stop();
  }
});
