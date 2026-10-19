"use client";

import { Pencil, Plus, Trash2 } from "lucide-react";
import { useCopy } from "@/components/i18n";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { inputClassName } from "@/components/ui/Input";
import type { ConnectionProfileView } from "@/lib/ai-settings";
import { AI_COPY } from "@/features/setup/ai-copy";
import type { ProfilePurpose, SelectionValue } from "./profile-form";
import { SETTINGS_COPY } from "./settings-copy";

export function AiPurposeSection({
  purpose,
  title,
  value,
  activeId,
  consent,
  profiles,
  error,
  disabled,
  onValueChangeAction,
  onConsentChangeAction,
  onAddAction,
  onEditAction,
  onDeleteAction,
}: {
  readonly purpose: ProfilePurpose;
  readonly title: string;
  readonly value: SelectionValue;
  readonly activeId: string | null;
  readonly consent: boolean;
  readonly profiles: readonly ConnectionProfileView[];
  readonly error?: string;
  readonly disabled: boolean;
  readonly onValueChangeAction: (value: string) => void;
  readonly onConsentChangeAction: (value: boolean) => void;
  readonly onAddAction: () => void;
  readonly onEditAction: (profile: ConnectionProfileView) => void;
  readonly onDeleteAction: (profile: ConnectionProfileView) => void;
}) {
  const copy = useCopy(SETTINGS_COPY).purpose;
  // Same consent wording as the connection form for this purpose.
  const consentText = useCopy(AI_COPY)[purpose].consent;
  return (
    <section aria-labelledby={`${purpose}-connections-title`} className="rounded-card border border-line p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h4 id={`${purpose}-connections-title`} className="text-md font-semibold">{title}</h4>
        <Button size="lg" disabled={disabled} leading={<Plus aria-hidden className="size-4" />} onClick={onAddAction}>{copy.add}</Button>
      </div>
      <div className="mt-4 flex flex-col gap-1.5">
        <label htmlFor={`${purpose}-active-connection`} className="text-sm font-medium">{copy.active}</label>
        <select
          id={`${purpose}-active-connection`}
          value={value}
          disabled={disabled}
          onChange={(event) => onValueChangeAction(event.target.value)}
          className={inputClassName}
        >
          <option value="off">{copy.off}</option>
          <option value="environment">{copy.environment}</option>
          {profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
        </select>
        <p className="text-sm text-mute">{copy.offNote}</p>
      </div>
      {value !== "off" ? (
        <div className="mt-3">
          <label className="flex min-h-touch cursor-pointer items-start gap-2.5 text-sm">
            <input
              type="checkbox"
              checked={consent}
              disabled={disabled}
              onChange={(event) => onConsentChangeAction(event.target.checked)}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? `${purpose}-consent-error` : undefined}
              className="mt-0.5 size-4 accent-accent"
            />
            <span>{consentText}</span>
          </label>
          {error ? <p id={`${purpose}-consent-error`} role="alert" className="mt-1 text-sm text-danger">{error}</p> : null}
        </div>
      ) : null}
      <ul className="mt-4 flex flex-col divide-y divide-line">
        {profiles.map((profile) => (
          <li key={profile.id} className="flex flex-col gap-3 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-center">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <p className="font-medium">{profile.name}</p>
                {activeId === profile.id ? <Badge tone="ok">{copy.inUse}</Badge>
                  : value === profile.id ? <Badge>{copy.selected}</Badge> : <Badge>{copy.stored}</Badge>}
              </div>
              <p className="mt-1 break-all text-sm text-mute">
                {profile.connection.provider} · {profile.connection.mode ?? "api"} · {profile.connection.model}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button size="lg" disabled={disabled} leading={<Pencil aria-hidden className="size-4" />} onClick={() => onEditAction(profile)}>{copy.edit}</Button>
              <Button variant="danger" size="lg" disabled={disabled} leading={<Trash2 aria-hidden className="size-4" />} onClick={() => onDeleteAction(profile)}>{copy.remove}</Button>
            </div>
          </li>
        ))}
        {profiles.length === 0 ? <li className="py-3 text-sm text-mute">{copy.empty}</li> : null}
      </ul>
    </section>
  );
}
