"use client";

import { CalendarDays } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState, useSyncExternalStore } from "react";
import { useSWRConfig } from "swr";
import { useCopy, useLocale } from "@/components/i18n";
import { Button, EmptyState, Input } from "@/components/ui";
import { api } from "@/lib/api-client";
import { localizedApiError } from "@/lib/i18n/api-error";
import { localDateKey } from "@/lib/i18n/format-date";
import type { NoteRef } from "@/lib/types";
import { NOTES_COPY } from "./copy";
import { DAILY_COPY } from "./daily-copy";
import type { DailyTarget } from "./daily-date";
import { refreshNoteViews } from "./note-cache";

const noSubscription = () => () => {};

/** Opens (get-or-create) the daily note for `target`: today by default, or a `/daily?date=` day. */
export function DailyLauncher({ target = { kind: "today" } }: { target?: DailyTarget }) {
  const router = useRouter();
  const { cache, mutate } = useSWRConfig();
  const copy = useCopy(NOTES_COPY).daily;
  const invalidCopy = useCopy(DAILY_COPY).launcher.invalidDate;
  const requested = target.kind === "date" ? target.date : null;
  const invalid = target.kind === "invalid";
  const { locale } = useLocale();
  // The browser's date, never the server's: the picker renders on the server for an invalid date.
  const today = useSyncExternalStore(noSubscription, () => localDateKey(), () => null);
  const [picked, setPicked] = useState<string | null>(requested);
  const date = picked ?? today ?? "";
  const [busy, setBusy] = useState(!invalid);
  // The failure itself, not its text, so a language switch re-renders the message.
  const [failure, setFailure] = useState<{ error: unknown } | null>(null);

  const open = async (selected: string) => {
    setBusy(true);
    setFailure(null);
    try {
      const { note } = await api<{ note: NoteRef }>("/api/daily", { method: "POST", json: { date: selected } });
      // get-or-create may have added a note: lists, home and calendar dots must see it.
      void refreshNoteViews({ cache, mutate });
      router.replace(`/notes/${note.id}`);
    } catch (reason) {
      setFailure({ error: reason });
      setBusy(false);
    }
  };

  useEffect(() => {
    if (invalid) return;
    let active = true;
    void api<{ note: NoteRef }>("/api/daily", { method: "POST", json: { date: requested ?? localDateKey() } })
      .then(({ note }) => {
        if (!active) return;
        void refreshNoteViews({ cache, mutate });
        router.replace(`/notes/${note.id}`);
      })
      .catch((reason: unknown) => {
        if (!active) return;
        setFailure({ error: reason });
        setBusy(false);
      });
    return () => { active = false; };
  }, [router, requested, invalid, cache, mutate]);

  return (
    <section aria-label={copy.label} className="flex min-h-[70dvh] items-center justify-center p-5">
      <div className="w-full max-w-md">
        <EmptyState
          icon={CalendarDays}
          title={busy ? copy.opening : copy.openFailed}
          description={failure ? localizedApiError(failure.error, locale, copy.openFailedDetail) : invalid ? invalidCopy : copy.preparing}
          action={!busy ? <div className="flex w-full flex-col gap-2 sm:flex-row sm:items-end"><Input label={copy.date} type="date" value={date} onChange={(event) => setPicked(event.target.value)} /><Button variant="primary" disabled={!date} onClick={() => void open(date)}>{copy.open}</Button></div> : undefined}
        />
      </div>
    </section>
  );
}
