import { FilePlus2, History, Inbox, Pin, RefreshCw, Zap } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { useCopy, useLocale } from "@/components/i18n";
import { Badge, TagBadge } from "@/components/ui/Badge";
import { Button, buttonClassName } from "@/components/ui/Button";
import { cn } from "@/components/ui/cn";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton, SkeletonLines } from "@/components/ui/Skeleton";
import { inboxUrlStatus, stripInboxUrlStatus } from "@/lib/inbox-url-status";
import type { HomeData, InboxItem, NoteSummary } from "@/lib/types";
import { INBOX_COPY } from "@/features/inbox/inbox-copy";
import { displayNoteTitle } from "@/features/notes/display-title";
import { HOME_COPY } from "./home-copy";
import { relativeTime, splitCountPhrase } from "./home-model";

export function Counts({ stats }: { stats: HomeData["stats"] }) {
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
export function FirstRunPanel({ busy, onCapture, onCreate }: { busy: "note" | "daily" | null; onCapture: () => void; onCreate: () => void }) {
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

export function InboxSection({ count, items, now }: { count: number; items: InboxItem[]; now: number }) {
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
            const preview = item.homePreview
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

function NoteRow({ note, now, clamp = 1 }: { note: NoteSummary; now: number; clamp?: 1 | 2 }) {
  const { locale } = useLocale();
  const copy = useCopy(HOME_COPY);
  return (
    <Link href={`/notes/${note.id}`} className="-mx-2 flex min-h-touch flex-col gap-1 rounded-ctl px-2 py-2.5 hover:bg-desk focus-ring">
      <span className="flex items-baseline gap-3">
        <span className="min-w-0 flex-1 truncate text-md font-medium">{displayNoteTitle(note, locale)}</span>
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

export function RecentSection({
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

export function PinnedSection({ notes, now }: { notes: NoteSummary[]; now: number }) {
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

export function ResurfaceSection({ notes, now }: { notes: NoteSummary[]; now: number }) {
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

export function HomeSkeleton() {
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
