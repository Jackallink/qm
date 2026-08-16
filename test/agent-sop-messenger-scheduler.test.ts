import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createPostgresMapFactory } from "../src/persistence/durable-map.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createSopRunStore } from "../src/agent/sop-store.ts";
import { createMessengerStore } from "../src/agent/messenger-store.ts";
import { createSchedulerStore } from "../src/agent/scheduler-store.ts";
import { newSopRun } from "../src/agent/sop-engine.ts";

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "set DATABASE_URL (a Postgres) to run the agent mgmt pg tests";

test("SOP engine: create/sign freezes, rollback supersedes (memory)", async () => {
  const store = createSopRunStore(createMemoryMap());
  const id = `sop-${randomUUID()}`;
  const run = await store.create(newSopRun(id, "deepseek-v4-flash", "ws-1", "agent-1") as never);
  const signed = await store.signGate(id, 0, "operator-a");
  assert.equal(signed.status, "active");
  const rolled = await store.rollback(id, 0, "bad release");
  assert.ok(rolled.gates.some((g) => g.gate === 0 && g.status === "superseded"), "rolled-back gates must be superseded");
});

test("Messenger: send/receive/ack round-trip (memory)", async () => {
  const store = createMessengerStore(createMemoryMap(), createMemoryMap());
  const to = `agent-${randomUUID()}`;
  const sent = await store.send("qm-core", to, "event", "task", { text: "hello" });
  assert.ok(sent);
  const inbox = await store.receive(to);
  assert.ok(inbox.length >= 1);
  const msg = inbox[0]!;
  await store.ack(msg.id);
  const again = await store.receive(to);
  assert.equal(again.length, 0, "acked message must not be redelivered");
});

test("Scheduler: schedule/start/complete round-trip (memory)", async () => {
  const store = createSchedulerStore(createMemoryMap());
  const job = await store.schedule("agent-1", "ws-1", "*/5 * * * *");
  assert.ok(job.id);
  const started = await store.startRun(job.id);
  assert.ok(started);
  const done = await store.completeRun(job.id, true);
  assert.equal(done!.consecutiveFailures ?? 0, 0);
});

test("agent stores persist across instances (postgres)", { skip }, async () => {
  const factory = createPostgresMapFactory(URL!);
  const sop1 = createSopRunStore(factory.map("sop_runs_test"));
  const sop2 = createSopRunStore(factory.map("sop_runs_test"));
  const run = await sop1.create({
    id: `sop-${randomUUID()}`,
    modelId: "m",
    workspace: "ws-1",
    agentId: "a",
    currentGate: 1,
    status: "in_progress",
    version: 1,
    gates: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  } as never);
  const got = await sop2.get(run.id);
  assert.ok(got, "a second store instance on the same table must see the SOP run");
  await factory.pool.q("DROP TABLE sop_runs_test").catch(() => undefined);
  await factory.pool.close();
});
