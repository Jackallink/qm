import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createPostgresRunStore } from "../src/runs/postgres-run-store.ts";
import type { OrchestratorInput } from "../src/core/orchestrator.ts";
import type { Principal } from "../src/types.ts";

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "set DATABASE_URL (a Postgres) to run the Postgres run-store tests";

before(async () => {
  if (!URL) return;
  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: URL });
  await p.query("DROP TABLE IF EXISTS runs, tool_calls CASCADE");
  await p.end();
});

const actor: Principal = { id: "internal:U1", type: "internal" };
const turn = (text: string): OrchestratorInput => ({
  actor,
  conversation: { kind: "dm", threadRef: "t", audience: [actor] },
  origin: { kind: "direct" },
  text,
});

async function insertRemoteOnce(
  pgUrl: string,
  id: string,
  sessionId: string,
  status: "pending" | "running",
  leaseExpiresAt: number | null,
  startedAt: number | null,
): Promise<void> {
  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: pgUrl });
  await p.query(
    `INSERT INTO runs(id, session_id, status, request, delivery_mode, lease_token, lease_expires_at, started_at, created_at)
     VALUES ($1,$2,$3,$4,'remote_once',$5,$6,$7,$8)`,
    [id, sessionId, status, JSON.stringify(turn("remote")), leaseExpiresAt === null ? null : "lease", leaseExpiresAt, startedAt, 1000],
  );
  await p.end();
}

async function insertLocal(
  pgUrl: string,
  id: string,
  sessionId: string,
  status: "pending" | "running",
  leaseExpiresAt: number | null,
  startedAt: number | null,
): Promise<void> {
  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: pgUrl });
  await p.query(
    `INSERT INTO runs(id, session_id, status, request, delivery_mode, lease_token, lease_expires_at, started_at, created_at)
     VALUES ($1,$2,$3,$4,'local',$5,$6,$7,$8)`,
    [id, sessionId, status, JSON.stringify(turn("local")), leaseExpiresAt === null ? null : "lease", leaseExpiresAt, startedAt, 1000],
  );
  await p.end();
}

async function cleanRuns(): Promise<void> {
  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: URL! });
  await p.query("DELETE FROM runs");
  await p.end();
}

test("remote_once runs are never requeued or parked by reapExpired", { skip }, async () => {
  const { runs } = createPostgresRunStore(URL!);
  await runs.get("warmup");
  await cleanRuns();
  await insertRemoteOnce(URL!, "remote-expired", "s-remote-1", "running", Date.now() - 1000, Date.now() - 5000);
  await insertRemoteOnce(URL!, "remote-too-old", "s-remote-old-1", "running", Date.now() - 1000, Date.now() - 100_000);
  await insertLocal(URL!, "local-expired", "s-local-1", "running", Date.now() - 1000, Date.now() - 5000);
  const result = await runs.reapExpired(() => Promise.resolve(), { maxAgeMs: 60_000 });
  assert.equal(result.requeued, 1, "only the local run requeues");
  assert.equal(result.parked, 0);
  const remoteExpired = await runs.get("remote-expired");
  assert.equal(remoteExpired?.status, "running", "expired remote_once run stays running");
  assert.equal(remoteExpired?.leaseToken, "lease", "expired remote_once run keeps its lease");
  const remoteTooOld = await runs.get("remote-too-old");
  assert.equal(remoteTooOld?.status, "running", "too-old remote_once run stays running (not parked)");
  const local = await runs.get("local-expired");
  assert.equal(local?.status, "pending", "expired local run requeues to pending");
  await runs.close?.();
});

test("claim and claimById never return a remote_once run", { skip }, async () => {
  const { runs } = createPostgresRunStore(URL!);
  await runs.get("warmup");
  await cleanRuns();
  await insertRemoteOnce(URL!, "remote-pending", "s-rc-2", "pending", null, null);
  await insertLocal(URL!, "local-pending", "s-lc-2", "pending", null, null);
  const claimed = await runs.claim("w1", 10_000);
  assert.ok(claimed, "a local run is claimable");
  assert.equal(claimed!.id, "local-pending");
  const byId = await runs.claimById("remote-pending", "w1", 10_000);
  assert.equal(byId, null, "claimById refuses a remote_once run");
  const remote = await runs.get("remote-pending");
  assert.equal(remote?.status, "pending", "remote_once run stays pending after claim attempts");
  await runs.close?.();
});

test("a second local pending row in a remote-active session is never claimed", { skip }, async () => {
  const { runs } = createPostgresRunStore(URL!);
  await runs.get("warmup");
  await cleanRuns();
  await insertRemoteOnce(URL!, "remote-active", "s-shared-3", "running", Date.now() + 60_000, Date.now());
  await insertLocal(URL!, "second-local", "s-shared-3", "pending", null, null);
  const claimed = await runs.claim("w1", 10_000);
  assert.equal(claimed, null, "session guard keeps blocking on the running remote_once row");
  const second = await runs.get("second-local");
  assert.equal(second?.status, "pending", "second local input stays pending and unclaimed");
  await runs.close?.();
});

test("remote_once runs are not requeued through fail or releaseLease", { skip }, async () => {
  const { runs } = createPostgresRunStore(URL!);
  await runs.get("warmup");
  await cleanRuns();
  await insertRemoteOnce(URL!, "remote-running", "s-rl-4", "running", Date.now() + 60_000, Date.now());
  const released = await runs.releaseLease("remote-running", "lease");
  assert.equal(released, false, "releaseLease is a no-op for remote_once runs");
  const after = await runs.get("remote-running");
  assert.equal(after?.status, "running", "remote_once run stays running after releaseLease");
  await runs.close?.();
});

test("forceReleaseLease skips remote_turn holders and deleteSession rejects them", { skip }, async () => {
  const { createPostgresSessionStore } = await import("../src/sessions/postgres-session-store.ts");
  const sessions = createPostgresSessionStore(URL!);
  const thread = `remote-holder-${Date.now()}`;
  const session = await sessions.getOrCreateByThread(thread, "dm", "personal:U1");
  const acquired = await sessions.acquireLease(session.id, "remote_turn:turn-1");
  assert.ok(acquired.lease, "remote_turn lease acquired");
  await sessions.forceReleaseLease(session.id);
  const stillHeld = await sessions.acquireLease(session.id, "turn");
  assert.equal(stillHeld.lease, null, "remote_turn holder survives forceReleaseLease");
  await assert.rejects(() => sessions.deleteSession(session.id), /remote_refused: remote_turn_active/);
  const blocked = await sessions.acquireLease(session.id, "turn");
  assert.equal(blocked.lease, null, "remote_turn holder still blocks other holders");
  await sessions.releaseLease(acquired.lease!);
  const recovered = await sessions.acquireLease(session.id, "turn");
  assert.ok(recovered.lease, "lease recoverable via releaseLease once remote_turn holder is released");
  await sessions.deleteSession(session.id);
});
