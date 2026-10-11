"use client";

import { RefreshCw } from "lucide-react";
import { useState } from "react";
import useSWR, { useSWRConfig } from "swr";
import { useCopy, useLocale } from "@/components/i18n";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Skeleton } from "@/components/ui/Skeleton";
import { api, fetcher } from "@/lib/api-client";
import type { AiSettingsView, ConnectionProfileView } from "@/lib/ai-settings";
import { localizedApiError } from "@/lib/i18n/api-error";
import {
  aiSaveFailureText,
  type AiSettingsResponse,
} from "@/features/setup/ai-form";
import { Section } from "./SettingsSection";
import { ConnectionProfileDialog } from "./ConnectionProfileDialog";
import { AiPurposeSection } from "./AiPurposeSection";
import {
  buildSelectionInput,
  selectionFromView,
  type ProfilePurpose,
  type SelectionState,
  type SelectionValue,
} from "./profile-form";
import { SETTINGS_COPY } from "./settings-copy";
import type { ChatStatus } from "./settings-model";

const AI_SETTINGS_KEY = "/api/settings/ai";
const CHAT_STATUS_KEY = "/api/chat/status";

function ChatStatusBadge() {
  const copy = useCopy(SETTINGS_COPY).ai;
  const { data, error, isLoading } = useSWR<ChatStatus>(CHAT_STATUS_KEY, fetcher, {
    revalidateOnFocus: false,
    shouldRetryOnError: false,
  });
  if (isLoading && !data) return <Skeleton className="h-5 w-16 rounded-pill" />;
  if (error && !data) return <Badge tone="danger">{copy.statusFailed}</Badge>;
  return data?.available ? <Badge tone="ok">{copy.statusReady}</Badge> : <Badge>{copy.statusOff}</Badge>;
}

type EditorState = {
  readonly purpose: ProfilePurpose;
  readonly profile: ConnectionProfileView | null;
};

/** A failed request kept as-is; its text is chosen at render time in the current language. */
type RetainedFailure = { readonly cause: unknown } | null;

export function AiConnections() {
  const { data, error, isLoading, mutate } = useSWR<AiSettingsResponse>(AI_SETTINGS_KEY, fetcher, {
    revalidateOnFocus: false,
    shouldRetryOnError: false,
  });
  const { mutate: mutateGlobal } = useSWRConfig();
  const { locale } = useLocale();
  const copy = useCopy(SETTINGS_COPY).ai;
  const [selectionEdits, setSelectionEdits] = useState<SelectionState | null>(null);
  // Which purposes still need consent; the message is looked up when rendered.
  const [selectionErrors, setSelectionErrors] = useState<{ readonly chat?: boolean; readonly jev?: boolean }>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<RetainedFailure>(null);
  const [savedNotice, setSavedNotice] = useState(false);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [deleting, setDeleting] = useState<ConnectionProfileView | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<RetainedFailure>(null);

  const selection = selectionEdits ?? (data ? selectionFromView(data.settings) : null);

  const setChoice = (purpose: ProfilePurpose, value: SelectionValue) => {
    if (!selection) return;
    setSavedNotice(false);
    setSelectionErrors({});
    setSelectionEdits({
      ...selection,
      [purpose]: value,
      [`${purpose}Consent`]: value === "off",
    });
  };

  const saveSelection = async () => {
    if (!data || !selection || saving) return;
    const errors = {
      ...(selection.chat !== "off" && !selection.chatConsent ? { chat: true } : {}),
      ...(selection.jev !== "off" && !selection.jevConsent ? { jev: true } : {}),
    };
    setSelectionErrors(errors);
    if (Object.keys(errors).length > 0) return;
    setSaving(true);
    setSaveError(null);
    setSavedNotice(false);
    try {
      const response = await api<AiSettingsResponse>(AI_SETTINGS_KEY, {
        method: "PUT",
        json: buildSelectionInput(selection),
      });
      await mutate(response, { revalidate: false });
      setSelectionEdits(null);
      setSavedNotice(true);
      void mutateGlobal(CHAT_STATUS_KEY);
    } catch (cause) {
      setSaveError({ cause });
    } finally {
      setSaving(false);
    }
  };

  const removeProfile = async () => {
    if (!data || !deleting || deleteBusy) return;
    const deletedId = deleting.id;
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      const response = await api<{ readonly settings: AiSettingsView }>(
        `/api/settings/ai/connections/${deletedId}`,
        { method: "DELETE" },
      );
      await mutate({ settings: response.settings, connections: data.connections }, { revalidate: false });
      setSelectionEdits((current) => {
        if (!current) return null;
        const saved = selectionFromView(response.settings);
        return {
          chat: current.chat === deletedId ? saved.chat : current.chat,
          chatConsent: current.chat === deletedId ? saved.chatConsent : current.chatConsent,
          jev: current.jev === deletedId ? saved.jev : current.jev,
          jevConsent: current.jev === deletedId ? saved.jevConsent : current.jevConsent,
        };
      });
      setDeleting(null);
      void mutateGlobal(CHAT_STATUS_KEY);
    } catch (cause) {
      setDeleteError({ cause });
    } finally {
      setDeleteBusy(false);
    }
  };

  return (
    <Section
      id="settings-ai"
      title={copy.title}
      description={copy.description}
    >
      <div className="surface-card px-4 py-4 sm:px-5 sm:py-5">
        {isLoading && !data ? (
          <div aria-label={copy.loading} className="flex flex-col gap-2">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : error && !data ? (
          <div role="alert" className="flex flex-col items-start gap-2">
            <p className="text-md font-medium text-danger">{copy.loadFailed}</p>
            <p className="text-sm text-mute">{localizedApiError(error, locale, copy.loadHint)}</p>
            <Button size="lg" leading={<RefreshCw aria-hidden className="size-4" />} onClick={() => void mutate()}>
              {copy.reload}
            </Button>
          </div>
        ) : data && selection ? (
          <div className="flex flex-col gap-6">
            <p className="text-sm leading-relaxed text-mute">{locale === "ko"
              ? "AI 없이도 노트·캡처·검색을 쓸 수 있어요. 연결을 만든 뒤 사용할 기능을 고르고, 전송되는 정보를 확인한 다음 저장하세요. '끔'은 연결 정보를 보관하면서 호출을 중단해요."
              : "Notes, capture and search work without AI. Create a connection, choose its purpose, then review what is shared before saving. Off retains the connection but stops calls."}</p>
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-md font-medium">{copy.chatStatus}</h3>
              <ChatStatusBadge />
            </div>
            <AiPurposeSection
              purpose="chat"
              title={copy.chatTitle}
              value={selection.chat}
              activeId={data.settings.chatId}
              consent={selection.chatConsent}
              profiles={data.settings.profiles.filter((profile) => profile.purpose === "chat")}
              error={selectionErrors.chat ? copy.chatConsentRequired : undefined}
              disabled={saving}
              onValueChangeAction={(value) => setChoice("chat", value)}
              onConsentChangeAction={(chatConsent) => {
                setSavedNotice(false);
                setSelectionEdits({ ...selection, chatConsent });
              }}
              onAddAction={() => setEditor({ purpose: "chat", profile: null })}
              onEditAction={(profile) => setEditor({ purpose: "chat", profile })}
              onDeleteAction={setDeleting}
            />
            <AiPurposeSection
              purpose="jev"
              title={copy.jevTitle}
              value={selection.jev}
              activeId={data.settings.jevId}
              consent={selection.jevConsent}
              profiles={data.settings.profiles.filter((profile) => profile.purpose === "jev")}
              error={selectionErrors.jev ? copy.jevConsentRequired : undefined}
              disabled={saving}
              onValueChangeAction={(value) => setChoice("jev", value)}
              onConsentChangeAction={(jevConsent) => {
                setSavedNotice(false);
                setSelectionEdits({ ...selection, jevConsent });
              }}
              onAddAction={() => setEditor({ purpose: "jev", profile: null })}
              onEditAction={(profile) => setEditor({ purpose: "jev", profile })}
              onDeleteAction={setDeleting}
            />
            <div className="flex flex-col gap-3 border-t border-line pt-4">
              <div className="flex flex-wrap items-center gap-3">
                <Button variant="primary" size="lg" loading={saving} onClick={() => void saveSelection()}>
                  {saving ? copy.saving : copy.save}
                </Button>
                {savedNotice ? <p role="status" className="text-sm text-ok">{copy.saved}</p> : null}
              </div>
              {saveError ? <p role="alert" className="rounded-ctl bg-danger-soft px-3 py-2 text-sm text-danger">{aiSaveFailureText(saveError.cause, locale)}</p> : null}
            </div>
          </div>
        ) : null}
      </div>
      {editor && data ? (
        <ConnectionProfileDialog
          key={`${editor.purpose}:${editor.profile?.id ?? "new"}`}
          open
          purpose={editor.purpose}
          profile={editor.profile}
          connections={data.connections}
          onOpenChangeAction={(open) => {
            if (!open) setEditor(null);
          }}
          onSavedAction={(response) => {
            void mutate({ settings: response.settings, connections: data.connections }, { revalidate: false });
            void mutateGlobal(CHAT_STATUS_KEY);
            setEditor(null);
          }}
        />
      ) : null}
      <Dialog
        open={Boolean(deleting)}
        dismissible={!deleteBusy}
        onOpenChange={(open) => {
          if (!open && !deleteBusy) {
            setDeleting(null);
            setDeleteError(null);
          }
        }}
        size="sm"
        title={copy.deleteTitle}
        description={copy.deleteDescription}
        footer={
          <>
            <Button size="lg" disabled={deleteBusy} onClick={() => setDeleting(null)}>{copy.cancel}</Button>
            <Button variant="danger" size="lg" loading={deleteBusy} onClick={() => void removeProfile()}>{copy.delete}</Button>
          </>
        }
      >
        {deleteError ? <p role="alert" className="rounded-ctl bg-danger-soft px-3 py-2 text-sm text-danger">{aiSaveFailureText(deleteError.cause, locale)}</p> : null}
      </Dialog>
    </Section>
  );
}
