"use client";

import { Languages } from "lucide-react";
import { useId, useRef, useState, type KeyboardEvent } from "react";
import { cn } from "@/components/ui/cn";
import { LOCALES, type Locale } from "@/lib/i18n/locale";
import { LANGUAGE_COPY, LOCALE_NAMES } from "./copy";
import { useCopy, useLocale } from "./LocaleProvider";

export type LanguageSwitchProps = {
  /** Keep "Language" as the group's accessible name but do not show it (e.g. under a section heading). */
  hideLabel?: boolean;
  /** Width and placement; the control fills its container by default. */
  className?: string;
};

/** WAI-ARIA radio group keys: arrows move and select (wrapping), Home/End jump; other keys -> null. */
export function localeForKey(current: Locale, key: string): Locale | null {
  const index = LOCALES.indexOf(current);
  const at = (i: number) => LOCALES[(i + LOCALES.length) % LOCALES.length] ?? current;
  switch (key) {
    case "ArrowRight":
    case "ArrowDown":
      return at(index + 1);
    case "ArrowLeft":
    case "ArrowUp":
      return at(index - 1);
    case "Home":
      return at(0);
    case "End":
      return at(LOCALES.length - 1);
    default:
      return null;
  }
}

/**
 * Korean / English segmented switch. Applies instantly without navigation or refresh, so
 * surrounding forms keep their state. Options are type="button" radios (never submit a form,
 * never add form data), named in their own language and marked with `lang`.
 */
export function LanguageSwitch({ hideLabel = false, className }: LanguageSwitchProps) {
  const { locale, setLocale } = useLocale();
  const copy = useCopy(LANGUAGE_COPY);
  const labelId = useId();
  const statusId = useId();
  const [notSaved, setNotSaved] = useState(false);
  const options = useRef<Partial<Record<Locale, HTMLButtonElement | null>>>({});

  // Choosing the already-active option still records it as an explicit choice.
  const choose = (next: Locale) => setNotSaved(!setLocale(next));

  const onKeyDown = (option: Locale) => (event: KeyboardEvent<HTMLButtonElement>) => {
    const next = localeForKey(option, event.key);
    if (!next) return;
    event.preventDefault();
    choose(next);
    options.current[next]?.focus();
  };

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <span id={labelId} className={cn("flex items-center gap-1.5 text-sm font-medium text-ink", hideLabel && "sr-only")}>
        <Languages aria-hidden className="size-4 text-mute" />
        {copy.label}
      </span>
      <div
        role="radiogroup"
        aria-labelledby={labelId}
        aria-describedby={notSaved ? statusId : undefined}
        className="grid grid-cols-2 gap-1 rounded-card border border-line bg-desk p-1"
      >
        {LOCALES.map((option) => {
          const checked = option === locale;
          return (
            <button
              key={option}
              ref={(node) => {
                options.current[option] = node;
              }}
              type="button"
              role="radio"
              aria-checked={checked}
              tabIndex={checked ? 0 : -1}
              lang={option}
              translate="no"
              onClick={() => choose(option)}
              onKeyDown={onKeyDown(option)}
              className={cn(
                "flex min-h-touch items-center justify-center rounded-ctl px-3 text-base font-medium transition-[background-color,color,box-shadow] duration-150 focus-ring",
                checked ? "bg-card text-ink shadow-card ring-1 ring-inset ring-control-boundary" : "text-mute hover:bg-line/50 hover:text-ink active:bg-line/80",
              )}
            >
              {LOCALE_NAMES[option]}
            </button>
          );
        })}
      </div>
      <p id={statusId} role="status" className="rounded-ctl bg-warn-soft px-3 py-2 text-sm text-warn empty:hidden">
        {notSaved ? copy.notSaved : null}
      </p>
    </div>
  );
}
