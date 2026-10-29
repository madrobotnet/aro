"use client";

import { useId, useRef, useState } from "react";
import { useCopy, useLocale } from "@/components/i18n";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { api } from "@/lib/api-client";
import type { AiSettingsView, ConnectionProfileView } from "@/lib/ai-settings";
import { AiFields } from "@/features/setup/AiFields";
import { abandonAuthAttempt } from "@/features/setup/AiAuthPanel";
import { aiSaveFailureText, type AiConnectionStatus, type AiFormErrors } from "@/features/setup/ai-form";
import { SETTINGS_COPY } from "./settings-copy";
import {
  buildProfileInput,
  newProfileForm,
  profileFormFromView,
  type ProfilePurpose,
} from "./profile-form";

type ProfileResponse = {
  readonly profile: ConnectionProfileView;
  readonly settings: AiSettingsView;
};

function savedView(profile: ConnectionProfileView | null): AiSettingsView | null {
  if (!profile) return null;
  return {
    chat: profile.purpose === "chat" ? profile.connection : null,
    jev: profile.purpose === "jev" ? profile.connection : null,
    profiles: [profile],
    chatId: profile.purpose === "chat" ? profile.id : null,
    jevId: profile.purpose === "jev" ? profile.id : null,
    chatManagedByEnvironment: false,
    jevManagedByEnvironment: false,
  };
}

export function ConnectionProfileDialog({
  open,
  purpose,
  profile,
  connections,
  onOpenChangeAction,
  onSavedAction,
}: {
  readonly open: boolean;
  readonly purpose: ProfilePurpose;
  readonly profile: ConnectionProfileView | null;
  readonly connections: readonly AiConnectionStatus[];
  readonly onOpenChangeAction: (open: boolean) => void;
  readonly onSavedAction: (response: ProfileResponse) => void;
}) {
  const [form, setForm] = useState(() => profile ? profileFormFromView(profile) : newProfileForm(purpose));
  const { locale } = useLocale();
  const copy = useCopy(SETTINGS_COPY).dialog;
  const [errors, setErrors] = useState<AiFormErrors>({});
  // The failed request itself; its message follows the current language.
  const [saveError, setSaveError] = useState<{ readonly cause: unknown } | null>(null);
  const [saving, setSaving] = useState(false);
  const formId = useId();
  const active = useRef(false);

  const close = () => {
    if (active.current) return;
    const attemptId = purpose === "chat" ? form.chat.authAttemptId : form.jev.authAttemptId;
    if (attemptId) {
      void abandonAuthAttempt(attemptId, {})
        .catch(() => console.warn("Provider login cleanup failed; the attempt will expire."));
    }
    onOpenChangeAction(false);
  };

  const save = async () => {
    if (active.current) return;
    const built = buildProfileInput(purpose, form, profile);
    setErrors(built.ok ? {} : built.errors);
    if (!built.ok) return;
    active.current = true;
    setSaving(true);
    setSaveError(null);
    try {
      const path = profile
        ? `/api/settings/ai/connections/${profile.id}`
        : "/api/settings/ai/connections";
      const response = await api<ProfileResponse>(path, {
        method: profile ? "PUT" : "POST",
        json: built.input,
      });
      onSavedAction(response);
    } catch (cause) {
      setSaveError({ cause });
    } finally {
      active.current = false;
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      dismissible={!saving}
      onOpenChange={(next) => next ? onOpenChangeAction(true) : close()}
      size="lg"
      title={profile ? copy.editTitle : purpose === "chat" ? copy.addChatTitle : copy.addJevTitle}
      description={profile ? copy.editDescription : copy.addDescription}
      bodyClassName="px-3 sm:px-5"
      footer={
        <>
          <Button size="lg" disabled={saving} onClick={close}>{copy.cancel}</Button>
          <Button type="submit" form={formId} variant="primary" size="lg" loading={saving}>
            {saving ? copy.saving : copy.save}
          </Button>
        </>
      }
    >
      <form id={formId} noValidate onSubmit={event => { event.preventDefault(); void save(); }}
        onKeyDown={event => {
          if (event.key === "Enter" && (event.nativeEvent.isComposing || event.keyCode === 229)) event.preventDefault();
        }}>
      <AiFields
        idPrefix={`profile-${purpose}`}
        value={form}
        onChangeAction={setForm}
        disabled={saving}
        saved={savedView(profile)}
        connections={connections}
        errors={errors}
        allowDisable={false}
        purpose={purpose}
      />
      {saveError ? (
        <p role="alert" className="mt-3 rounded-ctl bg-danger-soft px-3 py-2 text-sm text-danger">
          {aiSaveFailureText(saveError.cause, locale)}
        </p>
      ) : null}
      </form>
    </Dialog>
  );
}
