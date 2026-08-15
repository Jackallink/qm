import type { Pool, PoolClient } from "pg";
import { swallowAs } from "../util/errors.ts";

export type { Pool, PoolClient };

export type Rows = Record<string, unknown>[];

export interface PgPool {
  pool(): Promise<Pool>;
  q(text: string, params?: unknown[]): Promise<Rows>;
  query(text: string, params?: unknown[]): Promise<{ rows: Rows; rowCount: number }>;
  schema?(schemaSql: string): Promise<void>;
  close(): Promise<void>;
}

export async function withPgTransaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export function assertOneStatement(stmt: string): void {
  const bare = stmt
    .replace(/--[^\n]*/g, "")
    .replace(/\$([A-Za-z0-9_]*)\$[\s\S]*?\$\1\$/g, "")
    .replace(/'(?:[^']|'')*'/g, "")
    .replace(/;\s*$/, "");
  if (bare.includes(";")) {
    throw new Error(`pg-pool: each schema element must be a single statement (found ';' in: ${stmt.slice(0, 80)}…)`);
  }
}

async function applyDdl(pool: Pool, statements: string[]): Promise<void> {
  const ddl = await pool.connect();
  try {
    await ddl.query("SELECT pg_advisory_lock(hashtext('agent-platform:schema-init'))");
    for (const stmt of statements) {
      await ddl.query(stmt);
    }
  } finally {
    await ddl
      .query("SELECT pg_advisory_unlock(hashtext('agent-platform:schema-init'))")
      .catch(swallowAs("pg-pool: schema-init unlock", undefined));
    ddl.release();
  }
}

export function createPgPool(connectionString: string, statements: string[]): PgPool {
  const schema = statements.map((s) => s.trim()).filter((s) => s.length > 0);
  for (const stmt of schema) assertOneStatement(stmt);
  let poolP: Promise<Pool> | null = null;
  function pool(): Promise<Pool> {
    if (!poolP) {
      poolP = (async () => {
        const pg = (await import("pg")).default;
        const p = new pg.Pool({ connectionString });
        p.on("error", (err) => console.error("[pg] idle client error:", err));
        try {
          await applyDdl(p, schema);
        } catch (e) {
          await p.end().catch(swallowAs("pg-pool: close after schema failure", undefined));
          throw e;
        }
        return p;
      })().catch((e) => {
        poolP = null;
        throw e;
      });
    }
    return poolP;
  }
  async function query(text: string, params: unknown[] = []): Promise<{ rows: Rows; rowCount: number }> {
    const res = await (await pool()).query(text, params);
    return { rows: res.rows as Rows, rowCount: res.rowCount ?? 0 };
  }
  async function q(text: string, params: unknown[] = []): Promise<Rows> {
    return (await query(text, params)).rows;
  }
  async function close(): Promise<void> {
    if (poolP) await (await poolP).end();
  }
  async function applySchema(schemaSql: string): Promise<void> {
    const stmt = schemaSql.trim();
    assertOneStatement(stmt);
    await applyDdl(await pool(), [stmt]);
  }
  return { pool, q, query, schema: applySchema, close };
}

interface SharedPoolEntry {
  pool: PgPool;
  refs: number;
  applied: Set<string>;
  pending: string[];
  shared: PgPool | undefined;
}

const sharedPools = new Map<string, SharedPoolEntry>();

async function drainPending(entry: {
  pool: PgPool;
  applied: Set<string>;
  pending: string[];
}): Promise<void> {
  if (entry.pending.length === 0) return;
  const pending = entry.pending.splice(0);
  const unseen = pending.filter((s) => !entry.applied.has(s));
  if (unseen.length === 0) return;
  const p = await entry.pool.pool();
  await applyDdl(p, unseen);
  for (const stmt of unseen) entry.applied.add(stmt);
}

export function sharedPgPool(connectionString: string, statements: string[]): PgPool {
  let entry = sharedPools.get(connectionString);
  if (!entry) {
    const pool = createPgPool(connectionString, []);
    const state: SharedPoolEntry = {
      pool,
      refs: 0,
      applied: new Set<string>(),
      pending: [],
      shared: undefined,
    };
    state.shared = {
      async pool(): Promise<Pool> {
        await drainPending(state);
        return await state.pool.pool();
      },
      async q(text: string, params: unknown[] = []): Promise<Rows> {
        await drainPending(state);
        return await state.pool.q(text, params);
      },
      async query(text: string, params: unknown[] = []): Promise<{ rows: Rows; rowCount: number }> {
        await drainPending(state);
        return await state.pool.query(text, params);
      },
      async schema(schemaSql: string): Promise<void> {
        const stmt = schemaSql.trim();
        assertOneStatement(stmt);
        await drainPending(state);
        await state.pool.schema?.(stmt);
      },
      async close(): Promise<void> {
        state.refs -= 1;
        if (state.refs <= 0) {
          sharedPools.delete(connectionString);
          await state.pool.close();
        }
      },
    };
    sharedPools.set(connectionString, state);
    entry = state;
  }
  for (const stmt of statements) {
    if (!entry.applied.has(stmt.trim()) && !entry.pending.includes(stmt.trim())) {
      entry.pending.push(stmt.trim());
    }
  }
  entry.refs += 1;
  return entry.shared!;
}

