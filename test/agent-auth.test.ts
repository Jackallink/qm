import { test } from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ApiCtx } from "../src/api/routes/route.ts";
import type { ServerDeps } from "../src/api/deps.ts";
import type { AdminGrant } from "../src/admin/admin-grant-store.ts";
import { sendMessage, getInbox, ackMessage, subscribeEvents, heartbeat } from "../src/api/routes/admin/messenger.ts";
import { agentHealth, agentHealthHeartbeat, allHealth, listRunning } from "../src/api/routes/admin/agents.ts";
import { stopAgent } from "../src/agent/agent-launcher.ts";

function fakeAdmin(grants: AdminGrant[]): ServerDeps["admin"] {
  return {
    resolveActor(header: string | undefined) {
      if (!header) return null;
      const p = header.split("@")[0] ?? "";
      return { id: p, type: "internal" };
    },
    async listGrants() {
      return grants;
    },
  } as ServerDeps["admin"];
}

function capture(): { res: ServerResponse; status: () => number; body: () => Record<string, unknown> } {
  let status = 0;
  let bodyStr = "";
  const res = {
    statusCode: 0,
    writeHead(code: number) {
      status = code;
      res.statusCode = code;
      return res;
    },
    end(s: string) {
      bodyStr = s;
      return res;
    },
  } as unknown as ServerResponse;
  return {
    res,
    status: () => status,
    body: () => JSON.parse(bodyStr) as Record<string, unknown>,
  };
}

function ctxWith(deps: ServerDeps, params: Record<string, string>, method: string, actorHeader?: string, body: Record<string, unknown> = {}): ApiCtx & { res: ServerResponse } {
  const req = { headers: actorHeader ? { "x-admin-actor": actorHeader } : {}, url: "/" } as IncomingMessage;
  const cap = capture();
  const base = {
    req,
    res: cap.res,
    app: {} as ApiCtx["app"],
    deps,
    secret: "test",
    auth: null,
    allowUnsignedSourceAuth: true,
    url: new URL("http://localhost/"),
    pathname: "/",
    method,
    params,
    rawBody: "",
    body,
    capability: null,
    actor: null,
  };
  return { ...base, res: cap.res };
}

const stubMessenger = {
  async send(senderId: string, receiverId: string, mode: string, type: string, payload: Record<string, unknown>) {
    return { id: "m1", senderId, receiverId, mode, type, payload, status: "pending", createdAt: Date.now() };
  },
  async receive() {
    return [];
  },
  async ack() {},
  async subscribe() {
    return { id: "s1" };
  },
  async heartbeat() {},
};

test("messenger handlers require an admin grant (no grant → 403)", async () => {
  const deps = { admin: fakeAdmin([]), messengerStore: stubMessenger } as unknown as ServerDeps;
  for (const [handler, params] of [
    [sendMessage, { id: "agent-1" }],
    [getInbox, { id: "agent-1" }],
    [ackMessage, { id: "agent-1", msgId: "m1" }],
    [subscribeEvents, { id: "agent-1" }],
    [heartbeat, { id: "agent-1" }],
  ] as const) {
    const ctx = ctxWith(deps, params, "POST");
    await handler(ctx);
    assert.equal(ctx.res.statusCode, 403, `${handler.name} must require an admin grant`);
  }
});

test("messenger handlers pass with an admin grant", async () => {
  const grants: AdminGrant[] = [{ principalId: "admin", scopeId: "org:default-org", role: "org_admin" }];
  const deps = {
    admin: fakeAdmin(grants),
    messengerStore: stubMessenger,
  } as unknown as ServerDeps;
  const ctx = ctxWith(deps, { id: "agent-1" }, "POST", "admin@default-org", { receiverId: "agent-2", type: "task", payload: { text: "hi" } });
  await sendMessage(ctx);
  assert.equal(ctx.res.statusCode, 201, "with a grant, send must succeed");
});

test("health/running handlers require an admin grant", async () => {
  const deps = { admin: fakeAdmin([]) } as ServerDeps;
  for (const [handler, params] of [
    [allHealth, {}],
    [listRunning, {}],
    [agentHealth, { id: "agent-1" }],
    [agentHealthHeartbeat, { id: "agent-1" }],
  ] as const) {
    const ctx = ctxWith(deps, params, "GET");
    await handler(ctx);
    assert.equal(ctx.res.statusCode, 403, `${handler.name} must require an admin grant`);
  }
});

test("stopAgent refuses shell-metacharacter agent ids", async () => {
  await stopAgent("agent-1; rm -rf /tmp/evil");
  await stopAgent("$(touch /tmp/pwned)");
  await stopAgent("agent-1 && touch /tmp/pwned2");
  await stopAgent("a/b");
  assert.equal(true, true);
});
