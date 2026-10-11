import { setupCopy } from "@/server/i18n/setup-copy";
import { createHash, timingSafeEqual } from "node:crypto";
import { queryOne } from "@/server/db";
import { databaseBackend, sqliteStore } from "@/server/db/backend";
import { ApiError } from "@/server/http";

export type SetupState = "ready" | "disabled" | "complete";
export const OCCUPIED_SQL = `SELECT
  EXISTS (SELECT 1 FROM users)
  OR EXISTS (SELECT 1 FROM installation_settings)
  OR EXISTS (SELECT 1 FROM notes)
  OR EXISTS (SELECT 1 FROM inbox_items)
  OR EXISTS (SELECT 1 FROM chat_threads)
  OR EXISTS (SELECT 1 FROM attachments) AS occupied`;

export async function setupState(): Promise<SetupState> {
  if (process.env.AUTH_PASSWORD_HASH?.trim()) return "complete";
  if (databaseBackend() === "sqlite") {
    const { sqliteOccupied } = await import("./sqlite");
    if (sqliteOccupied(await sqliteStore())) return "complete";
    const token = process.env.SETUP_TOKEN?.trim();
    return token && token.length >= 32 && token.length <= 256 ? "ready" : "disabled";
  }
  const existing = await queryOne<{ occupied: boolean }>(OCCUPIED_SQL);
  if (existing?.occupied) return "complete";
  const token = process.env.SETUP_TOKEN?.trim();
  return token && token.length >= 32 && token.length <= 256 ? "ready" : "disabled";
}

/** Shared first-run authorization for owner creation and provider login. */
export async function requireInstallerAccess(token: string): Promise<string> {
  if (await setupState() === "complete") throw new ApiError("conflict", setupCopy.alreadyComplete);
  const expected = process.env.SETUP_TOKEN?.trim();
  if (!expected || expected.length < 32 || expected.length > 256) {
    throw new ApiError("unavailable", setupCopy.tokenMissing);
  }
  const digest = (value: string) => createHash("sha256").update(value).digest();
  const supplied = digest(token);
  if (!timingSafeEqual(digest(expected), supplied)) {
    throw new ApiError("forbidden", setupCopy.wrongCode);
  }
  if (process.env.AUTH_PASSWORD_HASH?.trim()) throw new ApiError("conflict", setupCopy.alreadySetUp);
  return `setup:${supplied.toString("hex")}`;
}
