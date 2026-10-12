import { expect, test } from "bun:test";
import { Client } from "pg";
import { z } from "zod";
import { parseTestDatabaseUrl, TEST_DATABASE_URL } from "./db";

const Result = z.object({
  accepted: z.boolean(),
  code: z.string().nullable(),
  message: z.string().nullable(),
  database: z.string().nullable(),
});
const secret = "fixture-secret-not-for-logs";
const local = `postgres://fixture:${secret}@127.0.0.1:1/aro_test`;

async function runHelper(testUrl: string, action = "connect") {
  const child = Bun.spawn([
    process.execPath, "--no-env-file", "-e",
    `const helper = await import("./src/server/test/db.ts");
     try {
       if (process.env.CASE_ACTION !== "uninitialized") helper.connectTestDatabase();
       if (process.env.CASE_ACTION === "changed") {
         process.env.DATABASE_URL = "postgres://fixture:fixture@127.0.0.1:1/aro";
       }
       if (process.env.CASE_ACTION !== "connect") await helper.resetData();
       helper.connectTestDatabase();
       console.log(JSON.stringify({
         accepted: true, code: null, message: null,
         database: new URL(process.env.DATABASE_URL).pathname,
       }));
     } catch (error) {
       console.log(JSON.stringify({
         accepted: false, code: typeof error.code === "string" ? error.code : null,
         message: error instanceof Error ? error.message : null, database: null,
       }));
     } finally { await helper.closeDb(); }`,
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_URL: "postgres://fixture:fixture@127.0.0.1:1/aro",
      TEST_DATABASE_URL: testUrl,
      CASE_ACTION: action,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exit, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  expect(stderr).toBe("");
  expect(exit).toBe(0);
  return Result.parse(JSON.parse(stdout));
}

for (const [label, url, database] of [
  ["default name", local, "/aro_test"],
  ["parallel lane", local.replace("aro_test", "sb_test_notes"), "/sb_test_notes"],
  ["localhost", local.replace("127.0.0.1", "localhost"), "/aro_test"],
  ["IPv6 loopback", local.replace("127.0.0.1", "[::1]"), "/aro_test"],
  ["IPv4 loopback", local.replace("127.0.0.1", "127.0.0.2"), "/aro_test"],
] as const) {
  test(`permits repeated initialization of the explicit local test database: ${label}`, async () => {
    const result = await runHelper(url);

    expect(result).toEqual({ accepted: true, code: null, message: null, database });
  });
}

for (const [label, url] of [
  ["application database", local.replace("aro_test", "aro")],
  ["maintenance database", local.replace("aro_test", "postgres")],
  ["remote host", local.replace("127.0.0.1", "db.example.invalid")],
  ["loopback lookalike", local.replace("127.0.0.1", "127.remote.invalid")],
  ["missing database", local.replace("aro_test", "")],
  ["missing host", `postgres://fixture:${secret}@/aro_test`],
  ["socket host", `postgres://fixture:${secret}@%2Ftmp/aro_test`],
  ["host override", local + "?host=production.invalid"],
  ["port override", local + "?port=5432"],
  ["server options", local + "?options=-csearch_path%3Dprivate"],
  ["wrong protocol", local.replace("postgres:", "mysql:")],
  ["invalid URL", secret],
] as const) {
  test(`rejects an unsafe test target before connecting: ${label}`, async () => {
    const result = await runHelper(url);

    expect(result.accepted).toBe(false);
    expect(result.code).toBe("unsafe_test_database");
    expect(result.message).not.toContain(secret);
  });
}

for (const action of ["uninitialized", "changed"]) {
  test(`rejects ${action} reset before opening a database connection`, async () => {
    const result = await runHelper(local, action);

    expect(result.accepted).toBe(false);
    expect(result.code).toBe("unsafe_test_database");
  });
}

for (const phase of ["connect", "reset", "connected-name"]) {
  test(`preserves data in a cached foreign connection during ${phase}`, async () => {
    const selected = parseTestDatabaseUrl(TEST_DATABASE_URL);
    const admin = new Client({ connectionString: selected.url });
    const name = `sb_test_guard_${crypto.randomUUID().replaceAll("-", "")}`;
    const foreign = new URL(selected.url);
    foreign.pathname = `/${name}`;
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE "${name}"`);
      try {
        const child = Bun.spawn([
          process.execPath, "--no-env-file", "-e",
          `const { db, query, closeDb } = await import("./src/server/db/index.ts");
           const helper = await import("./src/server/test/db.ts");
           try {
             if (process.env.CASE_PHASE !== "connect") helper.connectTestDatabase();
             process.env.DATABASE_URL = process.env.FOREIGN_DATABASE_URL;
             await query("INSERT INTO notes (title,body) VALUES ('guard fixture','guard body')");
             const pool = await db();
             let code = null;
             let accepted = false;
             try {
               if (process.env.CASE_PHASE === "connect") helper.connectTestDatabase();
               else {
                 process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
                 if (process.env.CASE_PHASE === "connected-name") {
                   // An existing physical connection can outlive changed pool metadata.
                   pool.options.connectionString = process.env.TEST_DATABASE_URL;
                 }
               }
               await helper.resetData();
               accepted = true;
             } catch (error) { code = typeof error.code === "string" ? error.code : null; }
             const [row] = await query("SELECT count(*)::int AS remaining FROM notes");
             console.log(JSON.stringify({ accepted, code, remaining: row.remaining }));
           } finally { await closeDb(); }`,
        ], {
          cwd: process.cwd(),
          env: {
            ...process.env,
            DATABASE_URL: selected.url,
            TEST_DATABASE_URL: selected.url,
            FOREIGN_DATABASE_URL: foreign.href,
            CASE_PHASE: phase,
          },
          stdout: "pipe",
          stderr: "pipe",
        });
        const [exit, stdout, stderr] = await Promise.all([
          child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
        ]);

        expect(stderr).toBe("");
        expect(exit).toBe(0);
        expect(JSON.parse(stdout)).toEqual({
          accepted: false, code: "unsafe_test_database", remaining: 1,
        });
      } finally {
        await admin.query(`DROP DATABASE "${name}"`);
      }
    } finally {
      await admin.end();
    }
  });
}
