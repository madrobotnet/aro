import type { HTMLAttributes } from "react";
import { cn } from "./cn";

/** Loading placeholder block; size it with width/height classes. */
export function Skeleton({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden
      className={cn(
        "relative isolate overflow-hidden rounded-ctl bg-line",
        "after:pointer-events-none after:absolute after:inset-0 after:bg-[linear-gradient(90deg,transparent,var(--desk),transparent)] after:content-['']",
        "motion-safe:after:animate-[sb-shimmer_1.6s_linear_infinite] motion-reduce:after:hidden",
        className,
      )}
      {...rest}
    />
  );
}

/** N stacked text lines. */
export function SkeletonLines({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <div className={cn("flex flex-col gap-2", className)} aria-hidden>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} className={cn("h-3.5", i === lines - 1 ? "w-2/3" : "w-full")} />
      ))}
    </div>
  );
}
