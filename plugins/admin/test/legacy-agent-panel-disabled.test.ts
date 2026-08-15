import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

const coreCalls: string[] = [];
const core = createServer((req: IncomingMessage, res) => {
  coreCalls.push(req.url ?? "");
  req.resume();
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
});
await new Promise<void>((resolve) => core.listen(0, resolve));
process.env.CORE_API_URL = `http://localhost:${(core.address() as AddressInfo).port}`;
process.env.CORE_SIGNING_SECRET = "legacy-panel-test-secret";

const { server } = await import("../src/index.ts");
await new Promise<void>((resolve) => server.listen(0, resolve));
const base = `http://localhost:${(server.address() as AddressInfo).port}`;

test.after(() => {
  server.close();
  core.close();
});

test("legacy Agent panel and proxy paths are absent and never reach core", async () => {
  assert.equal((await fetch(`${base}/`, { headers: { cookie: "admin=U-admin" } })).status, 200);
  const legacyCalls = () => coreCalls.filter((path) => path.startsWith("/v1/agent-templates") || path.startsWith("/v1/admin/"));
  const callsBefore = legacyCalls();
  const requests: ReadonlyArray<readonly [string, string]> = [
    ["GET", "/agents"],
    ["GET", "/agents/"],
    ["GET", "/api/agent-templates"],
    ["GET", "/api/agents"],
    ["GET", "/api/agents/workspaces/workspace/agents"],
    ["POST", "/api/agents/workspaces/workspace/agents"],
  ];
  for (const [method, pathname] of requests) {
    const response = await fetch(`${base}${pathname}`, {
      method,
      headers: { cookie: "admin=U-admin", "content-type": "application/json" },
      ...(method === "POST" ? { body: "{}" } : {}),
    });
    assert.equal(response.status, 404, `${method} ${pathname} must not be served`);
  }
  assert.deepEqual(legacyCalls(), callsBefore);
});
