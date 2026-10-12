#!/usr/bin/env bun
/**
 * Print a percent-encoded postgres DATABASE_URL for Compose / .env.
 * Usage: bun scripts/build-database-url.mjs [host] [port] [database]
 * Reads POSTGRES_APP_USER, POSTGRES_APP_DB and POSTGRES_APP_PASSWORD from the environment.
 * The full URL on stdout contains credentials; keep it local and out of logs.
 */
const user = process.env.POSTGRES_APP_USER;
const password = process.env.POSTGRES_APP_PASSWORD ?? "";
if (!password || !user || !(process.argv[4] ?? process.env.POSTGRES_APP_DB)) {
  console.error("POSTGRES_APP_USER, POSTGRES_APP_DB and POSTGRES_APP_PASSWORD are required");
  process.exit(1);
}
const host = process.argv[2] ?? "db";
const port = Number(process.argv[3] ?? "5432");
const database = process.argv[4] ?? process.env.POSTGRES_APP_DB;
const encUser = encodeURIComponent(user);
const encPass = encodeURIComponent(password);
const encDb = encodeURIComponent(database);
process.stdout.write(`postgres://${encUser}:${encPass}@${host}:${port}/${encDb}`);
