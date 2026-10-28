"use client";

import { FilePlus2, Pin, RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import useSWR from "swr";
import { useCopy, useLocale } from "@/components/i18n";
import { useShell } from "@/components/shell/ShellProvider";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { useToast } from "@/components/ui/Toast";
import { api } from "@/lib/api-client";
import { localizedApiError } from "@/lib/i18n/api-error";
import { textInEveryLocale } from "@/lib/i18n/copy";
import type { HomeData, NoteRef } from "@/lib/types";
import { DocumentTitle } from "@/components/i18n/DocumentTitle";
import { Counts, FirstRunPanel, HomeSkeleton, InboxSection, PinnedSection, RecentSection, ResurfaceSection } from "./HomeSections";
import { TodaySection } from "./HomeToday";
import { HOME_COPY } from "./home-copy";
import { dailyForDate, homeHeadline, recentWithoutPinned } from "./home-model";
import { formatDateKey, useLocalDate } from "./use-local-date";

type HomeSnapshot = { home: HomeData; fetchedAt: number };

/** Relative times are measured from the moment the snapshot arrived, so render stays pure. */
const fetchHome = async (path: string): Promise<HomeSnapshot> => ({ home: await api<HomeData>(path), fetchedAt: Date.now() });

export const HOME_KEY = "/api/home";

/** Live home: what needs triage, today's note, what you touched last, and what to revisit. */
export function HomeDashboard() {
  const router = useRouter();
  const shell = useShell();
  const { toast } = useToast();
  const { locale } = useLocale();
  const copy = useCopy(HOME_COPY);
  const today = useLocalDate();
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const { data, error, isLoading, mutate } = useSWR<HomeSnapshot>(`${HOME_KEY}?timeZone=${encodeURIComponent(timeZone)}`, fetchHome, { revalidateOnFocus: true });
  const [busy, setBusy] = useState<"note" | "daily" | null>(null);

  // Capture/triage elsewhere refreshes the shell's inbox count; follow it so both numbers agree.
  const { inboxCount } = shell;
  useEffect(() => {
    if (inboxCount !== null) void mutate();
  }, [inboxCount, mutate]);

  const open = async (kind: "note" | "daily") => {
    if (kind === "daily" && !today) return;
    setBusy(kind);
    try {
      const { note } =
        kind === "note"
          ? await api<{ note: NoteRef }>("/api/notes", { method: "POST", json: {} })
          : await api<{ note: NoteRef }>("/api/daily", { method: "POST", json: { date: today } });
      router.push(`/notes/${note.id}`);
    } catch (cause) {
      toast(textInEveryLocale((locale) => localizedApiError(cause, locale, HOME_COPY[locale].createFailed)), { tone: "danger" });
      setBusy(null);
    }
  };

  const home = data?.home;
  const daily = home && today ? dailyForDate(home, today) : null;
  const headline = home ? homeHeadline(home, daily !== null) : null;
  const firstRun = home ? home.stats.notes === 0 && home.inboxCount === 0 : false;

  return (
    <div className="mx-auto w-full max-w-6xl px-4 pb-12 pt-5 sm:px-6 lg:px-10 lg:pt-10">
      <DocumentTitle title={copy.title} />
      <header className="flex flex-col gap-4 border-b border-line pb-6 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0">
          {home && headline ? (
            <h1 className="text-2xl font-semibold tracking-tight text-balance lg:text-3xl">
              {headline === "inbox" ? copy.headline.inbox(home.inboxCount) : copy.headline[headline]}
            </h1>
          ) : (
            <h1 className="text-2xl font-semibold tracking-tight lg:text-3xl">{copy.title}</h1>
          )}
          <p className="mt-1 min-h-5 text-sm text-mute">{today ? formatDateKey(today, locale) : null}</p>
          {home ? <Counts stats={home.stats} /> : <p className="mt-2 min-h-5" />}
        </div>
        {!firstRun ? <div className="flex flex-wrap gap-2">
          <Button
            size="lg"
            leading={<FilePlus2 aria-hidden className="size-4" />}
            loading={busy === "note"}
            disabled={busy !== null}
            onClick={() => void open("note")}
          >
            {copy.newNote}
          </Button>
        </div> : null}
      </header>

      {error && !home ? (
        <div role="alert" className="mt-6 flex flex-col items-start gap-3 rounded-card border border-danger/30 bg-danger-soft px-5 py-4">
          <div>
            <p className="text-md font-medium text-danger">{copy.loadError.title}</p>
            <p className="mt-0.5 text-sm text-ink">{localizedApiError(error, locale, copy.loadError.help)}</p>
          </div>
          <Button size="lg" leading={<RefreshCw aria-hidden className="size-4" />} onClick={() => void mutate()}>
            {copy.loadError.retry}
          </Button>
        </div>
      ) : null}

      {isLoading && !home ? <HomeSkeleton /> : null}

      {home && data && firstRun ? (
        <FirstRunPanel busy={busy} onCapture={shell.openCapture} onCreate={() => void open("note")} />
      ) : null}

      {home && data && !firstRun ? (
        <div className="mt-6 grid gap-8 lg:grid-cols-[minmax(0,1.65fr)_minmax(0,1fr)] lg:gap-10">
          <div className="flex min-w-0 flex-col gap-8">
            <TodaySection
              today={today}
              daily={daily}
              busy={busy === "daily"}
              disabled={busy !== null || !today}
              onCreate={() => void open("daily")}
            />
            {home.inboxCount > 0 ? <InboxSection count={home.inboxCount} items={home.inboxPreview} now={data.fetchedAt} /> : null}
            <RecentSection notes={recentWithoutPinned(home)} hasAnyNote={home.stats.notes > 0} now={data.fetchedAt} onCreate={() => void open("note")} busy={busy !== null} />
          </div>
          <aside aria-label={copy.asideLabel} className="flex min-w-0 flex-col gap-8">
            {home.pinned.length > 0 ? <PinnedSection notes={home.pinned} now={data.fetchedAt} /> : null}
            {home.resurface.length > 0 ? <ResurfaceSection notes={home.resurface} now={data.fetchedAt} /> : null}
            {home.pinned.length === 0 && home.resurface.length === 0 ? (
              <EmptyState variant="plain" icon={Pin} title={copy.folded.title} description={copy.folded.description} />
            ) : null}
          </aside>
        </div>
      ) : null}
    </div>
  );
}
