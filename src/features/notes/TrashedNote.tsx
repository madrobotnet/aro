import { History, RotateCcw, Trash2 } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { useCopy, useLocale } from "@/components/i18n";
import { DocumentTitle } from "@/components/i18n/DocumentTitle";
import { Button } from "@/components/ui";
import { formatDate } from "@/lib/i18n/format-date";
import type { Note } from "@/lib/types";
import { NOTES_COPY } from "./copy";
import { displayNoteTitle } from "./display-title";

export function TrashedNote({ note, busy, onRestore, onHistory, onPurge, children }: {
  readonly note: Note;
  readonly busy: boolean;
  readonly onRestore: () => Promise<void>;
  readonly onHistory: () => void;
  readonly onPurge: () => void;
  readonly children: ReactNode;
}) {
  const copy = useCopy(NOTES_COPY);
  const { locale } = useLocale();
  const purgeDate = note.purgeAt ? formatDate(note.purgeAt, locale) : "";
  return (
    <section className="min-w-0 flex-1 overflow-y-auto p-4 pb-24 sm:p-6 lg:pb-6">
      <DocumentTitle title={displayNoteTitle(note, locale)} />
      <div className="mx-auto max-w-3xl">
        <Link href="/notes?view=trash" className="inline-flex min-h-touch items-center text-sm text-accent sm:min-h-0">{copy.detail.backToTrash}</Link>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight">{displayNoteTitle(note, locale)}</h1>
        <div className="mt-4 rounded-card border border-line bg-warn-soft px-4 py-3">
          <div className="flex items-start gap-3">
            <Trash2 aria-hidden className="mt-0.5 size-5 shrink-0 text-warn" />
            <div className="min-w-0">
              <p className="font-medium text-ink">{copy.detail.trashedTitle}</p>
              <p className="mt-0.5 text-sm text-ink">{purgeDate ? <>{copy.detail.purgeOn(purgeDate)} </> : null}{copy.detail.trashedDescription}</p>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap gap-2 sm:pl-8">
            <Button variant="primary" className="min-h-touch sm:min-h-0" loading={busy} leading={<RotateCcw aria-hidden className="size-4" />} onClick={() => void onRestore()}>{copy.detail.restore}</Button>
            <Button className="min-h-touch sm:min-h-0" disabled={busy} leading={<History aria-hidden className="size-4" />} onClick={onHistory}>{copy.history.open}</Button>
            <Button variant="danger" className="min-h-touch sm:min-h-0" disabled={busy} onClick={onPurge}>{copy.detail.purge}</Button>
          </div>
        </div>
      </div>
      {children}
    </section>
  );
}
