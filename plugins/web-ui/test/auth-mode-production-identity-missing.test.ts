import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../../chassis/src/portal-identity.ts";

const environmentKeys = [
  "NODE_ENV",
  "PORTAL_IDENTITY_SECRET",
  "CORE_API_URL",
  "CORE_SIGNING_SECRET",
  "WEB_UI_PRINCIPALS",
  "ALLOW_UNSIGNED_TEST_IDENTITY",
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
delete process.env.PORTAL_IDENTITY_SECRET;
process.env.WEB_UI_PRINCIPALS = "alice";
process.env.ALLOW_UNSIGNED_TEST_IDENTITY = "0";

let memoryCalls = 0;
const core = createServer((req: IncomingMessage, res) => {
  if ((req.url ?? "").startsWith("/v1/memory")) memoryCalls++;
  req.resume();
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ content: "" }));
});
await new Promise<void>((resolve) => core.listen(0, resolve));
process.env.CORE_API_URL = `http://localhost:${(core.address() as AddressInfo).port}`;
process.env.CORE_SIGNING_SECRET = "production-identity-core-secret";

let handler: (typeof import("../server/index.ts"))["handler"];
try {
  ({ handler } = await import("../server/index.ts"));
} finally {
  restoreEnvironment();
}
const surface = createServer((req, res) => void handler(req, res));
await new Promise<void>((resolve) => surface.listen(0, resolve));
const base = `http://localhost:${(surface.address() as AddressInfo).port}`;

test.after(async () => {
  await Promise.all(
    [surface, core]
      .filter((target) => target.listening)
      .map(
        (target) =>
          new Promise<void>((resolve, reject) => {
            target.close((error) => (error ? reject(error) : resolve()));
          }),
      ),
  );
});

test("production refuses source-auth-signed identities when its explicit portal identity secret is absent", async () => {
  const callsBefore = memoryCalls;
  const token = mintPortalIdentity({ p: "alice", exp: Date.now() + 60_000 }, "production-identity-core-secret");
  const response = await fetch(`${base}/api/memory`, { headers: { [PORTAL_IDENTITY_HEADER]: token } });
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "sign in", mode: "portal", reason: "unauthenticated" });
  assert.equal(memoryCalls, callsBefore);
});
