"use client";

import { CalendarDays, FilePlus2, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import useSWR, { useSWRConfig } from "swr";
import { useCopy, useLocale } from "@/components/i18n";
import { Badge, Button, Skeleton, useToast } from "@/components/ui";
import { refreshNoteViews } from "@/features/notes/note-cache";
import { localizedApiError } from "@/lib/i18n/api-error";
import { textInEveryLocale } from "@/lib/i18n/copy";
import { localDateKey } from "@/lib/i18n/format-date";
import { type NoteTemplate } from "@/lib/templates";
import { Section } from "./SettingsSection";
import { SETTINGS_COPY } from "./settings-copy";
import { templatePreview } from "./template-form";
import { TemplateEditor, DeleteTemplateDialog, Placeholders } from "./TemplateDialogs";
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
  const removedTemplateId = useRef<string | null>(null);
  useEffect(() => {
    const id = removedTemplateId.current;
    if (!id || !data || data.templates.some(template => template.id === id)) return;
    removedTemplateId.current = null;
    // Revalidation can remove the opener after native dialog focus restoration.
    if (document.activeElement === document.body) addRef.current?.focus();
  }, [data]);
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
        onDeleted={(id) => {
          removedTemplateId.current = id;
          void reload();
          toast(textInEveryLocale((each) => SETTINGS_COPY[each].templates.deleted), { tone: "ok" });
          setDeleting(null);
        }}
      />
    </Section>
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
