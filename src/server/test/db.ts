import { isIP } from "node:net";
import { closeDb, connectedDatabaseUrl, db } from "@/server/db";

/** The development Compose initializer creates this separate test database. */
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://aro:aro@127.0.0.1:55432/aro_test";
// Parallel development lanes may point TEST_DATABASE_URL at their own database (sb_test_<lane>).

type TestDatabase = { readonly url: string; readonly database: string };
let initialized: TestDatabase | undefined;

class UnsafeTestDatabaseError extends Error {
  readonly code = "unsafe_test_database";
}

/** Only explicit disposable local database names are eligible for destructive tests. */
export function parseTestDatabaseUrl(raw: string): TestDatabase {
  let url: URL;
  let database: string;
  try {
    url = new URL(raw);
    database = decodeURIComponent(url.pathname.slice(1));
  } catch (error) {
    if (!(error instanceof TypeError || error instanceof URIError)) throw error;
    throw new UnsafeTestDatabaseError("TEST_DATABASE_URL is not a valid PostgreSQL test URL.");
  }
  const host = url.hostname.toLowerCase();
  const local = host === "localhost" || host === "[::1]" || (isIP(host) === 4 && host.startsWith("127."));
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) || !local || url.search || url.hash ||
    !/^(aro_test|sb_test_[a-z0-9_]+)$/.test(database)
  ) {
    throw new UnsafeTestDatabaseError(
      "Tests require a loopback aro_test or sb_test_<lane> database without URL query overrides.",
    );
  }
  return { url: url.href, database };
}

/** Point the app at the test database. Call at the top of every integration test file. */
export function connectTestDatabase(): void {
  const target = parseTestDatabaseUrl(TEST_DATABASE_URL);
  const connected = connectedDatabaseUrl();
  if (connected !== undefined && connected !== target.url) {
    throw new UnsafeTestDatabaseError("An existing database connection is not the configured test connection.");
  }
  initialized = target;
  process.env.DATABASE_URL = target.url;
}

/** Wipe all user data between tests (schema stays migrated). */
export async function resetData(): Promise<void> {
  const target = initialized;
  if (!target || process.env.DATABASE_URL !== target.url) {
    throw new UnsafeTestDatabaseError("resetData requires an initialized and unchanged test database URL.");
  }
  const pool = await db();
  if (pool.options.connectionString !== target.url) {
    throw new UnsafeTestDatabaseError("The cached connection is not the configured test database.");
  }
  const client = await pool.connect();
  try {
    const result = await client.query<{ name: string }>("SELECT current_database() AS name");
    if (result.rows[0]?.name !== target.database) {
      throw new UnsafeTestDatabaseError("The connected database does not match the configured test database.");
    }
    await client.query(
      "TRUNCATE attachment_cleanup, ai_auth_attempts, ai_connections, installation_settings, chat_messages, chat_threads, attachments, unresolved_links, links, inbox_items, notes, note_templates, sessions, users, auth_login_failures RESTART IDENTITY CASCADE",
    );
  } finally {
    client.release();
  }
}

export { closeDb };
