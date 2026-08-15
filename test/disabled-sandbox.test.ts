import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createInsecureTestServer } from "../src/api/server.ts";
import { CAPABILITY_HEADER } from "../src/api/contract.ts";
import { mintCapabilityToken } from "../src/auth/capability-token.ts";
import { loadConfig } from "../src/config.ts";
import { createDisabledSandbox } from "../src/sandbox/disabled-sandbox.ts";
import { CapabilityUnsupportedError, type SandboxHandle } from "../src/sandbox/sandbox.ts";
import { scopeId, type TurnRequest } from "../src/types.ts";
import { buildApp } from "../src/wiring.ts";
import type { App } from "../src/api/app-types.ts";
import { TEST_CAPABILITY_SECRET, testConfig } from "./support/test-config.ts";

const handle: SandboxHandle = { id: "disabled", rootDir: "" };

function assertUnsupported(err: unknown): boolean {
  assert.ok(err instanceof CapabilityUnsupportedError);
  assert.equal(err.backend, "disabled");
  assert.equal(err.capability, "sandbox execution");
  assert.equal(err.retryable, false);
  return true;
}

test("disabled is valid only as the primary sandbox backend", () => {
  assert.equal(loadConfig({ SANDBOX_BACKEND: "disabled" }).sandboxBackend, "disabled");
  assert.throws(
    () => loadConfig({ SANDBOX_BACKEND: "disabled", SANDBOX_SECONDARY_BACKEND: "local" }),
    /SANDBOX_SECONDARY_BACKEND cannot be set when SANDBOX_BACKEND=disabled/,
  );
  assert.throws(
    () => loadConfig({ SANDBOX_BACKEND: "local", SANDBOX_SECONDARY_BACKEND: "disabled" }),
    /SANDBOX_SECONDARY_BACKEND cannot be disabled/,
  );
});

test("disabled sandbox exposes no substrate capabilities and rejects every required operation", async () => {
  const sandbox = createDisabledSandbox();
  const scope = scopeId("personal", "U1");
  const operations: Array<() => Promise<unknown>> = [
    () => sandbox.provision([{ scopeId: scope, mountPath: "", mode: "rw" }]),
    () => sandbox.run(handle, "echo unavailable"),
    () => sandbox.readFile(handle, "out.txt"),
    () => sandbox.writeFile(handle, "out.txt", "unavailable"),
    () => sandbox.writeFileBytes(handle, "out.bin", new Uint8Array([1])),
    () => sandbox.readFileBytes(handle, "out.bin"),
    () => sandbox.listDir(handle, "."),
    () => sandbox.removeDir(handle, "out"),
    () => sandbox.teardown(handle),
  ];

  assert.deepEqual(sandbox.profile, {
    backend: "disabled",
    writablePersistence: "none",
    processSessions: false,
    egressEnforcement: "none",
  });
  assert.equal(sandbox.profileFor, undefined);
  assert.equal(sandbox.startProcess, undefined);
  assert.equal(sandbox.backupComputer, undefined);
  assert.equal(sandbox.stageIn, undefined);
  assert.equal(sandbox.reapDeepIdle, undefined);

  for (const operation of operations) await assert.rejects(operation, assertUnsupported);
});

test("disabled wiring has no routing migration and parks mock execute on its first claim", async () => {
  const built = buildApp(testConfig({ sandboxBackend: "disabled", maxAttempts: 3 }));
  try {
    assert.equal(built.sandbox.profile.backend, "disabled");
    assert.equal(built.sandboxMigration, undefined);
    const request: TurnRequest = {
      surface: "test",
      actor: { externalId: "U1" },
      conversation: { kind: "dm", threadRef: "dm:U1:disabled-sandbox" },
      text: "!run echo unavailable",
    };

    await assert.rejects(() => built.app.turn(request), assertUnsupported);

    const [run] = await built.runs.list({ limit: 1 });
    assert.equal(run?.status, "failed");
    assert.equal(run?.attempts, 1);
    assert.equal(run?.result?.status, "failed");
    assert.equal(run?.result?.reason, "this computer's substrate (disabled) does not support sandbox execution");
  } finally {
    await built.runtime.stop();
  }
});

test("disabled sandbox errors map to HTTP 501 and omit sandbox routing administration", async () => {
  const built = buildApp(testConfig({ sandboxBackend: "disabled" }));
  const app: App = {
    ...built.app,
    async resolveReachTarget() {
      return { ok: true } as Awaited<ReturnType<App["resolveReachTarget"]>>;
    },
  };
  const server = createInsecureTestServer(app, {
    capabilitySecret: TEST_CAPABILITY_SECRET,
    sandbox: built.sandbox,
    blobTransfer: built.blobTransfer,
    environments: built.environments,
    files: built.files,
    admin: built.admin,
    auditLog: built.auditLog,
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  try {
    const token = await mintCapabilityToken(
      {
        actorId: "U1",
        scopeId: scopeId("personal", "U1"),
        exp: Date.now() + 60_000,
      },
      TEST_CAPABILITY_SECRET,
    );
    const unsupported = await fetch(`${base}/v1/reach`, {
      method: "POST",
      headers: { [CAPABILITY_HEADER]: token, "content-type": "application/json" },
      body: JSON.stringify({ recipient: "recipient", text: "hello", files: ["out.txt"] }),
    });
    assert.equal(unsupported.status, 501);
    assert.deepEqual(await unsupported.json(), {
      error: "capability_unsupported",
      backend: "disabled",
      capability: "sandbox execution",
    });

    const routes = await fetch(`${base}/v1/admin/sandbox-routes`, {
      headers: { "x-admin-actor": "admin-alice@default-org" },
    });
    assert.equal(routes.status, 404);
    assert.deepEqual(await routes.json(), {
      error: "not_supported",
      message: "sandbox routing is not wired on this deployment",
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await built.runtime.stop();
  }
});
