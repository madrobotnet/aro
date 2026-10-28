"use client";

import { Eye, EyeOff, KeyRound, LockKeyhole } from "lucide-react";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useCopy, useLocale } from "@/components/i18n";
import { api, ApiClientError } from "@/lib/api-client";
import { Button } from "@/components/ui/Button";
import { cn } from "@/components/ui/cn";
import { inputClassName } from "@/components/ui/Input";
import { formatRemaining, LOGIN_COPY, type LoginErrorKey } from "./login-copy";

/** Locale-neutral: a failure is a reason, rendered in the current language. */
type FormState =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "error"; reason: LoginErrorKey }
  | { kind: "locked"; until: number }
  | { kind: "success" };

export type LoginFormProps = {
  /** Already sanitized by the server page. */
  next: string;
};

export function LoginForm({ next }: LoginFormProps) {
  const { locale } = useLocale();
  const copy = useCopy(LOGIN_COPY);
  const [password, setPassword] = useState("");
  const [visible, setVisible] = useState(false);
  const [state, setState] = useState<FormState>({ kind: "idle" });
  const [now, setNow] = useState(() => Date.now());
  const inputRef = useRef<HTMLInputElement>(null);
  const statusId = useId();

  const locked = state.kind === "locked" && state.until > now;
  const remainingSeconds = state.kind === "locked" ? Math.max(0, (state.until - now) / 1000) : 0;

  // Tick once a second while locked. `locked` flips to false on the tick that
  // crosses `until`, which re-runs the effect and clears the interval.
  useEffect(() => {
    if (!locked) return;
    const handle = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(handle);
  }, [locked]);

  useEffect(() => {
    if (state.kind === "locked" && !locked) inputRef.current?.focus();
  }, [state.kind, locked]);

  const busy = state.kind === "submitting" || state.kind === "success";

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || locked || password.length === 0) return;
    setState({ kind: "submitting" });
    try {
      await api<{ ok: boolean }>("/api/auth/login", { method: "POST", json: { password } });
      setState({ kind: "success" });
      window.location.assign(next);
    } catch (error) {
      setPassword("");
      setNow(Date.now());
      setState(toFailure(error));
      queueMicrotask(() => inputRef.current?.focus());
    }
  }

  const message =
    state.kind === "error"
      ? copy.errors[state.reason]
      : state.kind === "locked"
        ? locked
          ? copy.locked(formatRemaining(remainingSeconds, locale))
          : copy.lockedReady
        : state.kind === "success"
          ? copy.success
          : null;
  const tone = state.kind === "success" ? "ok" : state.kind === "locked" && !locked ? "ok" : "danger";

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4" aria-describedby={message ? statusId : undefined}>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="login-password" className="text-sm font-medium text-ink">
          {copy.passwordLabel}
        </label>
        <div className="relative">
          <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-mute">
            {locked ? <LockKeyhole aria-hidden className="size-4" /> : <KeyRound aria-hidden className="size-4" />}
          </span>
          <input
            ref={inputRef}
            id="login-password"
            name="password"
            type={visible ? "text" : "password"}
            autoComplete="current-password"
            autoFocus
            required
            disabled={busy || locked}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder={copy.passwordPlaceholder}
            aria-invalid={state.kind === "error" || undefined}
            className={cn(inputClassName, "h-11 pl-9 pr-12")}
          />
          <button
            type="button"
            aria-label={visible ? copy.hidePassword : copy.showPassword}
            aria-pressed={visible}
            onClick={() => setVisible((v) => !v)}
            disabled={busy}
            className="control-target absolute inset-y-0 right-0 my-auto flex size-11 items-center justify-center rounded-ctl text-mute hover:bg-line/60 hover:text-ink focus-ring sm:right-1 sm:size-9"
          >
            {visible ? <EyeOff aria-hidden className="size-4" /> : <Eye aria-hidden className="size-4" />}
          </button>
        </div>
      </div>

      <Button type="submit" variant="primary" size="lg" loading={state.kind === "submitting"} disabled={busy || locked || password.length === 0} className="w-full">
        {state.kind === "submitting" ? copy.submitting : copy.submit}
      </Button>

      <p
        id={statusId}
        role={tone === "danger" ? "alert" : "status"}
        aria-live="polite"
        className={cn("min-h-5 text-sm leading-5", tone === "danger" ? "text-danger" : "text-ok", !message && "sr-only")}
      >
        {message ?? ""}
      </p>
    </form>
  );
}

function toFailure(error: unknown): FormState {
  if (error instanceof ApiClientError) {
    if (error.status === 429) {
      const seconds = error.body?.error.retryAfterSeconds ?? 60;
      return { kind: "locked", until: Date.now() + Math.max(1, seconds) * 1000 };
    }
    if (error.status === 401) return { kind: "error", reason: "wrongPassword" };
    if (error.code === "unavailable" || error.status === 503) return { kind: "error", reason: "unavailable" };
    return { kind: "error", reason: "unknown" };
  }
  if (error instanceof TypeError) return { kind: "error", reason: "network" };
  return { kind: "error", reason: "unknown" };
}
