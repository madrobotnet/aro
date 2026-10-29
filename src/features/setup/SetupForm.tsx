"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useSyncExternalStore, type SyntheticEvent } from "react";
import { useCopy, useLocale } from "@/components/i18n";
import { Button } from "@/components/ui/Button";
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
import { SetupCredentialFields, type SetupCredentials } from "./SetupCredentialFields";

const noSubscription = () => () => {};

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
  const { form: copy } = useCopy(SETUP_COPY);
  const ready = useSyncExternalStore(noSubscription, () => true, () => false);
  const [credentials, setCredentials] = useState<SetupCredentials>({
    setupToken: "", password: "", passwordConfirmation: "",
  });
  const { setupToken, password, passwordConfirmation } = credentials;
  const [ai, setAi] = useState<AiFormState>(() => emptyAiForm());
  const [secretErrors, setSecretErrors] = useState<SetupSecretErrors>({});
  const [aiErrors, setAiErrors] = useState<AiFormErrors>({});
  const [state, setState] = useState<FormState>({ kind: "idle" });
  const formRef = useRef<HTMLFormElement>(null);
  const formErrorRef = useRef<HTMLParagraphElement>(null);
  const tokenRef = useRef<HTMLInputElement>(null);
  const submittingRef = useRef(false);

  const busy = state.kind === "submitting" || state.kind === "success";
  const disabled = !ready || busy;

  function onCredentialsChange(next: SetupCredentials) {
    if (next.setupToken.trim() !== setupToken.trim()) {
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
    if (next.setupToken !== setupToken && state.kind === "error" && state.failure.group === "token") {
      setState({ kind: "idle" });
    }
    setCredentials(next);
    const changed = (["setupToken", "password", "passwordConfirmation"] as const)
      .filter((field) => next[field] !== credentials[field] || (field === "passwordConfirmation" && next.password !== password));
    setSecretErrors((current) => withoutErrors(current, ...changed));
  }

  useEffect(() => {
    if (!ready || busy) return;
    const target = state.kind === "error"
      ? state.failure.group === "token" ? tokenRef.current : formErrorRef.current
      : formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]');
    target?.focus();
    target?.scrollIntoView({ block: "center" });
  }, [state, secretErrors, aiErrors, busy, ready]);

  async function onSubmit(event: SyntheticEvent<HTMLFormElement, SubmitEvent>) {
    event.preventDefault();
    if (!ready || busy || submittingRef.current) return;
    const secrets = validateSetupSecrets({ setupToken, password, passwordConfirmation });
    const built = buildAiInput(ai, null);
    setSecretErrors(secrets);
    setAiErrors(built.ok ? {} : built.errors);
    if (Object.keys(secrets).length > 0 || !built.ok) {
      setState({ kind: "idle" });
      return;
    }
    submittingRef.current = true;
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
      submittingRef.current = false;
      setState({ kind: "error", failure });
    }
  }

  // Failures and field errors stay as reasons; their text follows the current language.
  const formError = state.kind === "error" && state.failure.group !== "token" ? setupFailureText(state.failure, locale) : null;

  return (
    <form ref={formRef} method="post" onSubmit={onSubmit} noValidate className="flex flex-col gap-6">
      <SetupCredentialFields
        value={credentials}
        onChangeAction={onCredentialsChange}
        errors={secretErrors}
        tokenFailure={state.kind === "error" && state.failure.group === "token" ? setupFailureText(state.failure, locale) : null}
        tokenRef={tokenRef}
        disabled={disabled}
      />

      <div>
        <h3 className="mb-1 text-md font-semibold">{copy.aiHeading}</h3>
        <p className="mb-3 text-sm text-mute">{copy.aiLead}</p>
        <AiFields
          key={setupToken.trim()}
          idPrefix="setup-ai"
          value={ai}
          onChangeAction={setAi}
          disabled={disabled}
          errors={aiErrors}
          setupToken={setupToken.trim()}
        />
      </div>

      <div className="flex flex-col gap-3">
        <Button type="submit" variant="primary" size="lg" loading={state.kind === "submitting"} disabled={disabled} className="w-full sm:w-auto">
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
