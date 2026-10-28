import { ArrowLeft, Check, LoaderCircle } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { useCopy, useLocale } from "@/components/i18n";
import { Button, cn } from "@/components/ui";
import { localizedApiError } from "@/lib/i18n/api-error";
import { DailyNav } from "./DailyNav";
import { NOTES_COPY } from "./copy";

export function NoteHeader({ date, state, version, error, retry, modeControl, children }: {
  readonly date: string | null;
  readonly state: string;
  readonly version: number;
  readonly error: unknown;
  readonly retry: () => void;
  readonly modeControl: ReactNode;
  readonly children: ReactNode;
}) {
  const copy = useCopy(NOTES_COPY);
  return (
    <div className="py-2 sm:px-4">
      <div className="flex min-w-0 flex-wrap items-center lg:gap-1">
        <Link href="/notes" aria-label={copy.detail.backToList} title={copy.detail.backToList} className="inline-flex min-h-touch min-w-touch shrink-0 items-center justify-center text-sm text-mute hover:text-ink lg:hidden"><ArrowLeft aria-hidden className="size-4" /></Link>
        {date ? <DailyNav date={date} /> : null}
        {state !== "failed" ? <SaveIndicator state={state} version={version} error={error} retry={retry} compact={Boolean(date)} /> : null}
        <div className={cn("ml-auto", date && "max-sm:order-last max-sm:mt-1 max-sm:flex max-sm:w-full max-sm:justify-end")}>{modeControl}</div>
        {children}
      </div>
      {state === "failed" ? <SaveIndicator state={state} version={version} error={error} retry={retry} /> : null}
    </div>
  );
}

function SaveIndicator({ state, version, error, retry, compact = false }: { state: string; version: number; error: unknown; retry: () => void; compact?: boolean }) {
  const { locale } = useLocale();
  const copy = useCopy(NOTES_COPY);
  if (state === "failed") return <div role="alert" data-save-state={state} data-save-version={version} className="order-last w-full rounded-ctl border border-danger/30 bg-danger-soft px-3 py-2 text-sm">
    <div className="flex items-center justify-between gap-2"><span className="font-medium text-danger">{copy.detail.saveFailed}</span><Button size="sm" className="min-h-touch sm:min-h-0" variant="ghost" onClick={retry}>{copy.retry}</Button></div>
    <p>{localizedApiError(error, locale, copy.detail.saveFailedDetail)}</p>
  </div>;
  const saving = state === "saving" || state === "dirty";
  // One live region whose text changes, so screen readers hear each save state.
  return <span role="status" data-save-state={state} data-save-version={version} aria-label={saving ? copy.detail.saving : copy.detail.saved} title={saving ? copy.detail.saving : copy.detail.saved}
    className={cn("inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-xs", saving ? "text-warn" : "text-mute")}>
    {saving ? <LoaderCircle aria-hidden className="size-3.5 animate-spin" /> : <Check aria-hidden className="size-3.5" />}
    {/* A daily note's header also holds the date control, so on phones the state is its icon. */}
    <span className={compact ? "sr-only sm:not-sr-only" : "max-[430px]:sr-only"}>{saving ? copy.detail.saving : copy.detail.saved}</span>
  </span>;
}
