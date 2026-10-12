export const SESSION_COOKIE = "aro_session";
export const LEGACY_SESSION_COOKIE = "sb_session";
export const LOGIN_FAIL_LIMIT = 5;
export const LOGIN_FAIL_WINDOW_MIN = 15;

export function sessionTtlDays(): number {
  const raw = Number(process.env.SESSION_TTL_DAYS);
  return Number.isFinite(raw) && raw > 0 ? raw : 30;
}

export function passwordHash(): string | null {
  const value = process.env.AUTH_PASSWORD_HASH?.trim().replaceAll("\\$", "$");
  if (!value) return null;
  if (!value.startsWith("$argon2")) {
    throw new Error(
      "AUTH_PASSWORD_HASH is not a valid Argon2 PHC string; generate a dotenv-safe value with `bun run hash-password`",
    );
  }
  return value;
}
