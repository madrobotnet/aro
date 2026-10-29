"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { useCopy, useLocale } from "@/components/i18n";
import { Button, cn } from "@/components/ui";
import { formatDayHeading } from "@/lib/i18n/format-date";
import { DAILY_COPY } from "./daily-copy";
import { addMonths, calendarMove, monthGrid, monthOf, monthParts } from "./daily-date";
import { useDailyMonth } from "./daily-month";

const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6] as const;
const TOUCH_ICON = "min-h-touch min-w-touch sm:min-h-0 sm:min-w-0";

export type MiniCalendarProps = {
  /** Date of the open daily note; the grid starts on its month with it focused. */
  selected: string;
  /** Viewer's local date key. */
  today: string;
  /** A day was chosen by click, Enter or Space; `noteId` is set when that day already has a note. */
  onSelect: (date: string, noteId: string | undefined) => void;
};

/** Sunday-first month grid with roving focus (WAI-ARIA date picker keys) and dots on days with a note. */
export function MiniCalendar({ selected, today, onSelect }: MiniCalendarProps) {
  const { locale } = useLocale();
  const copy = useCopy(DAILY_COPY).calendar;
  const [focused, setFocused] = useState(selected);
  const month = monthOf(focused);
  const parts = monthParts(month);
  const { notes, error, isLoading, retry } = useDailyMonth(parts ? month : null);
  const gridRef = useRef<HTMLTableElement>(null);
  // Focus follows the grid's active day after opening and after key moves, not after month buttons.
  const moveFocus = useRef(true);
  const headingId = useId();

  useEffect(() => {
    if (!moveFocus.current) return;
    moveFocus.current = false;
    gridRef.current?.querySelector<HTMLButtonElement>(`button[data-date="${focused}"]`)?.focus();
  }, [focused]);

  const shiftMonth = (months: number) => {
    const next = addMonths(focused, months);
    if (next) setFocused(next);
  };
  const onGridKeyDown = (event: KeyboardEvent<HTMLTableElement>) => {
    const next = calendarMove(focused, event);
    if (!next) return;
    event.preventDefault();
    moveFocus.current = true;
    setFocused(next);
  };

  return (
    <div className="w-min">
      <div className="flex items-center justify-between gap-2 pb-2">
        <Button variant="ghost" size="sm" iconOnly className={TOUCH_ICON} aria-label={copy.previousMonth} disabled={!addMonths(focused, -1)} onClick={() => shiftMonth(-1)}>
          <ChevronLeft aria-hidden className="size-4" />
        </Button>
        <h2 id={headingId} aria-live="polite" className="text-base font-semibold text-ink">
          {parts ? copy.month(parts.year, parts.month) : null}
        </h2>
        <Button variant="ghost" size="sm" iconOnly className={TOUCH_ICON} aria-label={copy.nextMonth} disabled={!addMonths(focused, 1)} onClick={() => shiftMonth(1)}>
          <ChevronRight aria-hidden className="size-4" />
        </Button>
      </div>
      <table ref={gridRef} role="grid" aria-labelledby={headingId} aria-busy={isLoading || undefined} className="border-collapse" onKeyDown={onGridKeyDown}>
        <thead>
          <tr>
            {WEEKDAYS.map((index) => (
              <th key={index} scope="col" className="pb-1 text-xs font-medium text-mute">
                <span aria-hidden>{copy.weekday(index)}</span>
                <span className="sr-only">{copy.weekdayLong(index)}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {monthGrid(month).map((week, row) => (
            <tr key={row}>
              {week.map((key, column) => {
                if (!key) return <td key={column} className="p-0" />;
                const inMonth = monthOf(key) === month;
                const noteId = inMonth ? notes.get(key) : undefined;
                const isToday = key === today;
                const isSelected = key === selected;
                return (
                  <td key={key} role="gridcell" aria-selected={isSelected} className="p-0">
                    <button
                      type="button"
                      data-date={key}
                      tabIndex={key === focused ? 0 : -1}
                      aria-label={copy.day(formatDayHeading(key, locale), noteId !== undefined, isToday)}
                      aria-current={isToday ? "date" : undefined}
                      onClick={() => onSelect(key, noteId)}
                      className={cn(
                        "relative flex size-11 items-center justify-center rounded-ctl text-base tabular-nums transition-colors duration-150 focus-ring sm:size-9 [@media(pointer:coarse)]:size-11",
                        isSelected ? "bg-accent-soft font-semibold" : "hover:bg-line/50",
                        isToday ? "font-semibold text-accent" : inMonth ? "text-ink" : "text-mute",
                      )}
                    >
                      {Number(key.slice(8))}
                      {noteId ? <span aria-hidden className="absolute bottom-1 left-1/2 size-1 -translate-x-1/2 rounded-pill bg-current" /> : null}
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-2 flex items-center justify-between gap-3 border-t border-line pt-2">
        <Button variant="ghost" size="sm" className="min-h-touch sm:min-h-0" onClick={() => onSelect(today, notes.get(today))}>
          {copy.today}
        </Button>
        {error ? (
          <p role="alert" className="flex min-w-0 flex-wrap items-center justify-end gap-x-2 text-xs text-danger">
            {copy.loadFailed}
            <button type="button" className="inline-flex min-h-touch min-w-touch items-center justify-center rounded-ctl font-semibold text-accent underline underline-offset-2 focus-ring" onClick={retry}>{copy.retry}</button>
          </p>
        ) : (
          <span className="inline-flex items-center gap-1.5 text-xs text-mute">
            <span aria-hidden className="size-1 rounded-pill bg-current" />
            {copy.legend}
          </span>
        )}
      </div>
    </div>
  );
}
