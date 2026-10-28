"use client";

import { AlarmClock, AlertTriangle, ArrowUpRight, Check, ExternalLink, Lightbulb, Merge, Sparkles, Trash2 } from "lucide-react";
import Link from "next/link";
import { useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";
import { useCopy, useLocale } from "@/components/i18n";
import { Badge, Button, buttonClassName, Input, Kbd, TagBadge, Textarea } from "@/components/ui";
import type { InboxItem } from "@/lib/types";
import { INBOX_COPY } from "./inbox-copy";
import { formatCreated, kindLabel, mergeTags, percent, suggestionView, urlStatus } from "./inbox-triage";
import type { TriageDraft } from "./triage-drafts";

type EditorProps = {
  item: InboxItem;
  draft: TriageDraft;
  onDraftChange: (update: (current: TriageDraft) => TriageDraft) => void;
  titleRef: RefObject<HTMLInputElement | null>;
  busy: "promote" | "suggest" | null;
  onPromote: (item: InboxItem, draft: { title: string; body: string; tags: string[] }) => Promise<void>;
  onDiscard: () => void;
  onSnooze: () => void;
  /** `edited` reports whether the draft differs from the capture, which merging does not carry over. */
  onMerge: (edited: boolean) => void;
  onSuggest: (item: InboxItem) => Promise<void>;
};

/** Secondary actions share a three-column row on phones, so they tighten their padding there. */
const SECONDARY_ACTION = "max-sm:gap-1.5 max-sm:px-2";

export function TriageEditor({ item, draft, onDraftChange, titleRef, busy, onPromote, onDiscard, onSnooze, onMerge, onSuggest }: EditorProps) {
  const { locale } = useLocale();
  const copy = useCopy(INBOX_COPY);
  const { edit, manualTags, selectedTags } = draft;
  const [submitted, setSubmitted] = useState(false);
  const suggestions = suggestionView(item.suggestions);
  const status = urlStatus(item.body);
  const tags = mergeTags(manualTags, selectedTags);
  const edited = edit.titleDirty || edit.bodyDirty;

  const toggleTag = (tag: string) => {
    onDraftChange((current) => {
      const next = new Set(current.selectedTags);
      if (next.has(tag)) next.delete(tag);
      else next.add(tag);
      return { ...current, selectedTags: next };
    });
  };

  const onFormKeyDown = (event: ReactKeyboardEvent<HTMLFormElement>) => {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      event.currentTarget.requestSubmit();
    }
  };

  return (
    <form
      noValidate
      className="surface-card min-w-0 p-4 sm:p-5"
      onKeyDown={onFormKeyDown}
      onSubmit={(event) => {
        event.preventDefault();
        setSubmitted(true);
        const title = edit.title.trim();
        if (!title) {
          titleRef.current?.focus();
          return;
        }
        void onPromote(item, { title, body: edit.body, tags });
      }}
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-line pb-4">
        <Badge>{copy.source[item.source]}</Badge>
        <span className="text-xs text-mute">{formatCreated(item.createdAt, locale)}</span>
        {item.url ? (
          <a href={item.url} target="_blank" rel="noreferrer" className="ml-auto inline-flex min-h-touch items-center gap-1 text-sm font-medium text-accent hover:underline">
            {copy.editor.openSource} <ExternalLink aria-hidden className="size-3.5" />
          </a>
        ) : null}
      </div>

      <div className="mt-4 flex flex-col gap-4">
        <Input
          ref={titleRef}
          label={copy.editor.titleLabel}
          value={edit.title}
          error={submitted && !edit.title.trim() ? copy.editor.titleRequired : undefined}
          onChange={(event) => onDraftChange((current) => ({ ...current, edit: { ...current.edit, title: event.target.value, titleDirty: true } }))}
          disabled={busy !== null}
          required
        />
        <Textarea
          label={copy.editor.bodyLabel}
          rows={11}
          value={edit.body}
          onChange={(event) => onDraftChange((current) => ({ ...current, edit: { ...current.edit, body: event.target.value, bodyDirty: true } }))}
          disabled={busy !== null}
          className="min-h-52"
        />
        {status ? (
          <div className={`flex items-start gap-2 rounded-ctl border px-3 py-2 text-sm ${status === "pending" ? "border-warn/30 bg-warn-soft text-warn" : "border-danger/30 bg-danger-soft text-danger"}`}>
            <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />
            {status === "pending" ? copy.editor.urlPending : copy.editor.urlFailed}
          </div>
        ) : null}

        <section aria-labelledby={`suggestions-${item.id}`} className="border-t border-line pt-4">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <h2 id={`suggestions-${item.id}`} className="flex items-center gap-2 text-sm font-semibold">
                <Sparkles aria-hidden className="size-4 text-accent" /> {copy.suggestions.title}
              </h2>
              <p className="mt-1 text-xs text-mute">{copy.suggestions.hint}</p>
            </div>
            {suggestions.kind === "unavailable" ? (
              <Link href="/settings" className={buttonClassName({ size: "sm" })}>
                {copy.suggestions.openSettings}
              </Link>
            ) : suggestions.kind !== "ready" ? (
              <Button size="sm" loading={busy === "suggest"} disabled={busy !== null} onClick={() => void onSuggest(item)}>
                {copy.suggestions.recheck}
              </Button>
            ) : null}
          </div>
          {suggestions.kind === "pending" ? <p className="mt-3 text-sm text-mute">{copy.suggestions.pending}</p> : null}
          {suggestions.kind === "unavailable" ? <p className="mt-3 text-sm text-mute">{copy.suggestions.unavailable}</p> : null}
          {suggestions.kind === "failed" ? <p className="mt-3 text-sm text-danger">{copy.suggestions.failed}</p> : null}
          {suggestions.kind === "ready" ? (
            <div className="mt-3 flex flex-col gap-3">
              {suggestions.suggestions.tags.length ? (
                <div className="flex flex-wrap gap-2">
                  {suggestions.suggestions.tags.map(({ tag, probability }) => {
                    const checked = selectedTags.has(tag);
                    return (
                      <button
                        key={tag}
                        type="button"
                        aria-pressed={checked}
                        onClick={() => toggleTag(tag)}
                        className={`control-target inline-flex min-h-touch items-center gap-1.5 rounded-ctl border px-2.5 text-sm focus-ring lg:min-h-9 ${checked ? "border-line-strong bg-canvas font-medium text-ink" : "border-line bg-card text-ink"}`}
                      >
                        {checked ? <Check aria-hidden className="size-3.5" /> : null}#{tag} <span className="text-xs text-mute">{percent(probability)}</span>
                      </button>
                    );
                  })}
                </div>
              ) : <p className="text-sm text-mute">{copy.suggestions.noTags}</p>}
              {suggestions.suggestions.kind ? (
                <p className="flex items-center gap-2 text-sm"><Lightbulb aria-hidden className="size-4 text-mute" />{copy.suggestions.kind} <strong>{kindLabel(suggestions.suggestions.kind.choice, copy.kind)}</strong> <span className="text-mute">{percent(suggestions.suggestions.kind.confidence)}</span></p>
              ) : null}
              {suggestions.suggestions.duplicateOf ? (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                  <p className="text-sm text-warn">
                    {copy.suggestions.duplicate} <Link className="font-medium underline" href={`/notes/${suggestions.suggestions.duplicateOf.noteId}`}>{suggestions.suggestions.duplicateOf.title}</Link> ({percent(suggestions.suggestions.duplicateOf.probability)})
                  </p>
                  <Button size="sm" className="max-lg:min-h-touch" disabled={busy !== null} leading={<Merge aria-hidden className="size-4" />} onClick={() => onMerge(edited)}>
                    {copy.editor.mergeSuggested}
                  </Button>
                </div>
              ) : null}
            </div>
          ) : null}
        </section>

        <Input label={copy.editor.tagsLabel} value={manualTags} onChange={(event) => onDraftChange((current) => ({ ...current, manualTags: event.target.value }))} placeholder={copy.editor.tagsPlaceholder} disabled={busy !== null} />
        {tags.length ? <div className="flex flex-wrap gap-1.5" aria-label={copy.editor.appliedTags}>{tags.map((tag) => <TagBadge key={tag} tag={tag} />)}</div> : null}
      </div>

      <div className="mt-5 flex flex-col-reverse gap-2 border-t border-line pt-4 sm:flex-row sm:flex-wrap sm:items-center">
        <div className="grid grid-cols-3 gap-2 sm:flex sm:flex-wrap">
          <Button
            data-discard={item.id}
            type="button"
            variant="danger"
            size="lg"
            className={SECONDARY_ACTION}
            aria-keyshortcuts="2 D"
            leading={<Trash2 aria-hidden className="size-4" />}
            trailing={<Kbd aria-hidden className="ml-1 max-lg:hidden">2</Kbd>}
            disabled={busy !== null}
            onClick={onDiscard}
          >
            {copy.editor.discard}
          </Button>
          <Button
            data-snooze={item.id}
            type="button"
            size="lg"
            className={SECONDARY_ACTION}
            aria-keyshortcuts="H"
            aria-haspopup="dialog"
            leading={<AlarmClock aria-hidden className="size-4" />}
            trailing={<Kbd aria-hidden className="ml-1 max-lg:hidden">H</Kbd>}
            disabled={busy !== null}
            onClick={onSnooze}
          >
            {copy.editor.snooze}
          </Button>
          <Button
            data-merge={item.id}
            type="button"
            size="lg"
            className={SECONDARY_ACTION}
            aria-keyshortcuts="3"
            aria-haspopup="dialog"
            leading={<Merge aria-hidden className="size-4" />}
            trailing={<Kbd aria-hidden className="ml-1 max-lg:hidden">3</Kbd>}
            disabled={busy !== null}
            onClick={() => onMerge(edited)}
          >
            {copy.editor.merge}
          </Button>
        </div>
        <Button
          data-promote={item.id}
          type="submit"
          variant="primary"
          size="lg"
          className="sm:ml-auto"
          aria-keyshortcuts="1 P"
          loading={busy === "promote"}
          disabled={busy !== null}
          leading={<ArrowUpRight aria-hidden className="size-4" />}
          trailing={<Kbd variant="onAccent" aria-hidden className="ml-1 max-lg:hidden">1</Kbd>}
        >
          {copy.editor.promote}
        </Button>
      </div>
    </form>
  );
}
