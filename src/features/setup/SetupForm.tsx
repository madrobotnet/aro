"use client";

import { Eye, EyeOff } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type SyntheticEvent } from "react";
import { useCopy, useLocale } from "@/components/i18n";
import { Button } from "@/components/ui/Button";
import { cn } from "@/components/ui/cn";
import { inputClassName } from "@/components/ui/Input";
import { api } from "@/lib/api-client";
import type { AiSettingsInput } from "@/lib/ai-settings";
import { AiFields } from "./AiFields";
import { abandonAuthAttempt } from "./AiAuthPanel";
import {
  buildAiInput,
  emptyAiForm,
  setupFailure,
  setupFailureText,
  validateSetupSecrets,
  type AiFormErrors,
  type AiFormState,
  type SetupFailure,
  type SetupSecretErrors,
} from "./ai-form";
import { SETUP_COPY } from "./setup-copy";

type FormState =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "error"; failure: SetupFailure }
  | { kind: "success" };

function withoutErrors(errors: SetupSecretErrors, ...fields: (keyof SetupSecretErrors)[]): SetupSecretErrors {
  if (!fields.some((field) => errors[field])) return errors;
  const next = { ...errors };
  for (const field of fields) delete next[field];
  return next;
}

export function SetupForm() {
  const router = useRouter();
  const { locale } = useLocale();
  const { form: copy, secretErrors: secretCopy } = useCopy(SETUP_COPY);
  const [setupToken, setSetupToken] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirmation, setPasswordConfirmation] = useState("");
  const [tokenVisible, setTokenVisible] = useState(false);
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [ai, setAi] = useState<AiFormState>(() => emptyAiForm());
  const [secretErrors, setSecretErrors] = useState<SetupSecretErrors>({});
  const [aiErrors, setAiErrors] = useState<AiFormErrors>({});
  const [state, setState] = useState<FormState>({ kind: "idle" });
  const formRef = useRef<HTMLFormElement>(null);
  const formErrorRef = useRef<HTMLParagraphElement>(null);
  const tokenRef = useRef<HTMLInputElement>(null);

  const busy = state.kind === "submitting" || state.kind === "success";

  useEffect(() => {
    if (busy) return;
    const target = state.kind === "error"
      ? state.failure.group === "token" ? tokenRef.current : formErrorRef.current
      : formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]');
    target?.focus();
    target?.scrollIntoView({ block: "center" });
  }, [state, secretErrors, aiErrors, busy]);

  async function onSubmit(event: SyntheticEvent<HTMLFormElement, SubmitEvent>) {
    event.preventDefault();
    if (busy) return;
    const secrets = validateSetupSecrets({ setupToken, password, passwordConfirmation });
    const built = buildAiInput(ai, null);
    setSecretErrors(secrets);
    setAiErrors(built.ok ? {} : built.errors);
    if (Object.keys(secrets).length > 0 || !built.ok) {
      setState({ kind: "idle" });
      return;
    }
    setState({ kind: "submitting" });
    try {
      await api<{ ok: boolean }>("/api/setup", {
        method: "POST",
        json: { setupToken: setupToken.trim(), password, passwordConfirmation, ai: built.input satisfies AiSettingsInput },
      });
      setState({ kind: "success" });
      router.push("/login?setup=complete");
    } catch (error) {
      // Recoverable: every field, including secrets, stays exactly as entered.
      const failure = setupFailure(error);
      setState({ kind: "error", failure });
    }
  }

  // Failures and field errors stay as reasons; their text follows the current language.
  const formError = state.kind === "error" && state.failure.group !== "token" ? setupFailureText(state.failure, locale) : null;

  return (
    <form ref={formRef} onSubmit={onSubmit} noValidate className="flex flex-col gap-6">
      <fieldset className="flex flex-col gap-4" disabled={busy}>
        <legend className="mb-1 text-md font-semibold">{copy.tokenLegend}</legend>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="setup-token" className="text-sm font-medium text-ink">
            {copy.tokenLabel}
          </label>
          <div className="relative">
            <input
              ref={tokenRef}
              id="setup-token"
              name="setupToken"
              type={tokenVisible ? "text" : "password"}
              autoComplete="off"
              spellCheck={false}
              required
              minLength={32}
              maxLength={256}
              value={setupToken}
              onChange={(event) => {
                const nextToken = event.target.value;
                if (nextToken.trim() !== setupToken.trim()) {
                  for (const id of [ai.chat.authAttemptId, ai.jev.authAttemptId]) {
                    if (id) {
                      void abandonAuthAttempt(id, { setupToken })
                        .catch(() => console.warn("Provider login cleanup failed; the attempt will expire."));
                    }
                  }
                  setAi((current) => ({
                    chat: { ...current.chat, authAttemptId: undefined },
                    jev: { ...current.jev, authAttemptId: undefined },
                  }));
                }
                setSetupToken(nextToken);
                setSecretErrors((current) => withoutErrors(current, "setupToken"));
                if (state.kind === "error" && state.failure.group === "token") setState({ kind: "idle" });
              }}
              aria-invalid={secretErrors.setupToken || (state.kind === "error" && state.failure.group === "token") ? true : undefined}
              aria-describedby={
                secretErrors.setupToken
                  ? "setup-token-error"
                  : state.kind === "error" && state.failure.group === "token"
                    ? "setup-token-server-error"
                    : "setup-token-hint"
              }
              className={cn(inputClassName, "h-11 pr-12")}
            />
            <button
              type="button"
              aria-label={tokenVisible ? copy.hideToken : copy.showToken}
              aria-pressed={tokenVisible}
              onClick={() => setTokenVisible((current) => !current)}
              className="absolute inset-y-0 right-0 my-auto flex size-11 items-center justify-center rounded-ctl text-mute hover:bg-line/60 hover:text-ink focus-ring sm:right-1 sm:size-9"
            >
              {tokenVisible ? <EyeOff aria-hidden className="size-4" /> : <Eye aria-hidden className="size-4" />}
            </button>
          </div>
          {secretErrors.setupToken ? (
            <p id="setup-token-error" role="alert" className="text-sm text-danger">
              {secretCopy[secretErrors.setupToken]}
            </p>
          ) : state.kind === "error" && state.failure.group === "token" ? (
            <p id="setup-token-server-error" role="alert" className="text-sm text-danger">
              {setupFailureText(state.failure, locale)}
            </p>
          ) : (
            <p id="setup-token-hint" className="text-sm text-mute">
              {copy.tokenHint}
            </p>
          )}
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-4" disabled={busy}>
        <legend className="mb-1 text-md font-semibold">{copy.passwordLegend}</legend>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="setup-password" className="text-sm font-medium text-ink">
            {copy.passwordLabel}
          </label>
          <div className="relative">
            <input
              id="setup-password"
              name="password"
              type={passwordVisible ? "text" : "password"}
              autoComplete="new-password"
              required
              minLength={12}
              maxLength={512}
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
                setSecretErrors((current) => withoutErrors(current, "password", "passwordConfirmation"));
              }}
              aria-invalid={secretErrors.password ? true : undefined}
              aria-describedby={secretErrors.password ? "setup-password-error" : "setup-password-hint"}
              className={cn(inputClassName, "h-11 pr-12")}
            />
            <button
              type="button"
              aria-label={passwordVisible ? copy.hidePassword : copy.showPassword}
              aria-pressed={passwordVisible}
              onClick={() => setPasswordVisible((current) => !current)}
              className="absolute inset-y-0 right-0 my-auto flex size-11 items-center justify-center rounded-ctl text-mute hover:bg-line/60 hover:text-ink focus-ring sm:right-1 sm:size-9"
            >
              {passwordVisible ? <EyeOff aria-hidden className="size-4" /> : <Eye aria-hidden className="size-4" />}
            </button>
          </div>
          {secretErrors.password ? (
            <p id="setup-password-error" role="alert" className="text-sm text-danger">
              {secretCopy[secretErrors.password]}
            </p>
          ) : (
            <p id="setup-password-hint" className="text-sm text-mute">
              {copy.passwordHint}
            </p>
          )}
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="setup-password-confirm" className="text-sm font-medium text-ink">
            {copy.confirmLabel}
          </label>
          <input
            id="setup-password-confirm"
            name="passwordConfirmation"
            type={passwordVisible ? "text" : "password"}
            autoComplete="new-password"
            required
            minLength={12}
            maxLength={512}
            value={passwordConfirmation}
            onChange={(event) => {
              setPasswordConfirmation(event.target.value);
              setSecretErrors((current) => withoutErrors(current, "passwordConfirmation"));
            }}
            aria-invalid={secretErrors.passwordConfirmation ? true : undefined}
            aria-describedby={secretErrors.passwordConfirmation ? "setup-password-confirm-error" : undefined}
            className={cn(inputClassName, "h-11")}
          />
          {secretErrors.passwordConfirmation ? (
            <p id="setup-password-confirm-error" role="alert" className="text-sm text-danger">
              {secretCopy[secretErrors.passwordConfirmation]}
            </p>
          ) : null}
        </div>
      </fieldset>

      <div>
        <h3 className="mb-1 text-md font-semibold">{copy.aiHeading}</h3>
        <p className="mb-3 text-sm text-mute">{copy.aiLead}</p>
        <AiFields
          key={setupToken.trim()}
          idPrefix="setup-ai"
          value={ai}
          onChangeAction={setAi}
          disabled={busy}
          errors={aiErrors}
          setupToken={setupToken.trim()}
        />
      </div>

      <div className="flex flex-col gap-3">
        <Button type="submit" variant="primary" size="lg" loading={state.kind === "submitting"} disabled={busy} className="w-full sm:w-auto">
          {state.kind === "submitting" ? copy.submitting : copy.submit}
        </Button>
        {formError ? (
          <p ref={formErrorRef} tabIndex={-1} role="alert" className="rounded-ctl bg-danger-soft px-3 py-2 text-sm text-danger">
            {formError}
          </p>
        ) : null}
        {state.kind === "success" ? (
          <p role="status" className="text-sm text-ok">
            {copy.success}
          </p>
        ) : null}
      </div>
    </form>
  );
}
