import { test, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "../src/persistence/pg-pool.ts";
import { withPgTransaction } from "../src/persistence/pg-pool.ts";
import {
  createRemoteBudgetLedger,
  deriveWindowAnchorMs,
  type RemoteBudgetLedger,
} from "../src/remote-turn/budget-ledger.ts";

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "set DATABASE_URL (a Postgres) to run the Postgres budget ledger tests";

const WINDOW = 86_400_000;
const NOW = 1_700_000_000_000;
const ANCHOR = deriveWindowAnchorMs(NOW, WINDOW);

let ledger: RemoteBudgetLedger;

before(async () => {
  if (!URL) return;
  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: URL });
  await p.query("DROP TABLE IF EXISTS budget_reservations, budget_balances CASCADE");
  await p.end();
  ledger = createRemoteBudgetLedger(URL);
  await ledger.touch();
});

async function seedBalance(scopeId: string, availableUsd: number): Promise<void> {
  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: URL });
  await withPgTransaction(p, async (tx) => {
    await tx.query(
      "INSERT INTO budget_balances(scope_id, window_anchor_ms, available_usd) VALUES($1, $2, $3)",
      [scopeId, ANCHOR, availableUsd],
    );
  });
  await p.end();
}

async function balanceFor(scopeId: string): Promise<number> {
  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: URL });
  const { rows } = await p.query(
    "SELECT available_usd FROM budget_balances WHERE scope_id=$1 AND window_anchor_ms=$2",
    [scopeId, ANCHOR],
  );
  await p.end();
  return rows[0] === undefined ? -1 : Number(rows[0].available_usd);
}

async function reservationStatus(remoteTurnId: string): Promise<string | null> {
  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: URL });
  const { rows } = await p.query(
    "SELECT status FROM budget_reservations WHERE remote_turn_id=$1",
    [remoteTurnId],
  );
  await p.end();
  return rows[0] === undefined ? null : String(rows[0].status);
}

async function reserve(scopeId: string, ceilingUsd: number): Promise<{ status: string; reservedUsd?: number }> {
  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: URL });
  const result = await withPgTransaction(p, (tx) =>
    ledger.reserveBudget(tx, {
      scopeId,
      bindingId: "binding-1",
      remoteTurnId: randomUUID(),
      ceilingUsd,
      windowAnchorMs: ANCHOR,
    }),
  );
  await p.end();
  return result;
}

test("first-use seeding creates the balance row and reserves the ceiling", { skip }, async () => {
  const scopeId = `seed-${randomUUID()}`;
  assert.equal(await balanceFor(scopeId), -1, "balance row absent before first use");
  const result = await reserve(scopeId, 100);
  assert.equal(result.status, "reserved");
  assert.equal(result.reservedUsd, 100);
  assert.equal(await balanceFor(scopeId), 0, "full ceiling deducted");
});

test("insufficient balance refuses admission without inserting a reservation", { skip }, async () => {
  const scopeId = `insufficient-${randomUUID()}`;
  await seedBalance(scopeId, 5);
  const result = await reserve(scopeId, 10);
  assert.equal(result.status, "insufficient");
});

test("concurrent reservations both pass the single guarded update", { skip }, async () => {
  const scopeId = `concurrent-${randomUUID()}`;
  await seedBalance(scopeId, 200);
  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: URL });
  const results = await Promise.all(
    [100, 100].map((ceiling) =>
      withPgTransaction(p, (tx: PoolClient) =>
        ledger.reserveBudget(tx, {
          scopeId,
          bindingId: "binding-1",
          remoteTurnId: randomUUID(),
          ceilingUsd: ceiling,
          windowAnchorMs: ANCHOR,
        }),
      ),
    ),
  );
  await p.end();
  assert.deepEqual(results.map((r) => r.status), ["reserved", "reserved"]);
  assert.equal(await balanceFor(scopeId), 0, "exactly ceiling×2 deducted");
});

test("settlement releases unused reservation back to the balance on trusted usage", { skip }, async () => {
  const scopeId = `release-${randomUUID()}`;
  const remoteTurnId = randomUUID();
  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: URL });
  await withPgTransaction(p, async (tx) => {
    await ledger.reserveBudget(tx, {
      scopeId,
      bindingId: "binding-1",
      remoteTurnId,
      ceilingUsd: 100,
      windowAnchorMs: ANCHOR,
    });
    const outcome = await ledger.settleReservation(tx, {
      reservationId: remoteTurnId,
      trustedUsageUsd: 30,
      invalidMetering: false,
    });
    assert.equal(outcome, "released");
  });
  await p.end();
  assert.equal(await reservationStatus(remoteTurnId), "released");
  assert.equal(await balanceFor(scopeId), 70, "ceiling minus trusted usage returned");
});

test("missing trusted usage charges the full reservation", { skip }, async () => {
  const scopeId = `charge-${randomUUID()}`;
  const remoteTurnId = randomUUID();
  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: URL });
  await withPgTransaction(p, async (tx) => {
    await ledger.reserveBudget(tx, {
      scopeId,
      bindingId: "binding-1",
      remoteTurnId,
      ceilingUsd: 100,
      windowAnchorMs: ANCHOR,
    });
    const outcome = await ledger.settleReservation(tx, {
      reservationId: remoteTurnId,
      trustedUsageUsd: null,
      invalidMetering: false,
    });
    assert.equal(outcome, "charged");
  });
  await p.end();
  assert.equal(await reservationStatus(remoteTurnId), "charged");
  assert.equal(await balanceFor(scopeId), 0, "no top-up for charged reservation");
});

test("invalid metering parks: reservation stays reserved and balance stays deducted", { skip }, async () => {
  const scopeId = `park-${randomUUID()}`;
  const remoteTurnId = randomUUID();
  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: URL });
  await withPgTransaction(p, async (tx) => {
    await ledger.reserveBudget(tx, {
      scopeId,
      bindingId: "binding-1",
      remoteTurnId,
      ceilingUsd: 100,
      windowAnchorMs: ANCHOR,
    });
    const outcome = await ledger.settleReservation(tx, {
      reservationId: remoteTurnId,
      trustedUsageUsd: 30,
      invalidMetering: true,
    });
    assert.equal(outcome, "parked");
  });
  await p.end();
  assert.equal(await reservationStatus(remoteTurnId), "reserved");
  assert.equal(await balanceFor(scopeId), 0);
});

test("retried settlement does not double-release the balance", { skip }, async () => {
  const scopeId = `retry-${randomUUID()}`;
  const remoteTurnId = randomUUID();
  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: URL });
  await withPgTransaction(p, async (tx) => {
    await ledger.reserveBudget(tx, {
      scopeId,
      bindingId: "binding-1",
      remoteTurnId,
      ceilingUsd: 100,
      windowAnchorMs: ANCHOR,
    });
    const first = await ledger.settleReservation(tx, {
      reservationId: remoteTurnId,
      trustedUsageUsd: 30,
      invalidMetering: false,
    });
    assert.equal(first, "released");
  });
  await withPgTransaction(p, async (tx) => {
    const retried = await ledger.settleReservation(tx, {
      reservationId: remoteTurnId,
      trustedUsageUsd: 30,
      invalidMetering: false,
    });
    assert.equal(retried, "released");
  });
  await p.end();
  assert.equal(await balanceFor(scopeId), 70, "second settlement must not top up again");
});
