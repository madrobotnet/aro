"use client";

import { Trash2 } from "lucide-react";
import { Fragment, useId, useRef, useState, type FormEvent } from "react";
import { useCopy, useLocale } from "@/components/i18n";
import { Button, Dialog, Input, Textarea } from "@/components/ui";
import { api } from "@/lib/api-client";
import { localizedApiError } from "@/lib/i18n/api-error";
import { TEMPLATE_BODY_MAX, TEMPLATE_NAME_MAX, TEMPLATE_VARIABLES, type NoteTemplate } from "@/lib/templates";
import { SETTINGS_COPY } from "./settings-copy";
import { draftFromTemplate, EMPTY_TEMPLATE_DRAFT, hasDraftErrors, templateCreateBody, templateErrorField, templatePatch, validateTemplateDraft, type TemplateDraft, type TemplateDraftErrors } from "./template-form";
import { TEMPLATES_KEY } from "./template-note";

const PLACEHOLDER_SPLIT = new RegExp(`(\\{\\{(?:${TEMPLATE_VARIABLES.join("|")})\\}\\})`);

export function Placeholders({ text }: { text: string }) {
  return text.split(PLACEHOLDER_SPLIT).map((part, index) =>
    index % 2 === 1 ? (
      <code key={index} className="rounded-sm bg-line/60 px-1 text-xs text-ink">{part}</code>
    ) : (
      <Fragment key={index}>{part}</Fragment>
    ),
  );
}

type SaveError = { field: "name" | "form"; cause: unknown };

/** Remounted (keyed) for every open, so a draft never leaks from one template into the next. */
export function TemplateEditor({ open, template, onOpenChange, onSaved }: {
  open: boolean;
  template: NoteTemplate | null;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const copy = useCopy(SETTINGS_COPY).templates;
  const { locale } = useLocale();
  const formId = useId();
  const nameRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState<TemplateDraft>(() => (template ? draftFromTemplate(template) : EMPTY_TEMPLATE_DRAFT));
  const [fieldErrors, setFieldErrors] = useState<TemplateDraftErrors>({});
  const [saveError, setSaveError] = useState<SaveError | null>(null);
  const [saving, setSaving] = useState(false);

  const update = (patch: Partial<TemplateDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setSaveError(null);
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving) return;
    const errors = validateTemplateDraft(draft);
    setFieldErrors(errors);
    setSaveError(null);
    if (hasDraftErrors(errors)) {
      (errors.name ? nameRef : bodyRef).current?.focus();
      return;
    }
    const patch = template ? templatePatch(template, draft) : null;
    if (patch && Object.keys(patch).length === 0) {
      onOpenChange(false);
      return;
    }
    setSaving(true);
    try {
      if (template) await api(`/api/templates/${encodeURIComponent(template.id)}`, { method: "PATCH", json: patch });
      else await api(TEMPLATES_KEY, { method: "POST", json: templateCreateBody(draft) });
      setSaving(false);
      onSaved();
    } catch (cause) {
      const field = templateErrorField(cause);
      setSaveError({ field, cause });
      setSaving(false);
      if (field === "name") nameRef.current?.focus();
    }
  };

  const nameError = saveError?.field === "name"
    ? localizedApiError(saveError.cause, locale, copy.saveFailed)
    : fieldErrors.name === "required" ? copy.nameRequired
      : fieldErrors.name === "tooLong" ? copy.nameTooLong(TEMPLATE_NAME_MAX) : undefined;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!saving) onOpenChange(next);
      }}
      dismissible={!saving}
      initialFocusRef={nameRef}
      title={template ? copy.editTitle : copy.addTitle}
      footer={
        <>
          <Button size="lg" disabled={saving} onClick={() => onOpenChange(false)}>{copy.cancel}</Button>
          <Button type="submit" form={formId} variant="primary" size="lg" loading={saving}>{copy.save}</Button>
        </>
      }
    >
      <form id={formId} noValidate onSubmit={(event) => void submit(event)} className="flex flex-col gap-4 pb-1">
        <Input
          ref={nameRef}
          label={copy.nameLabel}
          placeholder={copy.namePlaceholder}
          value={draft.name}
          maxLength={TEMPLATE_NAME_MAX}
          aria-required
          autoComplete="off"
          error={nameError}
          className="max-lg:h-11"
          onChange={(event) => update({ name: event.target.value })}
        />
        <Textarea
          ref={bodyRef}
          label={copy.bodyLabel}
          placeholder={copy.bodyPlaceholder}
          value={draft.body}
          rows={10}
          maxLength={TEMPLATE_BODY_MAX}
          spellCheck={false}
          hint={<Placeholders text={copy.help} />}
          error={fieldErrors.body === "tooLong" ? copy.bodyTooLong : undefined}
          onChange={(event) => update({ body: event.target.value })}
        />
        <div className="flex flex-col gap-1">
          <label className="flex min-h-touch cursor-pointer items-center gap-3 text-md font-medium">
            <input
              type="checkbox"
              checked={draft.isDailyDefault}
              aria-describedby={`${formId}-daily-hint`}
              onChange={(event) => update({ isDailyDefault: event.target.checked })}
              className="size-4 shrink-0 cursor-pointer accent-accent"
            />
            {copy.dailyLabel}
          </label>
          <p id={`${formId}-daily-hint`} className="text-sm text-mute">{copy.dailyHint}</p>
        </div>
        {saveError?.field === "form" ? (
          <p role="alert" className="rounded-ctl bg-danger-soft px-3 py-2 text-sm text-danger">
            {localizedApiError(saveError.cause, locale, copy.saveFailed)}
          </p>
        ) : null}
      </form>
    </Dialog>
  );
}

export function DeleteTemplateDialog({ template, onClose, onDeleted }: {
  template: NoteTemplate | null;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const copy = useCopy(SETTINGS_COPY).templates;
  const { locale } = useLocale();
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<{ readonly cause: unknown } | null>(null);

  const remove = async () => {
    if (!template) return;
    setRemoving(true);
    setRemoveError(null);
    try {
      await api(`/api/templates/${encodeURIComponent(template.id)}`, { method: "DELETE" });
      onDeleted();
    } catch (cause) {
      setRemoveError({ cause });
    } finally {
      setRemoving(false);
    }
  };

  return (
    <Dialog
      open={template !== null}
      onOpenChange={(open) => {
        if (open || removing) return;
        setRemoveError(null);
        onClose();
      }}
      dismissible={!removing}
      size="sm"
      bodyClassName="empty:hidden"
      title={template ? copy.deleteTitle(template.name) : undefined}
      description={copy.deleteDescription}
      footer={
        <>
          <Button size="lg" disabled={removing} onClick={() => { setRemoveError(null); onClose(); }}>{copy.cancel}</Button>
          <Button variant="danger" size="lg" loading={removing} leading={<Trash2 aria-hidden className="size-4" />} onClick={() => void remove()}>
            {copy.deleteConfirm}
          </Button>
        </>
      }
    >
      {template?.isDailyDefault ? <p className="text-sm text-mute">{copy.deleteDefault}</p> : null}
      {removeError ? (
        <p role="alert" className="mt-2 rounded-ctl bg-danger-soft px-3 py-2 text-sm text-danger first:mt-0">
          {localizedApiError(removeError.cause, locale, copy.deleteFailed)}
        </p>
      ) : null}
    </Dialog>
  );
}
