"use client";

import { CalendarDays, FilePlus2, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { Fragment, useId, useRef, useState, type FormEvent } from "react";
import useSWR, { useSWRConfig } from "swr";
import { useCopy, useLocale } from "@/components/i18n";
import { Badge, Button, Dialog, Input, Skeleton, Textarea, useToast } from "@/components/ui";
import { refreshNoteViews } from "@/features/notes/note-cache";
import { api } from "@/lib/api-client";
import { localizedApiError } from "@/lib/i18n/api-error";
import { textInEveryLocale } from "@/lib/i18n/copy";
import { localDateKey } from "@/lib/i18n/format-date";
import { TEMPLATE_BODY_MAX, TEMPLATE_NAME_MAX, TEMPLATE_VARIABLES, type NoteTemplate } from "@/lib/templates";
import { Section } from "./SettingsSection";
import { SETTINGS_COPY } from "./settings-copy";
import {
  draftFromTemplate, EMPTY_TEMPLATE_DRAFT, hasDraftErrors, templateCreateBody, templateErrorField, templatePatch,
  templatePreview, validateTemplateDraft, type TemplateDraft, type TemplateDraftErrors,
} from "./template-form";
import { createNoteFromTemplate, TEMPLATES_KEY } from "./template-note";

type Editing = { session: number; template: NoteTemplate | null };

export function TemplatesSection() {
  const copy = useCopy(SETTINGS_COPY).templates;
  const { locale } = useLocale();
  const router = useRouter();
  const { cache, mutate } = useSWRConfig();
  const { toast } = useToast();
  const { data, error, isLoading, mutate: reload } = useSWR<{ templates: NoteTemplate[] }>(TEMPLATES_KEY);
  const [editing, setEditing] = useState<Editing>({ session: 0, template: null });
  const [editorOpen, setEditorOpen] = useState(false);
  const [deleting, setDeleting] = useState<NoteTemplate | null>(null);
  const [creatingId, setCreatingId] = useState<string | null>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const openEditor = (template: NoteTemplate | null) => {
    setEditing((current) => ({ session: current.session + 1, template }));
    setEditorOpen(true);
  };

  const createFrom = async (template: NoteTemplate) => {
    setCreatingId(template.id);
    try {
      const { note, bodyError } = await createNoteFromTemplate(template.body, localDateKey());
      await refreshNoteViews({ cache, mutate });
      if (bodyError) toast(textInEveryLocale((each) => SETTINGS_COPY[each].templates.bodyFailed), { tone: "danger" });
      router.push(`/notes/${encodeURIComponent(note.id)}`);
    } catch (cause) {
      toast(textInEveryLocale((each) => localizedApiError(cause, each, SETTINGS_COPY[each].templates.createFailed)), { tone: "danger" });
    } finally {
      setCreatingId(null);
    }
  };

  const templates = data?.templates ?? [];

  return (
    <Section id="settings-templates" title={copy.title} description={copy.description}>
      <div className="surface-card">
        <div className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
          <p className="text-sm text-mute"><Placeholders text={copy.help} /></p>
          <Button ref={addRef} size="lg" className="self-start sm:self-auto" leading={<Plus aria-hidden className="size-4" />} onClick={() => openEditor(null)}>
            {copy.add}
          </Button>
        </div>
        <div className="border-t border-line">
          {isLoading && !data ? (
            <div aria-label={copy.loading} className="flex flex-col gap-2 px-4 py-4 sm:px-5">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-4 w-64 max-w-full" />
            </div>
          ) : error && !data ? (
            <div role="alert" className="flex flex-col items-start gap-2 px-4 py-4 sm:px-5">
              <p className="text-md font-medium text-danger">{copy.loadFailed}</p>
              <p className="text-sm text-mute">{localizedApiError(error, locale, copy.loadHint)}</p>
              <Button size="lg" leading={<RefreshCw aria-hidden className="size-4" />} onClick={() => void reload()}>
                {copy.reload}
              </Button>
            </div>
          ) : templates.length === 0 ? (
            <p className="px-4 py-4 text-sm text-mute sm:px-5">{copy.empty}</p>
          ) : (
            <ul aria-label={copy.listLabel} className="divide-y divide-line">
              {templates.map((template) => (
                <TemplateRow
                  key={template.id}
                  template={template}
                  creating={creatingId === template.id}
                  onCreate={() => void createFrom(template)}
                  onEdit={() => openEditor(template)}
                  onDelete={() => setDeleting(template)}
                />
              ))}
            </ul>
          )}
        </div>
      </div>

      <TemplateEditor
        key={editing.session}
        open={editorOpen}
        template={editing.template}
        onOpenChange={setEditorOpen}
        onSaved={() => {
          void reload();
          toast(textInEveryLocale((each) => SETTINGS_COPY[each].templates.saved), { tone: "ok" });
          setEditorOpen(false);
        }}
      />
      <DeleteTemplateDialog
        template={deleting}
        onClose={() => {
          setDeleting(null);
          // After a delete the opener row is gone, so the native focus restore has nothing to return to.
          if (document.activeElement === document.body) addRef.current?.focus();
        }}
        onDeleted={() => {
          void reload();
          toast(textInEveryLocale((each) => SETTINGS_COPY[each].templates.deleted), { tone: "ok" });
          setDeleting(null);
        }}
      />
    </Section>
  );
}

const PLACEHOLDER_SPLIT = new RegExp(`(\\{\\{(?:${TEMPLATE_VARIABLES.join("|")})\\}\\})`);

function Placeholders({ text }: { text: string }) {
  return text.split(PLACEHOLDER_SPLIT).map((part, index) =>
    index % 2 === 1 ? (
      <code key={index} className="rounded-sm bg-line/60 px-1 text-xs text-ink">{part}</code>
    ) : (
      <Fragment key={index}>{part}</Fragment>
    ),
  );
}

function TemplateRow({ template, creating, onCreate, onEdit, onDelete }: {
  template: NoteTemplate;
  creating: boolean;
  onCreate: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const copy = useCopy(SETTINGS_COPY).templates;
  const nameId = useId();
  const preview = templatePreview(template.body);
  return (
    <li className="flex flex-col gap-3 px-4 py-4 sm:px-5">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <h4 id={nameId} className="min-w-0 text-md font-medium">{template.name}</h4>
          {template.isDailyDefault ? (
            <Badge tone="accent"><CalendarDays aria-hidden className="size-3.5" />{copy.dailyBadge}</Badge>
          ) : null}
        </div>
        <p className="mt-0.5 truncate text-sm text-mute">{preview || copy.emptyBody}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button className="max-lg:h-11" aria-describedby={nameId} loading={creating} leading={<FilePlus2 aria-hidden className="size-4" />} onClick={onCreate}>
          {copy.create}
        </Button>
        <Button className="max-lg:size-11" variant="ghost" iconOnly aria-label={copy.edit} title={copy.edit} aria-describedby={nameId} onClick={onEdit}>
          <Pencil aria-hidden className="size-4" />
        </Button>
        <Button className="max-lg:size-11" variant="ghost" iconOnly aria-label={copy.remove} title={copy.remove} aria-describedby={nameId} onClick={onDelete}>
          <Trash2 aria-hidden className="size-4" />
        </Button>
      </div>
    </li>
  );
}

type SaveError = { field: "name" | "form"; cause: unknown };

/** Remounted (keyed) for every open, so a draft never leaks from one template into the next. */
function TemplateEditor({ open, template, onOpenChange, onSaved }: {
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

function DeleteTemplateDialog({ template, onClose, onDeleted }: {
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
