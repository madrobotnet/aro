"use client";

import { Eye, EyeOff } from "lucide-react";
import { useState, type Ref } from "react";
import { useCopy } from "@/components/i18n";
import { cn } from "@/components/ui/cn";
import { inputClassName } from "@/components/ui/Input";
import type { SetupSecretErrors } from "./ai-form";
import { SETUP_COPY } from "./setup-copy";

export type SetupCredentials = {
  readonly setupToken: string;
  readonly password: string;
  readonly passwordConfirmation: string;
};

type Props = {
  readonly value: SetupCredentials;
  readonly onChangeAction: (value: SetupCredentials) => void;
  readonly errors: SetupSecretErrors;
  readonly tokenFailure: string | null;
  readonly tokenRef: Ref<HTMLInputElement>;
  readonly disabled: boolean;
};

export function SetupCredentialFields({ value, onChangeAction, errors, tokenFailure, tokenRef, disabled }: Props) {
  const { form: copy, secretErrors: secretCopy } = useCopy(SETUP_COPY);
  const [tokenVisible, setTokenVisible] = useState(false);
  const [passwordVisible, setPasswordVisible] = useState(false);

  return (
    <>
      <fieldset className="flex flex-col gap-4" disabled={disabled}>
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
              value={value.setupToken}
              onChange={(event) => onChangeAction({ ...value, setupToken: event.target.value })}
              aria-invalid={errors.setupToken || tokenFailure ? true : undefined}
              aria-describedby={errors.setupToken ? "setup-token-error" : tokenFailure ? "setup-token-server-error" : "setup-token-hint"}
              className={cn(inputClassName, "h-11 pr-12")}
            />
            <button
              type="button"
              aria-label={tokenVisible ? copy.hideToken : copy.showToken}
              aria-pressed={tokenVisible}
              onClick={() => setTokenVisible((current) => !current)}
              className="control-target absolute inset-y-0 right-0 my-auto flex size-11 items-center justify-center rounded-ctl text-mute hover:bg-line/60 hover:text-ink focus-ring sm:right-1 sm:size-9"
            >
              {tokenVisible ? <EyeOff aria-hidden className="size-4" /> : <Eye aria-hidden className="size-4" />}
            </button>
          </div>
          {errors.setupToken ? (
            <p id="setup-token-error" role="alert" className="text-sm text-danger">
              {secretCopy[errors.setupToken]}
            </p>
          ) : tokenFailure ? (
            <p id="setup-token-server-error" role="alert" className="text-sm text-danger">
              {tokenFailure}
            </p>
          ) : (
            <p id="setup-token-hint" className="text-sm text-mute">
              {copy.tokenHint}
            </p>
          )}
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-4" disabled={disabled}>
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
              value={value.password}
              onChange={(event) => onChangeAction({ ...value, password: event.target.value })}
              aria-invalid={errors.password ? true : undefined}
              aria-describedby={errors.password ? "setup-password-error" : "setup-password-hint"}
              className={cn(inputClassName, "h-11 pr-12")}
            />
            <button
              type="button"
              aria-label={passwordVisible ? copy.hidePassword : copy.showPassword}
              aria-pressed={passwordVisible}
              onClick={() => setPasswordVisible((current) => !current)}
              className="control-target absolute inset-y-0 right-0 my-auto flex size-11 items-center justify-center rounded-ctl text-mute hover:bg-line/60 hover:text-ink focus-ring sm:right-1 sm:size-9"
            >
              {passwordVisible ? <EyeOff aria-hidden className="size-4" /> : <Eye aria-hidden className="size-4" />}
            </button>
          </div>
          {errors.password ? (
            <p id="setup-password-error" role="alert" className="text-sm text-danger">
              {secretCopy[errors.password]}
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
            value={value.passwordConfirmation}
            onChange={(event) => onChangeAction({ ...value, passwordConfirmation: event.target.value })}
            aria-invalid={errors.passwordConfirmation ? true : undefined}
            aria-describedby={errors.passwordConfirmation ? "setup-password-confirm-error" : undefined}
            className={cn(inputClassName, "h-11")}
          />
          {errors.passwordConfirmation ? (
            <p id="setup-password-confirm-error" role="alert" className="text-sm text-danger">
              {secretCopy[errors.passwordConfirmation]}
            </p>
          ) : null}
        </div>
      </fieldset>
    </>
  );
}
