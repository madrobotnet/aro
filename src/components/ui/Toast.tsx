"use client";

import { CircleAlert, CircleCheck, Info, X } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useCopy, useLocale } from "@/components/i18n/LocaleProvider";
import type { Locale, LocalizedText } from "@/lib/i18n/locale";
import { cn } from "./cn";
import { UI_COPY } from "./copy";
import { armToastTimer, createToastAction, enqueueToast, toastDuration, type ToastAction, type ToastActionState } from "./toast-lifecycle";

export type ToastTone = "info" | "ok" | "danger";

/**
 * Retained UI text carries every locale, so a toast that stays open follows a language switch.
 */
export type ToastText = LocalizedText;

export function toastText(text: ToastText, locale: Locale): string {
  return text[locale];
}

export type ToastOptions = {
  tone?: ToastTone;
  /** Optional single action (e.g. undo). */
  action?: { label: ToastText; onClick: ToastAction };
  /** Milliseconds before auto-dismiss; actions default to 0 (until closed). */
  durationMs?: number;
};

export type ToastItem = ToastOptions & { id: number; message: ToastText };

export type ToastContextValue = {
  toast: (message: ToastText, options?: ToastOptions) => number;
  dismiss: (id: number) => void;
};

const ToastContext = createContext<ToastContextValue | null>(null);

const TONE_ICON: Record<ToastTone, typeof Info> = { info: Info, ok: CircleCheck, danger: CircleAlert };
const TONE_TEXT: Record<ToastTone, string> = { info: "text-mute", ok: "text-ok", danger: "text-danger" };

function ToastCard({ item, onDismiss }: { item: ToastItem; onDismiss: (id: number) => void }) {
  const { locale } = useLocale();
  const copy = useCopy(UI_COPY);
  const tone = item.tone ?? "info";
  const Icon = TONE_ICON[tone];
  const [actionState, setActionState] = useState<ToastActionState>("idle");
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const runAction = useMemo(() => item.action
    ? createToastAction(item.action.onClick, () => onDismiss(item.id), setActionState)
    : undefined, [item.action, item.id, onDismiss]);
  const duration = toastDuration(item);
  useEffect(() => {
    if (hovered || focused || actionState !== "idle") return;
    return armToastTimer(duration, () => onDismiss(item.id));
  }, [duration, item.id, onDismiss, hovered, focused, actionState]);

  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
      }}
      className={cn(
        "pointer-events-auto flex w-full items-start gap-2.5 rounded-card border border-line bg-card px-3.5 py-2.5 text-base text-ink shadow-pop",
        "motion-safe:animate-[sb-toast-in_180ms_var(--ease-out-soft)]",
      )}
    >
      <Icon aria-hidden className={cn("mt-0.5 size-4 shrink-0", TONE_TEXT[tone])} />
      <div className="min-w-0 flex-1 leading-snug">
        <p>{toastText(item.message, locale)}</p>
        {actionState === "failed" ? (
          <p role="alert" className="mt-1 text-sm text-danger">
            {locale === "ko" ? "완료하지 못했습니다. 다시 시도해 주세요." : "Could not complete. Please try again."}
          </p>
        ) : null}
      </div>
      {item.action ? (
        <button
          type="button"
          className="control-target inline-flex shrink-0 items-center justify-center rounded-ctl px-1.5 py-0.5 text-sm font-semibold text-accent hover:bg-accent-soft active:bg-line/80 focus-ring"
          aria-disabled={actionState === "pending"}
          aria-busy={actionState === "pending"}
          onClick={runAction}
        >
          {actionState === "pending" ? <span aria-hidden className="mr-1 inline-block size-2 rounded-pill bg-current animate-pulse" /> : null}
          {toastText(item.action.label, locale)}
        </button>
      ) : null}
      <button
        type="button"
        aria-label={copy.dismissToast}
        className="control-target -mr-1 inline-flex shrink-0 items-center justify-center rounded-ctl p-1 text-mute hover:bg-line/60 hover:text-ink active:bg-line/80 focus-ring"
        onClick={() => onDismiss(item.id)}
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const { locale } = useLocale();
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);

  const dismiss = useCallback((id: number) => setItems((prev) => prev.filter((t) => t.id !== id)), []);
  const toast = useCallback((message: ToastText, options?: ToastOptions) => {
    const id = ++seq.current;
    setItems((prev) => enqueueToast(prev, { id, message, ...options }));
    return id;
  }, []);

  const value = useMemo(() => ({ toast, dismiss }), [toast, dismiss]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        className={cn(
          "pointer-events-none fixed inset-x-0 z-50 flex flex-col items-center px-4",
          "bottom-[calc(var(--bottomnav-h)+env(safe-area-inset-bottom,0px)+0.75rem)] lg:bottom-4 lg:items-end lg:px-6",
        )}
      >
        {items.length > 0 ? (
          <section
            aria-label={locale === "ko" ? "알림" : "Notifications"}
            tabIndex={0}
            className="pointer-events-auto flex max-h-[min(50dvh,var(--workspace-h))] w-full max-w-sm flex-col gap-2 overflow-y-auto overscroll-contain scroll-py-1 rounded-card p-1 focus-ring"
          >
            {items.map((item) => <ToastCard key={item.id} item={item} onDismiss={dismiss} />)}
          </section>
        ) : null}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside <ToastProvider>");
  return ctx;
}
