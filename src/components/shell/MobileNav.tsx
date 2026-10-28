"use client";

import { Check, Ellipsis, LogOut, Monitor, Moon, Plus, Search, Sun } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { useCopy, useLocale } from "@/components/i18n/LocaleProvider";
import { Badge } from "@/components/ui/Badge";
import { BrandMark } from "@/components/ui/BrandMark";
import { cn } from "@/components/ui/cn";
import { Sheet } from "@/components/ui/Dialog";
import { brandName } from "@/lib/brand";
import { SHELL_COPY } from "./copy";
import { activeNavId, isMoreActive, isNavActive, MOBILE_MORE, MOBILE_PRIMARY, navItem } from "./nav";
import { useShell } from "./ShellProvider";

const THEME_ICON = { light: Sun, dark: Moon, system: Monitor } as const;

/** Mobile (< lg) top bar. Shows the current section name and a palette button. */
export function MobileTopBar() {
  const pathname = usePathname();
  const shell = useShell();
  const { locale } = useLocale();
  const copy = useCopy(SHELL_COPY);
  const active = activeNavId(pathname);
  const title = active ? copy.nav[active] : brandName(locale);

  return (
    <header className="sticky top-0 z-30 flex h-topbar items-center gap-2 border-b border-line bg-desk/95 px-3 backdrop-blur pt-safe lg:hidden">
      <Link href="/" aria-label={copy.nav.home} className="flex size-touch items-center justify-center rounded-ctl focus-ring">
        <BrandMark />
      </Link>
      <p className="min-w-0 flex-1 truncate text-md font-semibold tracking-tight">{title}</p>
      <button
        type="button"
        aria-label={copy.actions.openPalette}
        title={copy.actions.openPalette}
        onClick={() => shell.openPalette("all")}
        className="flex size-touch items-center justify-center rounded-ctl text-mute hover:bg-line/60 hover:text-ink focus-ring"
      >
        <Search aria-hidden className="size-5" />
      </button>
    </header>
  );
}

/** Mobile bottom bar: home · inbox · [capture] · notes · more. */
export function MobileNav() {
  const pathname = usePathname();
  const shell = useShell();
  const copy = useCopy(SHELL_COPY);
  const [moreOpen, setMoreOpen] = useState(false);
  const [left, right] = [MOBILE_PRIMARY.slice(0, 2), MOBILE_PRIMARY.slice(2)];
  const moreActive = isMoreActive(pathname);
  const ThemeIcon = THEME_ICON[shell.theme];

  return (
    <>
      <nav
        aria-label={copy.mobile.navLabel}
        className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-desk/95 backdrop-blur pb-safe lg:hidden"
      >
        <ul className="grid h-bottomnav grid-cols-5 items-stretch">
          {left.map((id) => (
            <BottomLink key={id} id={id} active={isNavActive(pathname, navItem(id).href)} badge={id === "inbox" ? shell.inboxCount : null} />
          ))}
          <li className="flex items-center justify-center">
            <button
              type="button"
              aria-label={copy.actions.capture}
              title={copy.actions.capture}
              onClick={() => shell.openCapture()}
              className="-mt-5 flex size-14 items-center justify-center rounded-pill bg-accent text-accent-ink shadow-pop transition-[filter] active:brightness-90 focus-ring-offset"
            >
              <Plus aria-hidden className="size-7" />
            </button>
          </li>
          {right.map((id) => (
            <BottomLink key={id} id={id} active={isNavActive(pathname, navItem(id).href)} badge={id === "inbox" ? shell.inboxCount : null} />
          ))}
          <li>
            <button
              type="button"
              aria-haspopup="dialog"
              aria-expanded={moreOpen}
              aria-current={moreActive ? "page" : undefined}
              onClick={() => setMoreOpen(true)}
              className={cn(BOTTOM_ITEM, moreActive ? "bg-accent-soft text-ink" : "text-mute")}
            >
              <span className="relative"><Ellipsis aria-hidden className="size-5" />{moreActive ? <Check aria-hidden className="absolute -right-3 -top-1 size-3" /> : null}</span>
              <span className="text-xs font-medium">{copy.mobile.more}</span>
            </button>
          </li>
        </ul>
      </nav>

      <Sheet open={moreOpen} onOpenChange={setMoreOpen} title={copy.mobile.more}>
        <ul className="grid grid-cols-1 gap-0.5 pb-1">
          {MOBILE_MORE.map((id) => {
            const item = navItem(id);
            const active = isNavActive(pathname, item.href);
            return (
              <li key={id}>
                <Link
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  onClick={() => setMoreOpen(false)}
                  className={cn(
                    "flex h-12 items-center gap-3 rounded-ctl px-3 text-md focus-ring",
                    active ? "bg-accent-soft text-ink" : "text-ink hover:bg-line/60",
                  )}
                >
                  <item.icon aria-hidden className="size-5 text-mute" />
                  <span className="flex-1">{copy.nav[id]}</span>
                  {active ? <Check aria-hidden className="size-4" /> : null}
                </Link>
              </li>
            );
          })}
        </ul>
        <div className="mt-1 grid grid-cols-2 gap-2 border-t border-line px-1 pt-3">
          <button type="button" onClick={shell.cycleTheme} className={SHEET_ACTION}>
            <ThemeIcon aria-hidden className="size-4 text-mute" />
            {copy.theme.value(copy.theme.short[shell.theme])}
          </button>
          <button type="button" onClick={() => void shell.logout()} className={SHEET_ACTION}>
            <LogOut aria-hidden className="size-4 text-mute" />
            {copy.actions.logout}
          </button>
        </div>
      </Sheet>
    </>
  );
}

const BOTTOM_ITEM = "flex h-full w-full flex-col items-center justify-center gap-0.5 focus-ring";
const SHEET_ACTION = "flex h-11 items-center justify-center gap-2 rounded-ctl border border-line bg-desk text-sm text-ink hover:bg-line/60 focus-ring";

function BottomLink({ id, active, badge }: { id: (typeof MOBILE_PRIMARY)[number]; active: boolean; badge: number | null }) {
  const item = navItem(id);
  const copy = useCopy(SHELL_COPY);
  return (
    <li>
      <Link href={item.href} aria-current={active ? "page" : undefined} className={cn(BOTTOM_ITEM, active ? "bg-accent-soft text-ink" : "text-mute")}>
        <span className="relative">
          <item.icon aria-hidden className="size-5" />
          {active ? <Check aria-hidden className="absolute -left-3 -top-1 size-3" /> : null}
          {badge ? <Badge tone="rail" count={badge} className="absolute -right-2.5 -top-1.5" /> : null}
        </span>
        <span className="text-xs font-medium">{copy.nav[id]}</span>
      </Link>
    </li>
  );
}
