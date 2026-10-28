"use client";

import { ExternalLink, LogIn, X } from "lucide-react";
import { useEffect, useId, useMemo, useSyncExternalStore } from "react";
import { useCopy, useLocale } from "@/components/i18n";
import { Button } from "@/components/ui/Button";
import { inputClassName } from "@/components/ui/Input";
import { cn } from "@/components/ui/cn";
import type { WebAuthProvider } from "@/lib/ai-auth";
import { AI_COPY } from "./ai-copy";
import { FieldError } from "./AiFieldControls";
import { AuthAttemptController, authPanelErrorText, awaitingAuthCode, isActiveAttempt } from "./auth-attempt";

export { abandonAuthAttempt } from "./auth-attempt";

/** Providers with their own intro and link wording; the others share the device-code wording. */
const providerVariant = (provider: WebAuthProvider) => (provider === "openai" || provider === "google" ? provider : "default");

/** Google's one-time authorization code entry. Lives inside setup/settings forms, so it never submits them. */
export function AuthCodeField({
  id,
  value,
  error,
  submitting,
  disabled,
  onChangeAction,
  onSubmitAction,
}: {
  readonly id: string;
  readonly value: string;
  readonly error: string | null;
  readonly submitting: boolean;
  readonly disabled?: boolean;
  readonly onChangeAction: (code: string) => void;
  readonly onSubmitAction: () => void;
}) {
  const copy = useCopy(AI_COPY).auth;
  return (
    <div className="mt-3 flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-ink">{copy.codeLabel}</label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          id={id}
          type="text"
          value={value}
          maxLength={4096}
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="done"
          readOnly={submitting}
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : `${id}-hint`}
          onChange={(event) => onChangeAction(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.nativeEvent.isComposing || event.keyCode === 229) return;
            // Implicit submission would send the surrounding setup or connection form instead.
            event.preventDefault();
            onSubmitAction();
          }}
          className={cn(inputClassName, "h-11 font-mono")}
        />
        <Button size="lg" loading={submitting} disabled={disabled} onClick={() => onSubmitAction()}>
          {submitting ? copy.codeSubmitting : copy.codeSubmit}
        </Button>
      </div>
      {error ? <FieldError id={`${id}-error`} message={error} /> : (
        <p id={`${id}-hint`} className="text-pretty text-sm text-mute">
          {copy.codeHint}
        </p>
      )}
    </div>
  );
}

export function AiAuthPanel({
  provider,
  enterpriseDomain,
  setupToken,
  disabled,
  readyAttemptId,
  hasSavedCredential = false,
  onReadyAction,
}: {
  readonly provider: WebAuthProvider;
  readonly enterpriseDomain?: string;
  readonly setupToken?: string;
  readonly disabled?: boolean;
  readonly readyAttemptId?: string;
  readonly hasSavedCredential?: boolean;
  readonly onReadyAction: (attemptId?: string) => void;
}) {
  // The attempt is scoped to provider and credentials only; a language switch re-renders it, never rebuilds it.
  const controller = useMemo(
    () => new AuthAttemptController({ provider, enterpriseDomain, setupToken }),
    [provider, enterpriseDomain, setupToken],
  );
  useEffect(() => controller.setReadyHandler(onReadyAction), [controller, onReadyAction]);
  // Scope change, unmount or a hidden Activity abandons the unfinished attempt and ignores its late replies.
  useEffect(() => () => controller.release(), [controller]);
  const { attempt, starting, submitting, code, codeError, error } =
    useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const { locale } = useLocale();
  const copy = useCopy(AI_COPY).auth;
  const codeId = useId();
  const variant = providerVariant(provider);
  const active = isActiveAttempt(attempt);
  const awaitingCode = awaitingAuthCode(attempt);
  const waiting = awaitingCode
    ? copy.waitingCode
    : attempt?.status === "pending" && attempt.requiresCode === false
      ? copy.checkingCode
      : copy.waiting;

  return (
    <div className="rounded-ctl border border-line bg-desk px-3 py-3 text-sm">
      <p className="text-pretty">{copy.intro[variant]}</p>
      {provider === "openrouter" ? (
        <p className="mt-2 text-mute">{copy.openRouterNote}</p>
      ) : null}
      {attempt?.verificationUrl ? (
        <a
          href={attempt.verificationUrl}
          target="_blank"
          rel="noreferrer"
          className="mt-3 inline-flex min-h-touch items-center gap-2 text-accent underline focus-ring"
        >
          {copy.link[variant]}
          <ExternalLink aria-hidden className="size-4" />
        </a>
      ) : null}
      {attempt?.userCode ? (
        <p className="mt-2">
          {copy.userCode} <code className="select-all rounded-ctl border border-line bg-card px-2 py-0.5 font-mono text-md font-semibold tracking-wider">{attempt.userCode}</code>
        </p>
      ) : null}
      {provider === "openai" && attempt && attempt.status !== "ready" ? (
        <p className="mt-2 text-pretty text-mute">
          {copy.openaiDeviceHelp}
        </p>
      ) : null}
      {attempt?.status === "ready" || readyAttemptId ? (
        <p role="status" className="mt-2 text-ok">{copy.ready}</p>
      ) : hasSavedCredential ? (
        <p className="mt-2 text-mute">
          {provider === "github-copilot" ? copy.savedWithDomain : copy.saved}
        </p>
      ) : active ? (
        <p role="status" className="mt-2 text-mute">{waiting}</p>
      ) : null}
      {awaitingCode ? (
        <AuthCodeField
          id={codeId}
          value={code}
          error={codeError ? copy.codeErrors[codeError] : null}
          submitting={submitting}
          disabled={disabled}
          onChangeAction={controller.setCode}
          onSubmitAction={() => void controller.submitCode()}
        />
      ) : null}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          size="lg"
          loading={starting}
          disabled={disabled || active}
          leading={<LogIn aria-hidden className="size-4" />}
          onClick={() => void controller.start()}
        >
          {readyAttemptId ? copy.restart : copy.start}
        </Button>
        {error && active ? (
          <Button size="lg" disabled={disabled || submitting} onClick={controller.retryStatus}>
            {copy.retryStatus}
          </Button>
        ) : null}
        {attempt ? (
          <Button size="lg" disabled={disabled} leading={<X aria-hidden className="size-4" />} onClick={() => void controller.cancel()}>
            {copy.cancel}
          </Button>
        ) : null}
      </div>
      {error ? <p role="alert" className="mt-2 text-danger">{authPanelErrorText(error, locale)}</p> : null}
    </div>
  );
}
