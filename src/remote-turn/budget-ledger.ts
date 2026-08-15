import { randomUUID } from "node:crypto";
import type { PoolClient, Rows } from "../persistence/pg-pool.ts";
import { sharedPgPool, type PgPool } from "../persistence/pg-pool.ts";

export const REMOTE_BUDGET_RESERVATIONS_DDL = `CREATE TABLE IF NOT EXISTS budget_reservations(
  id TEXT PRIMARY KEY,
  remote_turn_id TEXT NOT NULL UNIQUE,
  scope_id TEXT NOT NULL,
  binding_id TEXT NOT NULL,
  usd NUMERIC NOT NULL,
  window_anchor_ms BIGINT NOT NULL,
  status TEXT NOT NULL,
  created_at BIGINT NOT NULL
)`;

export const REMOTE_BUDGET_BALANCES_DDL = `CREATE TABLE IF NOT EXISTS budget_balances(
  scope_id TEXT NOT NULL,
  window_anchor_ms BIGINT NOT NULL,
  available_usd NUMERIC NOT NULL,
  PRIMARY KEY(scope_id, window_anchor_ms)
)`;

export const REMOTE_BUDGET_DDL = [REMOTE_BUDGET_RESERVATIONS_DDL, REMOTE_BUDGET_BALANCES_DDL] as const;

export function deriveWindowAnchorMs(nowMs: number, budgetWindowMs: number): number {
  return Math.floor(nowMs / budgetWindowMs) * budgetWindowMs;
}

export interface ReserveBudgetInput {
  scopeId: string;
  bindingId: string;
  remoteTurnId: string;
  ceilingUsd: number;
  windowAnchorMs: number;
}

export interface BudgetReserved {
  status: "reserved";
  reservationId: string;
  reservedUsd: number;
}

export interface BudgetInsufficient {
  status: "insufficient";
}

export type ReserveBudgetResult = BudgetReserved | BudgetInsufficient;

export interface SettleReservationInput {
  reservationId: string;
  trustedUsageUsd: number | null;
  invalidMetering: boolean;
}

export type SettleReservationResult = "released" | "charged" | "parked";

export interface RemoteBudgetLedger {
  reserveBudget(tx: PoolClient, input: ReserveBudgetInput): Promise<ReserveBudgetResult>;
  settleReservation(tx: PoolClient, input: SettleReservationInput): Promise<SettleReservationResult>;
  touch(): Promise<void>;
}

export function createRemoteBudgetLedger(connectionString: string): RemoteBudgetLedger {
  const pool: PgPool = sharedPgPool(connectionString, [...REMOTE_BUDGET_DDL]);
  return {
    async touch(): Promise<void> {
      await pool.pool();
    },
    async reserveBudget(tx, input): Promise<ReserveBudgetResult> {
      const reservationId = randomUUID();
      const now = Date.now();
      await tx.query(
        "INSERT INTO budget_balances(scope_id, window_anchor_ms, available_usd) VALUES($1, $2, $3) ON CONFLICT (scope_id, window_anchor_ms) DO NOTHING",
        [input.scopeId, input.windowAnchorMs, input.ceilingUsd],
      );
      const { rowCount } = await tx.query(
        "UPDATE budget_balances SET available_usd = available_usd - $1 WHERE scope_id=$2 AND window_anchor_ms=$3 AND available_usd >= $1",
        [input.ceilingUsd, input.scopeId, input.windowAnchorMs],
      );
      if (rowCount !== 1) return { status: "insufficient" };
      await tx.query(
        "INSERT INTO budget_reservations(id, remote_turn_id, scope_id, binding_id, usd, window_anchor_ms, status, created_at) VALUES($1, $2, $3, $4, $5, $6, 'reserved', $7)",
        [reservationId, input.remoteTurnId, input.scopeId, input.bindingId, input.ceilingUsd, input.windowAnchorMs, now],
      );
      return { status: "reserved", reservationId, reservedUsd: input.ceilingUsd };
    },
    async settleReservation(tx, input): Promise<SettleReservationResult> {
      if (input.invalidMetering) return "parked";
      if (input.trustedUsageUsd === null) {
        await tx.query(
          "UPDATE budget_reservations SET status='charged' WHERE remote_turn_id=$1 AND status='reserved'",
          [input.reservationId],
        );
        return "charged";
      }
      const { rows, rowCount } = await tx.query(
        "UPDATE budget_reservations SET status='released' WHERE remote_turn_id=$1 AND status='reserved' RETURNING usd, scope_id, window_anchor_ms",
        [input.reservationId],
      );
      if (rowCount !== 1) return "released";
      const row = rows[0] as unknown as { usd: string; scope_id: string; window_anchor_ms: number };
      const topUp = Number(row.usd) - input.trustedUsageUsd;
      if (topUp > 0) {
        await tx.query(
          "UPDATE budget_balances SET available_usd = available_usd + $1 WHERE scope_id=$2 AND window_anchor_ms=$3",
          [topUp, row.scope_id, row.window_anchor_ms],
        );
      }
      return "released";
    },
  };
}
