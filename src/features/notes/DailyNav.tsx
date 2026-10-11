"use client";

import { CalendarDays, ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useCopy, useLocale } from "@/components/i18n";
import { Button, cn } from "@/components/ui";
import { formatDayHeading, localDateKey } from "@/lib/i18n/format-date";
import { DAILY_COPY } from "./daily-copy";
import { addDays, dailyHref, isDayKey, monthOf } from "./daily-date";
import { useDailyMonth } from "./daily-month";
import { MiniCalendar } from "./MiniCalendar";

/** Popover gap to its trigger and to the viewport edge (spacing-2). */
const EDGE_GAP = 8;
const TOUCH_ICON = "min-h-touch min-w-touch sm:min-h-0 sm:min-w-0";
// Below `sm` the note header has room for one 44px control: prev/next hide (the calendar reaches
// neighboring days in one tap) and the trigger shows only its icon, with the date as its name.
const STEP_BUTTON = "max-sm:hidden";

export type DailyNavProps = {
  /** `dailyDate` (`YYYY-MM-DD`) of the open daily note. */
  date: string;
};

/**
 * Previous/next day and a mini calendar for a daily note. A day that already has a note opens it
 * directly; any other day goes through `/daily?date=`, which creates the note only then.
 */
export function DailyNav({ date }: DailyNavProps) {
  const router = useRouter();
  const { locale } = useLocale();
  const copy = useCopy(DAILY_COPY);
  const { notes } = useDailyMonth(isDayKey(date) ? monthOf(date) : null);
  const [calendar, setCalendar] = useState<{ today: string } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const previous = addDays(date, -1);
  const next = addDays(date, 1);

  const close = (restoreFocus: boolean) => {
    setCalendar(null);
    if (restoreFocus) triggerRef.current?.focus();
  };
  const open = (target: string, noteId: string | undefined) => {
    close(true);
    if (target !== date) router.push(dailyHref(target, noteId));
  };

  useEffect(() => {
    if (!calendar) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setCalendar(null);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [calendar]);

  // Fixed to the viewport so a scrolling pane cannot clip it, kept inside the viewport (390px
  // phones included) and re-anchored when any ancestor scrolls.
  useLayoutEffect(() => {
    if (!calendar) return;
    const place = () => {
      const root = rootRef.current;
      const popover = popoverRef.current;
      if (!root || !popover) return;
      const anchor = root.getBoundingClientRect();
      const viewport = window.visualViewport;
      const top = (viewport?.offsetTop ?? 0) + EDGE_GAP;
      const left = (viewport?.offsetLeft ?? 0) + EDGE_GAP;
      const height = viewport?.height ?? window.innerHeight;
      const width = viewport?.width ?? document.documentElement.clientWidth;
      popover.style.maxHeight = `${Math.max(0, height - 2 * EDGE_GAP)}px`;
      const bottom = top + height - 2 * EDGE_GAP;
      const below = anchor.bottom + EDGE_GAP;
      const preferredTop = below + popover.offsetHeight <= bottom
        ? below : anchor.top - EDGE_GAP - popover.offsetHeight;
      popover.style.top = `${Math.max(top, Math.min(preferredTop, bottom - popover.offsetHeight))}px`;
      popover.style.left = `${Math.max(left, Math.min(anchor.left, left + width - 2 * EDGE_GAP - popover.offsetWidth))}px`;
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    window.visualViewport?.addEventListener("resize", place);
    window.visualViewport?.addEventListener("scroll", place);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      window.visualViewport?.removeEventListener("resize", place);
      window.visualViewport?.removeEventListener("scroll", place);
    };
  }, [calendar]);

  return (
    <div ref={rootRef}>
      <nav aria-label={copy.nav.label} className="flex items-center gap-0.5">
        <Button variant="ghost" size="sm" iconOnly className={STEP_BUTTON} disabled={!previous}
          aria-label={previous ? copy.nav.previous(formatDayHeading(previous, locale)) : undefined}
          onClick={() => previous && open(previous, notes.get(previous))}>
          <ChevronLeft aria-hidden className="size-4" />
        </Button>
        <Button ref={triggerRef} variant="ghost" size="sm" className={cn(TOUCH_ICON, "max-sm:px-0")}
          aria-haspopup="dialog" aria-expanded={calendar !== null}
          leading={<CalendarDays aria-hidden className="size-4 text-mute" />}
          trailing={<ChevronDown aria-hidden className={cn("hidden size-3.5 text-mute transition-transform duration-150 sm:block", calendar && "rotate-180")} />}
          onClick={() => (calendar ? close(false) : setCalendar({ today: localDateKey() }))}>
          <span className="sr-only sm:not-sr-only">{formatDayHeading(date, locale)}</span>
          <span className="sr-only">, {copy.nav.calendarHint}</span>
        </Button>
        <Button variant="ghost" size="sm" iconOnly className={STEP_BUTTON} disabled={!next}
          aria-label={next ? copy.nav.next(formatDayHeading(next, locale)) : undefined}
          onClick={() => next && open(next, notes.get(next))}>
          <ChevronRight aria-hidden className="size-4" />
        </Button>
      </nav>
      {calendar ? (
        <div
          ref={popoverRef}
          role="dialog"
          aria-label={copy.calendar.label}
          className="fixed z-50 max-w-[calc(100vw-16px)] overflow-auto surface-card p-3 shadow-pop motion-safe:animate-[sb-pop-in_160ms_var(--ease-out-soft)]"
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.stopPropagation();
            close(true);
          }}
          onBlur={(event) => {
            const target = event.relatedTarget;
            if (target instanceof Node && !rootRef.current?.contains(target)) setCalendar(null);
          }}
        >
          <MiniCalendar selected={date} today={calendar.today} onSelect={open} />
        </div>
      ) : null}
    </div>
  );
}
