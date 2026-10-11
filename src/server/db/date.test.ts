import { afterAll, expect, test } from "bun:test";
import { queryOne } from "./index";
import { closeDb, connectTestDatabase } from "@/server/test/db";

connectTestDatabase();
afterAll(closeDb);

test("PostgreSQL calendar dates remain date-only strings rather than timezone instants", async () => {
  const row = await queryOne<{ day: unknown; stamp: unknown }>(
    "SELECT '2026-10-12'::date AS day, '2026-10-12T00:00:00Z'::timestamptz AS stamp",
  );
  expect(row?.day).toBe("2026-10-12");
  expect(row?.stamp).toBeInstanceOf(Date);
});
