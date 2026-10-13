"use client";

import { Plus, X } from "lucide-react";
import { useRef, useState } from "react";
import { useCopy } from "@/components/i18n";
import { Input, TagBadge } from "@/components/ui";
import { addTags, removeTag } from "./comma-items";
import { EDITOR_HEADER_COPY } from "./editor-header-copy";
import { NOTES_COPY } from "./copy";

export function TagEditor({ tags, onCommit }: { readonly tags: readonly string[]; readonly onCommit: (tags: string[]) => void }) {
  const copy = useCopy(EDITOR_HEADER_COPY);
  const notes = useCopy(NOTES_COPY);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const composing = useRef(false);
  const commit = () => {
    if (!value.trim()) return;
    onCommit(addTags(tags, value));
    setValue("");
  };
  return <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2" aria-label={notes.detail.tags}>
    {tags.map((tag, index) => editing ? <TagBadge key={`${tag}-${index}`} tag={tag} className="min-w-0 max-w-full gap-1 break-words">
      <button type="button" aria-label={copy.removeTag(tag)} title={copy.removeTag(tag)} className="note-tag-hit inline-flex shrink-0 items-center justify-center rounded-ctl text-mute hover:text-ink" onClick={() => onCommit(removeTag(tags, index))}><X aria-hidden className="size-3" /></button>
    </TagBadge> : <button key={`${tag}-${index}`} type="button" className="note-tag-hit inline-flex max-w-full rounded-ctl" onClick={() => setEditing(true)}><TagBadge tag={tag} className="max-w-full break-words" /></button>)}
    <button type="button" className="note-tag-hit inline-flex items-center gap-1 whitespace-nowrap rounded-ctl border border-dashed border-line bg-card px-1.5 py-0.5 text-xs leading-4 text-mute hover:bg-desk"
      onClick={() => { setEditing(true); input.current?.focus(); }}><Plus aria-hidden className="size-3" />{copy.addTag}</button>
    {editing ? <Input ref={input} autoFocus label={notes.detail.tags} wrapperClassName="w-full sm:w-auto" value={value} placeholder={notes.detail.tagsPlaceholder}
      onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
      onChange={(event) => {
        const next = event.target.value;
        if (next.includes(",") && !composing.current) {
          const at = next.lastIndexOf(",");
          onCommit(addTags(tags, next.slice(0, at)));
          setValue(next.slice(at + 1));
        } else setValue(next);
      }}
      onBlur={commit} onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Enter" || event.key === ",") { event.preventDefault(); commit(); }
        if (event.key === "Backspace" && !value) onCommit(removeTag(tags, tags.length - 1));
        if (event.key === "Escape") { commit(); setEditing(false); }
      }} /> : null}
  </div>;
}
