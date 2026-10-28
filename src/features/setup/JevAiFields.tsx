"use client";

import { JEV_PROVIDERS, JevProviderSchema } from "@/lib/ai-settings";
import { jevAuthModels } from "@/lib/ai-model-catalog";
import { useCopy } from "@/components/i18n";
import { inputClassName } from "@/components/ui/Input";
import { cn } from "@/components/ui/cn";
import { AI_COPY } from "./ai-copy";
import { AiAuthPanel, abandonAuthAttempt } from "./AiAuthPanel";
import { ConsentRow, FieldError, SecretInput, useFieldErrorText } from "./AiFieldControls";
import { AuthModelSelect } from "./AuthModelSelect";
import { jevProviderInfo, type AiFormErrors, type JevFormState, type SavedAiView } from "./ai-form";
import { modelForMode, modelForProvider, savedModelFor } from "./model-choice";

export function JevAiFields({
  value: jev,
  onChangeAction,
  disabled,
  saved,
  errors,
  idPrefix,
  setupToken,
  allowDisable = true,
}: {
  readonly value: JevFormState;
  readonly onChangeAction: (next: JevFormState) => void;
  readonly disabled: boolean;
  readonly saved: SavedAiView;
  readonly errors: AiFormErrors;
  readonly idPrefix: string;
  readonly setupToken?: string;
  readonly allowDisable?: boolean;
}) {
  const { common, jev: copy } = useCopy(AI_COPY);
  const errorText = useFieldErrorText();
  const retained = saved?.jev?.provider === jev.provider
    && (saved.jev.mode ?? "api") === "api"
    && saved.jev.hasApiKey;
  const setJev = (patch: Partial<JevFormState>) => onChangeAction({ ...jev, ...patch });
  const savedJev = saved?.jev ?? null;
  const modelCatalog = jev.mode === "auth" ? jevAuthModels(jev.provider) : null;
  const modelDescribedBy = errors["jev.model"] ? `${idPrefix}-jev-model-error` : `${idPrefix}-jev-model-hint`;
  const switchMode = (mode: JevFormState["mode"]) => modelForMode(jev, mode, savedJev, jevAuthModels(jev.provider));
  const abandonReadyAttempt = () => {
    if (!jev.authAttemptId) return;
    void abandonAuthAttempt(jev.authAttemptId, setupToken ? { setupToken } : {})
      .catch(() => console.warn("Provider login cleanup failed; the attempt will expire."));
  };

  return (
    <fieldset className="rounded-card border border-line p-4 sm:p-5" disabled={disabled}>
      <legend className="px-1 text-md font-semibold">{copy.legend}</legend>
      <p className="text-pretty text-sm leading-relaxed text-mute">
        {copy.lead}
      </p>
      {saved?.jevManagedByEnvironment ? (
        <p className="mt-2 rounded-ctl bg-warn-soft px-3 py-2 text-sm text-warn">
          {copy.environment}
        </p>
      ) : null}
      {allowDisable ? (
        <label htmlFor={`${idPrefix}-jev-enabled`} className="mt-3 flex min-h-touch cursor-pointer items-center gap-2.5 text-md font-medium">
          <input
            id={`${idPrefix}-jev-enabled`}
            type="checkbox"
            checked={jev.enabled}
            onChange={(event) => {
              if (!event.target.checked) abandonReadyAttempt();
              setJev({
                enabled: event.target.checked,
                ...(!event.target.checked ? { authAttemptId: undefined } : {}),
              });
            }}
            className="size-4 shrink-0 accent-accent"
          />
          {copy.enable}
        </label>
      ) : null}
      {jev.enabled ? (
        <div className="mt-4 flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${idPrefix}-jev-name`} className="text-sm font-medium">{common.nameLabel}</label>
            <input
              id={`${idPrefix}-jev-name`}
              value={jev.name}
              maxLength={80}
              placeholder={copy.namePlaceholder}
              onChange={(event) => setJev({ name: event.target.value })}
              aria-invalid={errors["jev.name"] ? true : undefined}
              aria-describedby={errors["jev.name"] ? `${idPrefix}-jev-name-error` : undefined}
              className={inputClassName}
            />
            <FieldError id={`${idPrefix}-jev-name-error`} message={errorText(errors["jev.name"])} />
            {!errors["jev.name"] ? (
              <p className="text-sm text-mute">
                {allowDisable ? common.nameHintOptional : common.nameHintRequired}
              </p>
            ) : null}
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <label htmlFor={`${idPrefix}-jev-provider`} className="text-sm font-medium">{copy.provider}</label>
              <select
                id={`${idPrefix}-jev-provider`}
                value={jev.provider}
                onChange={(event) => {
                  abandonReadyAttempt();
                  const provider = JevProviderSchema.parse(event.target.value);
                  setJev({
                    provider,
                    model: modelForProvider({
                      provider, mode: "api", saved: savedJev, catalog: null, apiDefault: jevProviderInfo(provider).model,
                    }),
                    otherModeModel: undefined,
                    mode: "api",
                    apiKey: "",
                    authAttemptId: undefined,
                    consent: false,
                  });
                }}
                aria-invalid={errors["jev.provider"] ? true : undefined}
                aria-describedby={errors["jev.provider"] ? `${idPrefix}-jev-provider-error` : undefined}
                className={cn(inputClassName, "pr-8")}
              >
                {JEV_PROVIDERS.map((provider) => <option key={provider.id} value={provider.id}>{copy.providers[provider.id]}</option>)}
              </select>
              <FieldError id={`${idPrefix}-jev-provider-error`} message={errorText(errors["jev.provider"])} />
            </div>
            <fieldset className="flex flex-col gap-1.5">
              <legend className="text-sm font-medium">{common.modeLegend}</legend>
              <div className="flex min-h-10 flex-wrap items-center gap-x-4 gap-y-1">
                <label className="flex min-h-touch cursor-pointer items-center gap-2 text-md">
                  <input
                    type="radio"
                    name={`${idPrefix}-jev-mode`}
                    value="api"
                    checked={jev.mode === "api"}
                    onChange={() => {
                      abandonReadyAttempt();
                      setJev({ mode: "api", authAttemptId: undefined, consent: false, ...switchMode("api") });
                    }}
                    className="size-4 accent-accent"
                  />
                  {common.modeApi}
                </label>
                {jev.provider === "openrouter" ? (
                  <label className="flex min-h-touch cursor-pointer items-center gap-2 text-md">
                    <input
                      type="radio"
                      name={`${idPrefix}-jev-mode`}
                      value="auth"
                      checked={jev.mode === "auth"}
                      onChange={() => setJev({ mode: "auth", apiKey: "", consent: false, ...switchMode("auth") })}
                      className="size-4 accent-accent"
                    />
                    {copy.modeAuth}
                  </label>
                ) : <p className="text-sm text-mute">{copy.typesafeApiOnly}</p>}
              </div>
            </fieldset>
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${idPrefix}-jev-model`} className="text-sm font-medium">{copy.model}</label>
            {modelCatalog ? (
              <AuthModelSelect
                id={`${idPrefix}-jev-model`}
                value={jev.model}
                catalog={modelCatalog}
                savedModel={savedModelFor(savedJev, jev.provider, "auth")}
                invalid={Boolean(errors["jev.model"])}
                describedBy={modelDescribedBy}
                onChangeAction={(model) => setJev({ model })}
              />
            ) : (
              <input
                id={`${idPrefix}-jev-model`}
                value={jev.model}
                onChange={(event) => setJev({ model: event.target.value })}
                aria-invalid={errors["jev.model"] ? true : undefined}
                aria-describedby={modelDescribedBy}
                autoComplete="off"
                spellCheck={false}
                className={inputClassName}
              />
            )}
            <FieldError id={`${idPrefix}-jev-model-error`} message={errorText(errors["jev.model"])} />
            {!errors["jev.model"] ? (
              <p id={`${idPrefix}-jev-model-hint`} className="text-pretty text-sm text-mute">
                {copy.modelHint}
              </p>
            ) : null}
          </div>
          {jev.mode === "api" ? (
            <SecretInput
              id={`${idPrefix}-jev-key`}
              label={copy.apiKey}
              value={jev.apiKey}
              disabled={disabled}
              onChangeAction={(apiKey) => setJev({ apiKey })}
              error={errorText(errors["jev.apiKey"])}
              hint={retained ? copy.apiKeyRetained : copy.apiKeyHint}
            />
          ) : (
            <>
              <AiAuthPanel
                provider="openrouter"
                setupToken={setupToken}
                disabled={disabled}
                readyAttemptId={jev.authAttemptId}
                hasSavedCredential={
                  saved?.jev?.provider === "openrouter"
                  && saved.jev.mode === "auth"
                  && Boolean(saved.jev.hasCredential)
                }
                onReadyAction={(authAttemptId) => setJev({ authAttemptId })}
              />
              <FieldError id={`${idPrefix}-jev-auth-error`} message={errorText(errors["jev.auth"])} />
            </>
          )}
          <ConsentRow
            id={`${idPrefix}-jev-consent`}
            checked={jev.consent}
            disabled={disabled}
            onChangeAction={(consent) => setJev({ consent })}
            error={errorText(errors["jev.consent"])}
          >
            {copy.consent}
          </ConsentRow>
        </div>
      ) : null}
    </fieldset>
  );
}
