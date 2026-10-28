import type { HTMLAttributes } from "react";
import { cn } from "./cn";

/** `cn` does not merge conflicting classes, so surface colors come from a variant, never a className override. */
export type KbdVariant = "default" | "onAccent" | "onRail";

const VARIANT: Record<KbdVariant, string> = {
  default: "border-line-strong/80 bg-desk text-mute shadow-[inset_0_-1px_0_var(--line-strong)]",
  onAccent: "border-accent-ink/40 bg-transparent text-accent-ink",
  onRail: "border-rail-line bg-rail-hover text-rail-ink",
};

/** Keyboard key cap. Callers supply the platform modifier text when needed. */
export function Kbd({ className, children, variant = "default", ...rest }: HTMLAttributes<HTMLElement> & { variant?: KbdVariant }) {
  return (
    <kbd
      className={cn(
        "inline-flex h-5 min-w-5 items-center justify-center rounded-keycap border px-1 text-xs font-medium",
        VARIANT[variant],
        className,
      )}
      {...rest}
    >
      {children}
    </kbd>
  );
}

/** "⌘K"-style hint: a row of Kbd caps. */
export function Shortcut({ keys, className, variant }: { keys: readonly string[]; className?: string; variant?: KbdVariant }) {
  return (
    <span className={cn("inline-flex items-center gap-0.5", className)} aria-hidden>
      {keys.map((key, index) => (
        <Kbd key={`${key}-${index}`} variant={variant}>{key}</Kbd>
      ))}
    </span>
  );
}
