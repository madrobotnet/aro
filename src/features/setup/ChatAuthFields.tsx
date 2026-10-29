"use client";

import type { WebAuthProvider } from "@/lib/ai-auth";
import { useCopy } from "@/components/i18n";
import { Badge } from "@/components/ui/Badge";
import { inputClassName } from "@/components/ui/Input";
import { AI_COPY } from "./ai-copy";
import { AiAuthPanel } from "./AiAuthPanel";
import { FieldError, useFieldErrorText } from "./AiFieldControls";
import { ChatApiFormatField } from "./ChatApiFields";
import type { AiConnectionStatus, AiFormErrors, ChatFormState, SavedAiView } from "./ai-form";

function selectedWebAuthProvider(provider: ChatFormState["provider"]): WebAuthProvider | null {
  if (provider === "openai" || provider === "google" || provider === "github-copilot"
    || provider === "openrouter" || provider === "xai") return provider;
  return null;
}

export function ChatAuthFields({
  chat, setChatAction, abandonReadyAttemptAction, disabled, saved, connections, errors, idPrefix, setupToken,
}: {
  readonly chat: ChatFormState;
  readonly setChatAction: (patch: Partial<ChatFormState>) => void;
  readonly abandonReadyAttemptAction: () => void;
  readonly disabled: boolean;
  readonly saved: SavedAiView;
  readonly connections?: readonly AiConnectionStatus[];
  readonly errors: AiFormErrors;
  readonly idPrefix: string;
  readonly setupToken?: string;
}) {
  const copy = useCopy(AI_COPY).chat;
  const errorText = useFieldErrorText();
  const webAuthProvider = selectedWebAuthProvider(chat.provider);
  const status = connections?.find((entry) => entry.provider === chat.provider);
  // Existing OpenAI/Google profiles may rely on the server's CLI login file instead of a stored credential.
  const legacyFileAuth = (chat.provider === "openai" || chat.provider === "google")
    && saved?.chat?.mode === "auth" && saved.chat.provider === chat.provider && !saved.chat.hasCredential;
  return webAuthProvider ? (
    <>
      {legacyFileAuth ? (
        <div className="flex flex-col gap-1.5 text-sm">
          <p className="text-pretty text-mute">
            {copy.legacyCli}
          </p>
          {status ? (
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={status.available ? "ok" : "warn"}>{status.available ? copy.cliReady : copy.cliMissing}</Badge>
              <p className="text-pretty text-mute">{status.available ? copy.cliReadyDetail : copy.cliMissingDetail}</p>
            </div>
          ) : null}
        </div>
      ) : null}
      {webAuthProvider === "github-copilot" ? (
        <ChatApiFormatField idPrefix={idPrefix} chat={chat} setChatAction={setChatAction} />
      ) : null}
      {webAuthProvider === "github-copilot" ? (
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${idPrefix}-chat-domain`} className="text-sm font-medium">{copy.enterpriseDomain}</label>
          <input
            id={`${idPrefix}-chat-domain`}
            value={chat.enterpriseDomain}
            placeholder="github.example.com"
            onChange={(event) => {
              abandonReadyAttemptAction();
              setChatAction({ enterpriseDomain: event.target.value, authAttemptId: undefined, consent: false });
            }}
            aria-invalid={errors["chat.enterpriseDomain"] ? true : undefined}
            aria-describedby={errors["chat.enterpriseDomain"] ? `${idPrefix}-chat-domain-error` : undefined}
            className={inputClassName}
          />
          <FieldError id={`${idPrefix}-chat-domain-error`} message={errorText(errors["chat.enterpriseDomain"])} />
        </div>
      ) : null}
      <AiAuthPanel
        key={`${webAuthProvider}:${chat.enterpriseDomain}`}
        provider={webAuthProvider}
        enterpriseDomain={chat.enterpriseDomain}
        setupToken={setupToken}
        disabled={disabled}
        readyAttemptId={chat.authAttemptId}
        hasSavedCredential={
          saved?.chat?.mode === "auth"
          && saved.chat.provider === webAuthProvider
          && (saved.chat.enterpriseDomain ?? "") === chat.enterpriseDomain.trim()
          && Boolean(saved.chat.hasCredential)
        }
        onReadyAction={(authAttemptId) => setChatAction({ authAttemptId })}
      />
      <FieldError id={`${idPrefix}-chat-auth-error`} message={errorText(errors["chat.auth"])} />
    </>
  ) : null;
}
