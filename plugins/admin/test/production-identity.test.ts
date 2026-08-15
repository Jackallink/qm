import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { mintPortalIdentity } from "../../chassis/src/portal-identity.ts";

const environmentKeys = [
  "NODE_ENV",
  "PORTAL_DEV_PRINCIPAL",
  "USER",
  "PORTAL_IDENTITY_SECRET",
  "CORE_API_URL",
  "CORE_SIGNING_SECRET",
] as const;
const previousEnvironment = new Map(environmentKeys.map((key) => [key, process.env[key]]));
const restoreEnvironment = () => {
  for (const key of environmentKeys) {
    const value = previousEnvironment.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
};

process.env.NODE_ENV = "production";
process.env.PORTAL_DEV_PRINCIPAL = "attacker";
process.env.USER = "attacker";
process.env.PORTAL_IDENTITY_SECRET = "production-identity-secret";

const coreCalls: string[] = [];
let actor = "";
const core = createServer((req: IncomingMessage, res) => {
  coreCalls.push(req.url ?? "");
  actor = String(req.headers["x-admin-actor"] ?? "");
  req.resume();
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ isAdmin: true }));
});
await new Promise<void>((resolve) => core.listen(0, resolve));
process.env.CORE_API_URL = `http://localhost:${(core.address() as AddressInfo).port}`;
process.env.CORE_SIGNING_SECRET = "production-identity-core-secret";

let server: (typeof import("../src/index.ts"))["server"];
try {
  ({ server } = await import("../src/index.ts"));
} finally {
  restoreEnvironment();
}
await new Promise<void>((resolve) => server.listen(0, resolve));
const base = `http://localhost:${(server.address() as AddressInfo).port}`;

test.after(async () => {
  await Promise.all(
    [server, core]
      .filter((target) => target.listening)
      .map(
        (target) =>
          new Promise<void>((resolve, reject) => {
            target.close((error) => (error ? reject(error) : resolve()));
          }),
      ),
  );
});

test("production requests require a verified portal identity and never fall back to environment or cookies", async () => {
  assert.equal((await fetch(`${base}/`)).status, 401);
  assert.equal(coreCalls.length, 0, "an unsigned shell request must not contact core");
  const whoamiCalls = () => coreCalls.filter((path) => path.startsWith("/v1/admin/whoami"));
  const callsBefore = whoamiCalls();
  for (const headers of [
    { cookie: "admin=U-admin" },
    { "x-portal-identity": mintPortalIdentity({ p: "U-admin", exp: Date.now() + 60_000 }, "wrong-secret") },
    { "x-portal-identity": mintPortalIdentity({ p: "U-admin", exp: Date.now() - 1_000 }, "production-identity-secret") },
  ]) {
    const response = await fetch(`${base}/api/whoami`, { headers });
    assert.equal(response.status, 401);
  }
  assert.deepEqual(whoamiCalls(), callsBefore);

  const token = mintPortalIdentity({ p: "U-admin", exp: Date.now() + 60_000 }, "production-identity-secret");
  const response = await fetch(`${base}/api/whoami`, { headers: { "x-portal-identity": token } });
  assert.equal(response.status, 200);
  assert.equal(whoamiCalls().length, callsBefore.length + 1);
  assert.equal(actor, "U-admin@acme");
});
