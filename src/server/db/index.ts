import { Pool, types, type PoolClient, type QueryResultRow } from "pg";
import { MIGRATIONS } from "./migrations";

// SQL DATE is a calendar key, not a local-midnight instant. Parsing it as Date
// shifts daily-note keys when converting to UTC in non-UTC server time zones.
types.setTypeParser(types.builtins.DATE, (value: string) => value);

type DbGlobal = { pool: Pool | null; ready: Promise<Pool> | null };
const g = globalThis as unknown as { __sbDb?: DbGlobal };
const state: DbGlobal = (g.__sbDb ??= { pool: null, ready: null });

/** Configuration already bound to the cached pool, independent of later env changes. */
export function connectedDatabaseUrl(): string | undefined {
  return state.pool?.options.connectionString;
}

export function databaseUrl(): string {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    throw new Error("DATABASE_URL is not set");
  }
  return url;
}

const MIGRATION_LOCK = 72_431_001;

async function migrate(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK]);
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const { rows } = await client.query<{ id: string }>("SELECT id FROM schema_migrations");
    const applied = new Set(rows.map((r) => r.id));
    for (const m of MIGRATIONS) {
      if (applied.has(m.id)) continue;
      await client.query("BEGIN");
      try {
        await client.query(m.sql);
        await client.query("INSERT INTO schema_migrations (id) VALUES ($1)", [m.id]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK]).catch(() => undefined);
    client.release();
  }
}

/** Migrated pool. Every server module goes through this. */
export function db(): Promise<Pool> {
  if (!state.ready) {
    const pool = new Pool({ connectionString: databaseUrl(), max: 10 });
    state.pool = pool;
    state.ready = migrate(pool).then(
      () => pool,
      (error: unknown) => {
        state.ready = null;
        state.pool = null;
        void pool.end();
        throw error;
      },
    );
  }
  return state.ready;
}

export async function query<T extends QueryResultRow>(text: string, params: unknown[] = []): Promise<T[]> {
  const pool = await db();
  const result = await pool.query<T>(text, params);
  return result.rows;
}

export async function queryOne<T extends QueryResultRow>(text: string, params: unknown[] = []): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

export async function tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const pool = await db();
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

/** Test-only: close the pool after database integration tests. */
export async function closeDb(): Promise<void> {
  const pool = state.pool;
  state.pool = null;
  state.ready = null;
  if (pool) await pool.end();
}
