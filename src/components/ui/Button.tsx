import { LoaderCircle } from "lucide-react";
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cn } from "./cn";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "rail";
export type ButtonSize = "sm" | "md" | "lg";

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Square button with only an icon; `aria-label` is required in that case. */
  iconOnly?: boolean;
  loading?: boolean;
  leading?: ReactNode;
  trailing?: ReactNode;
};

const VARIANT: Record<ButtonVariant, string> = {
  primary: "bg-accent text-accent-ink border-transparent hover:brightness-95 active:brightness-90",
  secondary: "bg-card text-ink border-control-boundary hover:bg-desk active:bg-line/60 shadow-card",
  ghost: "bg-transparent text-ink border-transparent hover:bg-line/50 active:bg-line/80",
  danger: "bg-danger-soft text-danger border-transparent hover:bg-desk active:bg-canvas",
  rail: "bg-transparent text-rail-ink border-transparent hover:bg-rail-hover active:bg-rail-pressed [--focus:var(--rail-ink)]",
};

const SIZE: Record<ButtonSize, string> = {
  sm: "h-8 px-2.5 text-sm gap-1.5",
  md: "h-9 px-3 text-base gap-2",
  lg: "h-11 px-4 text-md gap-2",
};

const ICON_ONLY: Record<ButtonSize, string> = {
  sm: "size-8 px-0",
  md: "size-9 px-0",
  lg: "size-11 px-0",
};

export const buttonClassName = (opts: { variant?: ButtonVariant; size?: ButtonSize; iconOnly?: boolean } = {}) =>
  cn(
    "control-target inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap rounded-ctl border font-medium",
    "transition-[background-color,filter,color] duration-150 disabled:opacity-50 disabled:pointer-events-none",
    opts.variant === "primary" ? "focus-ring-offset" : "focus-ring",
    VARIANT[opts.variant ?? "secondary"],
    opts.iconOnly ? ICON_ONLY[opts.size ?? "md"] : SIZE[opts.size ?? "md"],
  );

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", iconOnly = false, loading = false, leading, trailing, className, children, disabled, type, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? "button"}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(buttonClassName({ variant, size, iconOnly }), className)}
      {...rest}
    >
      {loading ? <LoaderCircle aria-hidden className="size-4 animate-spin" /> : leading}
      {children}
      {trailing}
    </button>
  );
});
