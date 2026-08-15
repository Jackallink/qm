import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  runCli,
  tmp,
  rmDir,
  writeConfig,
  standInCheckout,
  standInPlugin,
  dockerAvailable,
  deploymentContainers,
  deploymentVolumes,
  deploymentNetworks,
  dockerCleanup,
  removeStandInImages,
  preexistingServiceImages,
} from "./harness.ts";

const SERVICES = ["core", "web-ui", "admin", "portal"] as const;
const suffix = (names: string[], end: string): string | undefined => names.find((n) => n.endsWith(`-${end}`));

function lifecycleSkip(): string | false {
  if (!dockerAvailable()) return "no Docker daemon reachable";
  const pre = preexistingServiceImages(SERVICES);
  if (pre.length) return `refusing to clobber your local images: ${pre.join(", ")} (docker rmi them to run this test)`;
  return false;
}

test(
  "docker lifecycle: up → status → logs → re-up → down → up → down --purge",
  { skip: lifecycleSkip() },
  async (t) => {
    const org = `qm-e2e-dl-${process.pid}`;
    const basePort = 20000 + (process.pid % 5000);
    const dep = tmp("dl-dep");
    const checkout = standInCheckout(SERVICES);
    const sentinel = `e2e-${process.pid}-sentinel-${"x".repeat(32)}`;

    writeFileSync(
      join(dep, ".env"),
      [
        `CORE_SIGNING_SECRET=${sentinel}`,
        `CAPABILITY_SECRET=${sentinel}-capability`,
        `CONNECTOR_SECRET_KEY=${sentinel}-connector`,
        `PORTAL_IDENTITY_SECRET=${sentinel}-identity`,
        `SKILL_SIGNING_SECRET=${sentinel}-skill`,
        "OIDC_CLIENT_ID=fixture-client",
        `OIDC_CLIENT_SECRET=${sentinel}`,
        "PORTAL_EXPECTED_TEAM_ID=T123",
        `PORTAL_SESSION_SECRET=${sentinel}`,
        "",
      ].join("\n"),
    );
    writeConfig(dep, {
      orgId: org,
      target: "docker",
      basePort,
      services: [...SERVICES],
      env: { core: { HARNESS: "mock" } },
    });
    standInPlugin(dep, "widget");

    const up = (): ReturnType<typeof runCli> =>
      runCli(["up", "--build-from", checkout], { cwd: dep, env: { CORE_SIGNING_SECRET: undefined } });

    try {
      await t.test("up builds + starts every service, the source plugin, and Postgres", () => {
        const r = up();
        assert.equal(r.code, 0, r.out);
        assert.match(r.out, /stack up/);
        assert.match(r.out, new RegExp(`core   : http://127\\.0\\.0\\.1:${basePort}\\b`));
        assert.match(r.out, /plugin widget running/);

        const names = deploymentContainers(org);
        for (const svc of [...SERVICES, "widget", "pg"]) {
          assert.ok(suffix(names, svc), `expected a running container for ${svc}; got ${names.join(", ")}`);
        }
      });

      await t.test("computed secrets from the deployment ./.env reach the core container", () => {
        const core = suffix(deploymentContainers(org), "core")!;
        const got = execFileSync("docker", ["exec", core, "printenv", "CORE_SIGNING_SECRET"], {
          encoding: "utf8",
        }).trim();
        assert.equal(got, sentinel);
      });

      await t.test("status enumerates exactly this deployment's containers with ports", () => {
        const r = runCli(["status"], { cwd: dep });
        assert.equal(r.code, 0, r.out);
        assert.match(r.out, /qm status/);
        assert.match(r.out, new RegExp(`qm-${org}-core\\b`));
        assert.match(r.out, /Up\b/);
        assert.match(r.out, new RegExp(`127\\.0\\.0\\.1:${basePort}->8080`));
        assert.match(r.out, /image content IDs:/);
        assert.match(r.out, new RegExp(`qm-${org}-core: sha256:[a-f0-9]{64}`));
        assert.match(r.out, new RegExp(`qm-${org}-pgdata: present`));
        assert.match(r.out, new RegExp(`qm-${org}-coredata: present`));
        assert.match(r.out, /recorded image evidence:/);
        assert.match(r.out, /pg: release sha256:[a-f0-9]{64}; content sha256:[a-f0-9]{64}/);
      });

      await t.test("logs <service> tails one container; logs (all) interleaves with prefixes", () => {
        const one = runCli(["logs", "core", "--tail", "20"], { cwd: dep });
        assert.equal(one.code, 0, one.out);
        assert.match(one.out, /listening on :8080/);
        const tail1 = runCli(["logs", "core", "--tail", "1"], { cwd: dep });
        assert.equal(tail1.code, 0, tail1.out);
        assert.match(tail1.out, /tail sentinel/);
        assert.doesNotMatch(tail1.out, /listening on :8080/);

        const all = runCli(["logs", "--tail", "3"], { cwd: dep });
        assert.equal(all.code, 0, all.out);
        for (const label of [...SERVICES, "widget", "pg"]) {
          assert.match(all.out, new RegExp(`${label}\\s+\\|`), `interleaved logs missing ${label}`);
        }
      });

      await t.test("logs for a non-existent service is a clear error", () => {
        const r = runCli(["logs", "doesnotexist"], { cwd: dep });
        assert.equal(r.code, 1);
        assert.match(r.out, /no container/);
      });

      await t.test("up is idempotent — re-running keeps the stack up", () => {
        const r = up();
        assert.equal(r.code, 0, r.out);
        assert.ok(suffix(deploymentContainers(org), "core"), "core still up after re-up");
      });

      await t.test("down (no purge) removes containers but keeps the network + volumes", () => {
        const r = runCli(["down"], { cwd: dep });
        assert.equal(r.code, 0, r.out);
        assert.match(r.out, /down\./);
        assert.deepEqual(deploymentContainers(org), []);
        assert.ok(deploymentVolumes(org).length > 0, "volumes preserved without --purge");
        assert.ok(deploymentNetworks(org).length > 0, "network preserved without --purge");
      });

      await t.test("up after down reuses the preserved Postgres volume + recorded password", () => {
        const r = up();
        assert.equal(r.code, 0, r.out);
        assert.ok(suffix(deploymentContainers(org), "core"), "stack back up");
      });

      await t.test("down --purge removes containers, the network, and the volumes", () => {
        const r = runCli(["down", "--purge"], { cwd: dep });
        assert.equal(r.code, 0, r.out);
        assert.match(r.out, /purging/);
        assert.deepEqual(deploymentContainers(org), []);
        assert.deepEqual(deploymentVolumes(org), []);
        assert.deepEqual(deploymentNetworks(org), []);
      });
    } finally {
      dockerCleanup(org);
      removeStandInImages(SERVICES, org);
      rmDir(dep);
      rmDir(checkout);
    }
  },
);

test(
  "D0-L source build records container image evidence and proves loopback-only published ports",
  { skip: lifecycleSkip() },
  async () => {
    const org = `qm-e2e-d0l-${process.pid}`;
    const basePort = 30000 + (process.pid % 5000);
    const dep = tmp("d0l-dep");
    const checkout = standInCheckout(SERVICES);
    const secret = `d0l-${process.pid}-${"x".repeat(32)}`;
    try {
      execFileSync("git", ["init", "-q"], { cwd: checkout });
      execFileSync("git", ["config", "user.email", "d0l@example.test"], { cwd: checkout });
      execFileSync("git", ["config", "user.name", "D0L fixture"], { cwd: checkout });
      execFileSync("git", ["add", "deploy"], { cwd: checkout });
      execFileSync("git", ["commit", "-qm", "D0L fixture"], { cwd: checkout });
      const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: checkout, encoding: "utf8" }).trim();

      writeFileSync(
        join(dep, ".env"),
        [
          `CAPABILITY_SECRET=${secret}-capability`,
          `CONNECTOR_SECRET_KEY=${secret}-connector`,
          `CORE_SIGNING_SECRET=${secret}-core`,
          `PORTAL_IDENTITY_SECRET=${secret}-identity`,
          `SKILL_SIGNING_SECRET=${secret}-skill`,
          `PORTAL_SESSION_SECRET=${secret}-session`,
          "ADMIN_GRANTS=d0l-admin:org_admin",
          "",
        ].join("\n"),
      );
      writeConfig(dep, {
        orgId: org,
        target: "docker",
        basePort,
        publicUrl: `http://127.0.0.1:${basePort + 1}`,
        services: [...SERVICES],
        sandbox: { backend: "disabled" },
        env: {
          core: {
            HARNESS: "pi",
            NODE_ENV: "production",
            TEXT_ONLY_MODE: "true",
            MEMORY_RECALL: "off",
            MEMORY_CAPTURE: "off",
          },
          portal: { NODE_ENV: "development" },
        },
        secretEnv: { core: { ADMIN_GRANTS: "ADMIN_GRANTS" } },
      });

      const up = runCli(["up", "--build-from", checkout], {
        cwd: dep,
        withRepoEnv: false,
        env: { NODE_USE_ENV_PROXY: "1", HTTP_PROXY: "http://127.0.0.1:1" },
      });
      assert.equal(up.code, 0, up.out);
      for (const [service, port] of [
        ["core", basePort],
        ["portal", basePort + 1],
        ["web-ui", basePort + 2],
        ["admin", basePort + 3],
      ] as const) {
        const name = suffix(deploymentContainers(org), service);
        assert.ok(name, `expected ${service} container`);
        const ports = JSON.parse(
          execFileSync("docker", ["inspect", "--format", "{{json .NetworkSettings.Ports}}", name], {
            encoding: "utf8",
          }),
        ) as Record<string, Array<{ HostIp: string; HostPort: string }>>;
        assert.deepEqual(ports["8080/tcp"], [{ HostIp: "127.0.0.1", HostPort: String(port) }]);
        const health = await fetch(`http://127.0.0.1:${port}/healthz`);
        assert.equal(health.status, 200);
      }
      const status = runCli(["status"], { cwd: dep, withRepoEnv: false });
      assert.equal(status.code, 0, status.out);
      assert.match(status.out, /recorded image evidence:/);
      assert.match(status.out, new RegExp(`build ${commit}; content sha256:[a-f0-9]{64}`));
      assert.match(status.out, /pg: release sha256:[a-f0-9]{64}; content sha256:[a-f0-9]{64}/);
      assert.match(status.out, new RegExp(`qm-${org}-pgdata: present`));
      assert.match(status.out, new RegExp(`qm-${org}-coredata: present`));
      assert.doesNotMatch(status.out, /D0L_PROVIDER_API_KEY|CORE_SIGNING_SECRET|PORTAL_IDENTITY_SECRET/);
    } finally {
      dockerCleanup(org);
      removeStandInImages(SERVICES, org);
      rmDir(dep);
      rmDir(checkout);
    }
  },
);

test(
  "status on a deployment that was never brought up reports nothing running",
  { skip: dockerAvailable() ? false : "no Docker daemon reachable" },
  () => {
    const org = `qm-e2e-dl-empty-${process.pid}`;
    const dep = tmp("dl-empty");
    try {
      writeConfig(dep, { orgId: org, target: "docker", services: ["core"] });
      const r = runCli(["status"], { cwd: dep });
      assert.equal(r.code, 0, r.out);
      assert.match(r.out, /qm status/);
      assert.deepEqual(deploymentContainers(org), []);
    } finally {
      dockerCleanup(org);
      rmDir(dep);
    }
  },
);

test(
  "down on a deployment that was never brought up is a clean no-op",
  { skip: dockerAvailable() ? false : "no Docker daemon reachable" },
  () => {
    const org = `qm-e2e-dl-noop-${process.pid}`;
    const dep = tmp("dl-noop");
    try {
      writeConfig(dep, { orgId: org, target: "docker", services: ["core"] });
      const r = runCli(["down"], { cwd: dep });
      assert.equal(r.code, 0, r.out);
      assert.match(r.out, /down\./);
    } finally {
      dockerCleanup(org);
      rmDir(dep);
    }
  },
);
