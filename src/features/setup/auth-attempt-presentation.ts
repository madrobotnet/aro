import type { AuthAttemptView } from "@/lib/ai-auth-flow";
import type { WebAuthProvider } from "@/lib/ai-auth";
import { localizedApiError } from "@/lib/i18n/api-error";
import type { Locale } from "@/lib/i18n/locale";
import { AI_COPY, type AuthErrorKey } from "./ai-copy";

/**
 * A sign-in problem kept as a reason plus the failed request, never as rendered text, so
 * the panel re-renders it in the current language without rebuilding the controller.
 */
export type AuthPanelError = { readonly key: AuthErrorKey; readonly cause?: unknown };

/** Render a retained sign-in problem in `locale`. */
export function authPanelErrorText(error: AuthPanelError, locale: Locale): string {
  const fallback = AI_COPY[locale].auth.errors[error.key];
  return "cause" in error ? localizedApiError(error.cause, locale, fallback) : fallback;
}

export function isActiveAttempt(attempt: AuthAttemptView | null): attempt is AuthAttemptView {
  return attempt?.status === "starting" || attempt?.status === "pending";
}

/** Google waits for a pasted authorization code; polling before that cannot change anything. */
export function awaitingAuthCode(attempt: AuthAttemptView | null): boolean {
  return attempt?.status === "pending" && attempt.requiresCode === true;
}

export function attemptError(status: AuthAttemptView["status"], provider?: WebAuthProvider): AuthPanelError | null {
  switch (status) {
    case "denied":
      return { key: "denied" };
    case "expired":
      return { key: "expired" };
    case "failed":
      return { key: provider === "google" ? "googleFailed" : "failed" };
    case "starting":
    case "pending":
    case "ready":
      return null;
  }
}
