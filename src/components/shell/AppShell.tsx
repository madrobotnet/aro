"use client";

import type { ReactNode } from "react";
import { useCopy } from "@/components/i18n";
import { SHELL_COPY } from "./copy";
import { MobileNav, MobileTopBar } from "./MobileNav";
import { ShellProvider } from "./ShellProvider";
import { Sidebar } from "./Sidebar";

/**
 * Authenticated frame: rail on desktop, top bar + bottom nav on mobile.
 * Pages own their inner padding so full-bleed views (graph, editor) can opt out.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const copy = useCopy(SHELL_COPY);
  return (
    <ShellProvider>
      <a href="#main" onClick={() => document.getElementById("main")?.focus()} className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded-ctl focus:bg-card focus:px-4 focus:py-3 focus:text-ink focus-ring">
        {copy.actions.skip}
      </a>
      <Sidebar />
      <MobileTopBar />
      <div className="min-h-[calc(100dvh-var(--topbar-h))] pb-[calc(var(--bottomnav-h)+env(safe-area-inset-bottom,0px))] lg:min-h-dvh lg:pb-0 lg:pl-rail lg:rail-open:pl-rail-open transition-[padding] duration-200 ease-out-soft">
        <main id="main" tabIndex={-1} className="min-h-[var(--workspace-h)] lg:min-h-dvh">
          {children}
        </main>
      </div>
      <MobileNav />
    </ShellProvider>
  );
}
