"use client";

import { CalendarClock, CalendarDays, ChevronDown, LoaderCircle, Sunrise, Sunset, X } from "lucide-react";
import { useId, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useCopy, useLocale } from "@/components/i18n";
import { Button, cn, Input } from "@/components/ui";
import { UI_COPY } from "@/components/ui/copy";
import { useModalDialog } from "@/components/ui/Dialog";
import { localizedApiError } from "@/lib/i18n/api-error";
import { formatDateTime } from "@/lib/i18n/format-date";
import type { InboxItem } from "@/lib/types";
import { INBOX_COPY } from "./inbox-copy";
import { parseSnoozeInput, snoozeLimit, snoozePresets, toDateTimeLocalValue, type SnoozePresetId } from "./inbox-triage";

/** `now` is the instant the sheet was opened; presets are computed from it. */
export type SnoozeTarget = { item: InboxItem; now: number };

const PRESET_ICON: Record<SnoozePresetId, typeof Sunset> = { evening: Sunset, tomorrow: Sunrise, nextMonday: CalendarDays };

const ROW =
  "flex min-h-touch w-full items-center gap-3 rounded-ctl px-3 py-2 text-left text-md text-ink transition-colors " +
  "hover:bg-line/50 focus-ring disabled:pointer-events-none disabled:opacity-50";

export function SnoozeSheet({
  target,
  onOpenChange,
  onSnooze,
}: {
  target: SnoozeTarget | null;
  onOpenChange: (open: boolean) => void;
  /** Rejects with the API failure, which the sheet shows while staying open. */
  onSnooze: (item: InboxItem, until: Date) => Promise<void>;
}) {
  const copy = useCopy(INBOX_COPY);
  const uiCopy = useCopy(UI_COPY);
  const { locale } = useLocale();
  const customId = useId();
  const titleId = useId();
  const descriptionId = useId();
  const firstRowRef = useRef<HTMLButtonElement>(null);
  const { ref, onClose, onBackdropClick } = useModalDialog(target !== null, onOpenChange, firstRowRef);
  const [seen, setSeen] = useState<SnoozeTarget | null>(null);
  const [busy, setBusy] = useState<SnoozePresetId | "custom" | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [customOpen, setCustomOpen] = useState(false);
  const [customValue, setCustomValue] = useState("");
  const [customError, setCustomError] = useState<"invalid" | "past" | "tooFar" | null>(null);

  const now = target ? new Date(target.now) : null;
  const presets = now ? snoozePresets(now) : [];

  // A new target (the sheet reopened) starts from a clean form.
  if (seen !== target) {
    setSeen(target);
    setBusy(null);
    setError(null);
    setCustomOpen(false);
    setCustomError(null);
    const tomorrow = presets.find((preset) => preset.id === "tomorrow");
    setCustomValue(tomorrow ? toDateTimeLocalValue(tomorrow.until) : "");
  }

  const choose = async (until: Date, source: SnoozePresetId | "custom") => {
    if (!target || busy) return;
    setBusy(source);
    setError(null);
    try {
      await onSnooze(target.item, until);
    } catch (cause) {
      setError(cause);
      setBusy(null);
    }
  };

  const submitCustom = (event: FormEvent) => {
    event.preventDefault();
    const parsed = parseSnoozeInput(customValue, new Date());
    if (!parsed.ok) {
      setCustomError(parsed.reason);
      return;
    }
    setCustomError(null);
    void choose(parsed.until, "custom");
  };

  const onRowsKeyDown = (event: ReactKeyboardEvent<HTMLUListElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
    const index = rows.indexOf(document.activeElement as HTMLButtonElement);
    if (index === -1) return;
    event.preventDefault();
    rows[(index + (event.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length]?.focus();
  };

  const parsedCustom = now && customOpen ? parseSnoozeInput(customValue, now) : null;

  return (
    <dialog
      ref={ref}
      data-sheet
      onClose={onClose}
      onCancel={(event) => {
        if (busy !== null) event.preventDefault();
      }}
      onClick={busy === null ? onBackdropClick : undefined}
      aria-labelledby={titleId}
      aria-describedby={target?.item.title ? descriptionId : undefined}
      className="mx-auto mb-0 mt-auto max-h-[85dvh] w-full max-w-md overflow-hidden rounded-t-card border border-b-0 border-line bg-card p-0 text-ink shadow-pop backdrop:bg-scrim open:flex open:flex-col sm:mb-auto sm:rounded-card sm:border-b"
    >
      {target ? (
        <>
          <div aria-hidden className="mx-auto mt-2 h-1 w-9 rounded-pill bg-line-strong sm:hidden" />
          <header className="flex items-start gap-3 px-4 pt-3 pb-1">
            <div className="min-w-0 flex-1">
              <h2 id={titleId} className="text-md font-semibold">{copy.snooze.title}</h2>
              {target.item.title ? <p id={descriptionId} className="text-sm text-mute">{target.item.title}</p> : null}
            </div>
            <Button variant="ghost" size="sm" iconOnly aria-label={uiCopy.close} disabled={busy !== null} onClick={() => onOpenChange(false)} className="-mr-1">
              <X className="size-4" />
            </Button>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-[calc(var(--spacing)*2+env(safe-area-inset-bottom,0px))] scrollbar-thin">
            <ul className="flex flex-col gap-0.5 py-1" onKeyDown={onRowsKeyDown}>
              {presets.map((preset, index) => {
                const Icon = PRESET_ICON[preset.id];
                return (
                  <li key={preset.id}>
                    <button ref={index === 0 ? firstRowRef : undefined} type="button" className={ROW} disabled={busy !== null} onClick={() => void choose(preset.until, preset.id)}>
                      {busy === preset.id ? <LoaderCircle aria-hidden className="size-4 shrink-0 animate-spin text-mute" /> : <Icon aria-hidden className="size-4 shrink-0 text-mute" />}
                      <span className="min-w-0 flex-1 font-medium">{copy.snooze.presets[preset.id]}</span>
                      <span className="shrink-0 text-sm tabular-nums text-mute">{formatDateTime(preset.until, locale)}</span>
                    </button>
                  </li>
                );
              })}
              <li>
                <button
                  type="button"
                  className={ROW}
                  aria-expanded={customOpen}
                  aria-controls={customId}
                  disabled={busy !== null}
                  onClick={() => setCustomOpen((open) => !open)}
                >
                  <CalendarClock aria-hidden className="size-4 shrink-0 text-mute" />
                  <span className="min-w-0 flex-1 font-medium">{copy.snooze.custom}</span>
                  <ChevronDown aria-hidden className={cn("size-4 shrink-0 text-mute transition-transform duration-150", customOpen && "rotate-180")} />
                </button>
              </li>
            </ul>
            {customOpen && now ? (
              <form id={customId} noValidate className="flex flex-col gap-3 px-3 pb-2 pt-1" onSubmit={submitCustom}>
                <Input
                  type="datetime-local"
                  label={copy.snooze.customLabel}
                  value={customValue}
                  min={toDateTimeLocalValue(now)}
                  max={toDateTimeLocalValue(snoozeLimit(now))}
                  onChange={(event) => {
                    setCustomValue(event.target.value);
                    setCustomError(null);
                  }}
                  error={customError ? copy.snooze[customError] : undefined}
                  hint={parsedCustom?.ok ? copy.snooze.customHint(formatDateTime(parsedCustom.until, locale)) : undefined}
                  disabled={busy !== null}
                />
                <Button type="submit" variant="primary" size="lg" loading={busy === "custom"} disabled={busy !== null}>
                  {copy.snooze.submit}
                </Button>
              </form>
            ) : null}
            {error ? (
              <p role="alert" className="mx-3 mb-2 mt-1 rounded-ctl bg-danger-soft px-3 py-2 text-sm text-danger">
                {localizedApiError(error, locale, copy.snooze.failed)}
              </p>
            ) : null}
          </div>
        </>
      ) : null}
    </dialog>
  );
}
