"use client";

import { CalendarDays, FilePlus2, History, Inbox, Pin, RefreshCw, Zap } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import useSWR from "swr";
import { useCopy, useLocale } from "@/components/i18n";
import { useShell } from "@/components/shell/ShellProvider";
import { Badge, TagBadge } from "@/components/ui/Badge";
import { Button, buttonClassName } from "@/components/ui/Button";
import { cn } from "@/components/ui/cn";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton, SkeletonLines } from "@/components/ui/Skeleton";
import { useToast } from "@/components/ui/Toast";
import { api } from "@/lib/api-client";
import { localizedApiError } from "@/lib/i18n/api-error";
import { textInEveryLocale } from "@/lib/i18n/copy";
import { inboxUrlStatus, stripInboxUrlStatus } from "@/lib/inbox-url-status";
import { inboxPreview } from "@/lib/inbox-preview";
import type { HomeData, InboxItem, NoteRef, NoteSummary } from "@/lib/types";
import { INBOX_COPY } from "@/features/inbox/inbox-copy";
import { HOME_COPY } from "./home-copy";
import { dailyForDate, homeHeadline, recentWithoutPinned, relativeTime, splitCountPhrase } from "./home-model";
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
      <header className="flex flex-col gap-4 border-b border-line pb-6 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0">
          <p className="min-h-5 text-sm text-mute">{today ? formatDateKey(today, locale) : null}</p>
          {home && headline ? (
            <h1 className="mt-1 text-2xl font-semibold tracking-tight text-balance lg:text-3xl">
              {headline === "inbox" ? copy.headline.inbox(home.inboxCount) : copy.headline[headline]}
            </h1>
          ) : (
            <h1 className="mt-1 text-2xl font-semibold tracking-tight lg:text-3xl">{copy.title}</h1>
          )}
          {home ? <Counts stats={home.stats} /> : <p className="mt-2 min-h-5" />}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            size="lg"
            leading={<FilePlus2 aria-hidden className="size-4" />}
            loading={busy === "note"}
            disabled={busy !== null}
            onClick={() => void open("note")}
          >
            {copy.newNote}
          </Button>
        </div>
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

function Counts({ stats }: { stats: HomeData["stats"] }) {
  const { counts } = useCopy(HOME_COPY);
  const link = "rounded-ctl underline decoration-line-strong underline-offset-4 hover:text-accent hover:decoration-accent focus-ring";
  return (
    <p className="mt-2 text-sm text-mute">
      <Link href="/notes" className={link}>
        <CountPhrase phrase={counts.notes} count={stats.notes} />
      </Link>
      {", "}
      <Link href="/graph" className={link}>
        <CountPhrase phrase={counts.links} count={stats.links} />
      </Link>
      {", "}
      <CountPhrase phrase={counts.tags} count={stats.tags} />
    </p>
  );
}

/** A translated count phrase with the number styled wherever that language puts it. */
function CountPhrase({ phrase, count }: { phrase: (count: number, value: string) => string; count: number }) {
  const [before, after] = splitCountPhrase(phrase, count);
  return (
    <>
      {before}
      <span className="font-medium tabular-nums text-ink">{count}</span>
      {after}
    </>
  );
}

function SectionHeading({ id, icon: Icon, title, count, action }: { id: string; icon: typeof Inbox; title: string; count?: number; action?: ReactNode }) {
  return (
    <div className="mb-2 flex min-h-touch items-center gap-2 lg:min-h-9">
      <Icon aria-hidden className="size-4 text-mute" />
      <h2 id={id} className="text-lg font-semibold tracking-tight">
        {title}
      </h2>
      {count !== undefined && count > 0 ? <Badge tone="accent" count={count} /> : null}
      <div className="ml-auto">{action}</div>
    </div>
  );
}

const SECTION_LINK = cn(buttonClassName({ variant: "ghost", size: "sm" }), "h-touch text-mute hover:text-ink lg:h-8");

/** First run (no notes, nothing captured): one panel with both ways to start, instead of five empty sections. */
function FirstRunPanel({ busy, onCapture, onCreate }: { busy: "note" | "daily" | null; onCapture: () => void; onCreate: () => void }) {
  const copy = useCopy(HOME_COPY);
  return (
    <EmptyState
      className="mt-6"
      title={copy.firstRun.title}
      description={copy.firstRun.description}
      action={
        <>
          <Button variant="primary" size="lg" leading={<Zap aria-hidden className="size-4" />} onClick={onCapture}>
            {copy.capture}
          </Button>
          <Button size="lg" leading={<FilePlus2 aria-hidden className="size-4" />} loading={busy === "note"} disabled={busy !== null} onClick={onCreate}>
            {copy.newNote}
          </Button>
        </>
      }
    />
  );
}

function InboxSection({ count, items, now }: { count: number; items: InboxItem[]; now: number }) {
  const { locale } = useLocale();
  const copy = useCopy(HOME_COPY).inbox;
  const { source: sources, editor: urlCopy } = useCopy(INBOX_COPY);
  return (
    <section aria-labelledby="home-inbox">
      <SectionHeading
        id="home-inbox"
        icon={Inbox}
        title={copy.title}
        count={count}
        action={
          count > 0 ? (
            <Link href="/inbox" className={SECTION_LINK}>
              {count > items.length ? copy.reviewAll(count) : copy.review}
            </Link>
          ) : null
        }
      />
      {items.length > 0 ? (
        <ul className="surface-card divide-y divide-line overflow-hidden">
          {items.map((item) => {
            const status = inboxUrlStatus(item.body);
            const preview = inboxPreview(item, 280)
              || (!stripInboxUrlStatus(item.body) ? (status === "pending" ? urlCopy.urlPending : status === "failed" ? urlCopy.urlFailed : "") : "");
            return (
            <li key={item.id}>
              <Link href="/inbox" className="flex min-h-touch flex-col gap-1 px-4 py-3 hover:bg-desk focus-ring sm:px-5">
                <span className="truncate text-md font-medium">{item.title || copy.untitled}</span>
                {preview ? <span className="line-clamp-2 text-sm text-mute">{preview}</span> : null}
                <span className="text-xs text-mute">
                  {sources[item.source]}, {relativeTime(item.createdAt, now, locale)}
                </span>
              </Link>
            </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}

function TodaySection({
  today,
  daily,
  busy,
  disabled,
  onCreate,
}: {
  today: string | null;
  daily: NoteSummary | null;
  busy: boolean;
  disabled: boolean;
  onCreate: () => void;
}) {
  const { locale } = useLocale();
  const copy = useCopy(HOME_COPY).today;
  return (
    <section aria-labelledby="home-today" className="rounded-card border border-line bg-accent-soft/60 px-4 py-4 sm:px-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="min-w-0 flex-1">
          <h2 id="home-today" className="flex items-center gap-2 text-sm font-medium text-mute">
            <CalendarDays aria-hidden className="size-4" />
            {copy.title}
            {today ? <span className="text-ink">{formatDateKey(today, locale, { weekday: false })}</span> : null}
          </h2>
          {daily && daily.title === daily.dailyDate ? (
            // The default daily title is the date the heading already shows, so lead with the excerpt.
            <p className="mt-1 line-clamp-2 text-md text-ink">{daily.excerpt || copy.emptyExcerpt}</p>
          ) : daily ? (
            <>
              <p className="mt-1 truncate text-lg font-semibold tracking-tight">{daily.title}</p>
              <p className="mt-0.5 line-clamp-2 text-sm text-mute">{daily.excerpt || copy.emptyExcerpt}</p>
            </>
          ) : (
            <p className="mt-1 text-md text-ink">{copy.prompt}</p>
          )}
        </div>
        {daily ? (
          <Link href={`/notes/${daily.id}`} className={buttonClassName({ variant: "primary", size: "lg" })}>
            {copy.continue}
          </Link>
        ) : (
          <Button variant="primary" size="lg" loading={busy} disabled={disabled} onClick={onCreate}>
            {copy.create}
          </Button>
        )}
      </div>
    </section>
  );
}

function NoteRow({ note, now, clamp = 1 }: { note: NoteSummary; now: number; clamp?: 1 | 2 }) {
  const { locale } = useLocale();
  const copy = useCopy(HOME_COPY);
  return (
    <Link href={`/notes/${note.id}`} className="-mx-2 flex min-h-touch flex-col gap-1 rounded-ctl px-2 py-2.5 hover:bg-desk focus-ring">
      <span className="flex items-baseline gap-3">
        <span className="min-w-0 flex-1 truncate text-md font-medium">{note.title}</span>
        <span className="shrink-0 text-xs tabular-nums text-mute">{relativeTime(note.updatedAt, now, locale)}</span>
      </span>
      {note.excerpt ? <span className={cn("text-sm text-mute", clamp === 1 ? "line-clamp-1" : "line-clamp-2")}>{note.excerpt}</span> : null}
      {note.tags.length > 0 ? (
        <span className="flex flex-wrap gap-1 pt-0.5">
          {note.tags.slice(0, 3).map((tag) => (
            <TagBadge key={tag} tag={tag} />
          ))}
          {note.tags.length > 3 ? <span className="self-center text-xs text-mute">{copy.moreTags(note.tags.length - 3)}</span> : null}
        </span>
      ) : null}
    </Link>
  );
}

function RecentSection({
  notes,
  hasAnyNote,
  now,
  busy,
  onCreate,
}: {
  notes: NoteSummary[];
  hasAnyNote: boolean;
  now: number;
  busy: boolean;
  onCreate: () => void;
}) {
  const copy = useCopy(HOME_COPY);
  return (
    <section aria-labelledby="home-recent">
      <SectionHeading
        id="home-recent"
        icon={History}
        title={copy.recent.title}
        action={
          hasAnyNote ? (
            <Link href="/notes" className={SECTION_LINK}>
              {copy.recent.all}
            </Link>
          ) : null
        }
      />
      {notes.length === 0 ? (
        <EmptyState
          title={hasAnyNote ? copy.recent.allPinnedTitle : copy.recent.noneTitle}
          description={hasAnyNote ? copy.recent.allPinnedDescription : copy.recent.noneDescription}
          action={
            hasAnyNote ? null : (
              <Button size="lg" leading={<FilePlus2 aria-hidden className="size-4" />} disabled={busy} onClick={onCreate}>
                {copy.newNote}
              </Button>
            )
          }
        />
      ) : (
        <ul className="divide-y divide-line border-y border-line">
          {notes.map((note) => (
            <li key={note.id}>
              <NoteRow note={note} now={now} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function PinnedSection({ notes, now }: { notes: NoteSummary[]; now: number }) {
  const copy = useCopy(HOME_COPY).pinned;
  return (
    <section aria-labelledby="home-pinned" className="surface-desk px-4 py-3 sm:px-5">
      <SectionHeading id="home-pinned" icon={Pin} title={copy.title} />
      <ul className="divide-y divide-line">
        {notes.map((note) => (
          <li key={note.id}>
            <NoteRow note={note} now={now} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function ResurfaceSection({ notes, now }: { notes: NoteSummary[]; now: number }) {
  const copy = useCopy(HOME_COPY).resurface;
  return (
    <section aria-labelledby="home-resurface" className="px-1">
      <SectionHeading id="home-resurface" icon={RefreshCw} title={copy.title} />
      <p className="-mt-1 mb-2 text-sm text-mute">{copy.description}</p>
      <ul className="divide-y divide-line border-y border-line">
        {notes.map((note) => (
          <li key={note.id}>
            <NoteRow note={note} now={now} clamp={2} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function HomeSkeleton() {
  const copy = useCopy(HOME_COPY);
  return (
    <div className="mt-6 grid gap-8 lg:grid-cols-[minmax(0,1.65fr)_minmax(0,1fr)] lg:gap-10" aria-busy="true" aria-label={copy.loading}>
      <div className="flex flex-col gap-8">
        <div className="surface-card flex flex-col gap-4 p-5">
          <Skeleton className="h-4 w-24" />
          <SkeletonLines lines={3} />
        </div>
        <Skeleton className="h-24 w-full rounded-card" />
        <SkeletonLines lines={6} />
      </div>
      <div className="surface-desk flex flex-col gap-4 p-5">
        <Skeleton className="h-4 w-28" />
        <SkeletonLines lines={4} />
      </div>
    </div>
  );
}
