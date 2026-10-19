import type { ReactNode } from "react";
import { cn } from "@/components/ui/cn";

export function SettingsGroup({ id, title, children, danger = false }: { id: string; title: string; children: ReactNode; danger?: boolean }) {
  return (
    <section aria-labelledby={id} className={danger ? "rounded-card border border-danger/30 bg-danger-soft px-4 sm:px-6" : undefined}>
      <h2 id={id} className={cn("text-xl font-semibold tracking-tight", danger && "pt-6 text-danger")}>{title}</h2>
      <div className="mt-2 divide-y divide-line">{children}</div>
    </section>
  );
}

export function Section({ id, title, description, children, className }: { id: string; title: string; description: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section aria-labelledby={id} className={cn("grid gap-4 py-6 lg:grid-cols-[minmax(0,15rem)_minmax(0,1fr)] lg:gap-10", className)}>
      <div>
        <h3 id={id} className="text-md font-semibold">
          {title}
        </h3>
        <p className="mt-1 text-sm text-mute">{description}</p>
      </div>
      <div className="min-w-0">{children}</div>
    </section>
  );
}
