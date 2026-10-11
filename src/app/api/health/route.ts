import { query } from "@/server/db";
import { databaseBackend, sqliteStore } from "@/server/db/backend";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    if (databaseBackend() === "sqlite") (await sqliteStore()).get("SELECT 1");
    else await query("SELECT 1");
    return Response.json({ ok: true });
  } catch {
    return Response.json({ ok: false }, { status: 503 });
  }
}
