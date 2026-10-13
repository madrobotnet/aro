import type { HTMLAttributes } from "react";
import { cn } from "./cn";

export type BadgeTone = "neutral" | "accent" | "ok" | "warn" | "danger" | "rail";

export type BadgeProps = HTMLAttributes<HTMLSpanElement> & {
  tone?: BadgeTone;
  /** Compact numeric pill (unread counts). Values above 99 render as "99+". */
  count?: number;
};

const TONE: Record<BadgeTone, string> = {
  neutral: "bg-line/70 text-ink",
  accent: "bg-accent-soft text-accent",
  ok: "bg-ok-soft text-ok",
  warn: "bg-warn-soft text-warn",
  danger: "bg-danger-soft text-danger",
  rail: "bg-accent text-accent-ink",
};

export function Badge({ tone = "neutral", count, className, children, ...rest }: BadgeProps) {
  if (count !== undefined) {
    return (
      <span
        className={cn(
          "inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-pill px-1.5 text-2xs font-semibold tabular-nums leading-none",
          TONE[tone],
          className,
        )}
        {...rest}
      >
        {count > 99 ? "99+" : count}
      </span>
    );
  }
  return (
    <span
      className={cn("inline-flex items-center gap-1 rounded-pill px-2 py-0.5 text-xs font-medium leading-4", TONE[tone], className)}
      {...rest}
    >
      {children}
    </span>
  );
}

/** `#tag` chip; renders the hash in muted ink so lists of tags stay scannable. */
export function TagBadge({ tag, className, children, ...rest }: HTMLAttributes<HTMLSpanElement> & { tag: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-ctl border border-line bg-desk px-1.5 py-0.5 text-xs leading-4 text-ink",
        className,
      )}
      {...rest}
    >
      <span aria-hidden className="text-mute">
        #
      </span>
      {tag}
      {children}
    </span>
  );
}
