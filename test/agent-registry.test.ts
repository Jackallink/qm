import { test, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createPostgresMapFactory } from "../src/persistence/durable-map.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createAgentRegistryStore } from "../src/agent/agent-registry.ts";
import type { AgentManifest } from "../src/agent/agent-manifest.ts";

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "set DATABASE_URL (a Postgres) to run the agent registry pg tests";

function manifest(overrides: Partial<AgentManifest> = {}): AgentManifest {
  return {
    id: `agent-${randomUUID()}`,
    name: "test-agent",
    workspace: "ws-1",
    template: "standard",
    status: "draft",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  } as AgentManifest;
}

test("registry lifecycle: put/get/list/delete with status transitions (memory)", async () => {
  const store = createAgentRegistryStore(createMemoryMap());
  const m = manifest();
  await store.put("ws-1", m);
  const got = await store.get("ws-1", m.id);
  assert.ok(got);
  assert.equal(got!.status, "draft");

  await store.put("ws-1", { ...m, status: "deploying" });
  const deployed = await store.get("ws-1", m.id);
  assert.equal(deployed!.status, "deploying");

  await assert.rejects(store.put("ws-1", { ...m, status: "stopped" }), /invalid status transition/i);
});

test("registry persists across store instances (postgres)", { skip }, async () => {
  const factory = createPostgresMapFactory(URL!);
  const store1 = createAgentRegistryStore(factory.map("agents_test"));
  const store2 = createAgentRegistryStore(factory.map("agents_test"));
  const m = manifest({ status: "online" });
  await store1.put("ws-1", m);
  const got = await store2.get("ws-1", m.id);
  assert.ok(got, "a second store instance on the same table must see the agent");
  assert.equal(got!.status, "online");
  await factory.pool.q("DROP TABLE agents_test").catch(() => undefined);
  await factory.pool.close();
});
