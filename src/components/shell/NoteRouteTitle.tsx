"use client";

import useSWR from "swr";
import { useCopy, useLocale } from "@/components/i18n";
import { DocumentTitle } from "@/components/i18n/DocumentTitle";
import { displayNoteTitle } from "@/features/notes/display-title";
import type { Note } from "@/lib/types";
import { SHELL_COPY } from "./copy";

/** Shares the detail cache; title presentation does not own note editing state. */
export function NoteRouteTitle({ noteId }: { noteId?: string }) {
  const { locale } = useLocale();
  const copy = useCopy(SHELL_COPY);
  const { data } = useSWR<{ note: Note }>(noteId ? `/api/notes/${noteId}` : null, {
    revalidateIfStale: false,
    revalidateOnFocus: false,
  });
  return <DocumentTitle title={data?.note ? displayNoteTitle(data.note, locale) : copy.nav.notes} />;
}
