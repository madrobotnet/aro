"use client";

import { LogOut, Monitor, Moon, PanelLeftClose, PanelLeftOpen, Plus, Search, Sun } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCopy, useLocale } from "@/components/i18n/LocaleProvider";
import { Badge } from "@/components/ui/Badge";
import { BrandMark } from "@/components/ui/BrandMark";
import { cn } from "@/components/ui/cn";
import { Kbd } from "@/components/ui/Kbd";
import { brandName } from "@/lib/brand";
import { SHELL_COPY } from "./copy";
import { isNavActive, NAV_ITEMS, type NavItem } from "./nav";
import { useShell } from "./ShellProvider";
import { modKey } from "./shortcuts";

const THEME_ICON = { light: Sun, dark: Moon, system: Monitor } as const;

/** Desktop rail (>= lg). 64px icons; expands to 220px with labels, persisted via data-rail on <html>. */
export function Sidebar() {
  const pathname = usePathname();
  const shell = useShell();
  const { locale } = useLocale();
  const copy = useCopy(SHELL_COPY);
  const expanded = shell.railExpanded;
  const ThemeIcon = THEME_ICON[shell.theme];
  const brand = brandName(locale);

  return (
    <nav
      aria-label={copy.rail.navLabel}
      data-expanded={expanded || undefined}
      className={cn(
        "hidden lg:flex fixed inset-y-0 left-0 z-30 flex-col border-r border-rail-line bg-rail text-rail-ink [--focus:var(--rail-ink)]",
        "w-rail transition-[width] duration-200 ease-out-soft data-expanded:w-rail-open",
      )}
    >
      <div className="flex h-topbar items-center px-3">
        <Link
          href="/"
          className={cn("flex h-9 items-center gap-2.5 rounded-ctl px-1.5 text-rail-ink focus-ring", expanded ? "min-w-0 flex-1" : "justify-center")}
        >
          <BrandMark className="text-rail-accent" />
          {expanded ? <span className="truncate text-md font-semibold tracking-tight">{brand}</span> : <span className="sr-only">{brand}</span>}
        </Link>
      </div>

      <div className="px-2.5 pb-1">
        <button
          type="button"
          onClick={() => shell.openCapture()}
          title={expanded ? undefined : `${copy.actions.capture} (c)`}
          className={cn(
            "flex h-10 w-full items-center gap-2.5 rounded-ctl bg-accent text-accent-ink transition-[filter] hover:brightness-95 focus-ring-offset",
            expanded ? "px-3" : "justify-center",
          )}
        >
          <Plus aria-hidden className="size-5" />
          {expanded ? (
            <>
              <span className="flex-1 text-left text-base font-medium">{copy.actions.capture}</span>
              <Kbd variant="onAccent">c</Kbd>
            </>
          ) : (
            <span className="sr-only">{copy.actions.capture}</span>
          )}
        </button>
      </div>

      <ul className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-2.5 pt-1 scrollbar-thin">
        {NAV_ITEMS.map((item) => (
          <li key={item.id}>
            <RailLink item={item} active={isNavActive(pathname, item.href)} expanded={expanded} badge={item.id === "inbox" ? shell.inboxCount : null} />
          </li>
        ))}
      </ul>

      <div className="flex flex-col gap-0.5 border-t border-rail-line px-2.5 py-2">
        <RailButton
          expanded={expanded}
          label={copy.actions.palette}
          hint={[modKey(), "K"]}
          icon={<Search aria-hidden className="size-5" />}
          onClick={() => shell.openPalette("all")}
        />
        <RailButton expanded={expanded} label={copy.theme.rail[shell.theme]} icon={<ThemeIcon aria-hidden className="size-5" />} onClick={shell.cycleTheme} />
        <RailButton expanded={expanded} label={copy.actions.logout} icon={<LogOut aria-hidden className="size-5" />} onClick={() => void shell.logout()} />
        <RailButton
          expanded={expanded}
          label={expanded ? copy.rail.collapse : copy.rail.expand}
          icon={expanded ? <PanelLeftClose aria-hidden className="size-5" /> : <PanelLeftOpen aria-hidden className="size-5" />}
          onClick={() => shell.setRailExpanded(!expanded)}
          aria-expanded={expanded}
        />
      </div>
    </nav>
  );
}

function RailLink({ item, active, expanded, badge }: { item: NavItem; active: boolean; expanded: boolean; badge: number | null }) {
  const copy = useCopy(SHELL_COPY);
  const label = copy.nav[item.id];
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      title={expanded ? undefined : label}
      className={cn(
        "relative flex h-10 items-center gap-2.5 rounded-ctl transition-colors hover:bg-rail-hover hover:text-rail-ink focus-ring",
        expanded ? "px-3" : "justify-center",
        active ? "bg-rail-hover text-rail-ink" : "text-rail-mute",
      )}
    >
      <Icon aria-hidden className={cn("size-5 shrink-0", active && "text-rail-accent")} />
      {expanded ? <span className="flex-1 truncate text-base">{label}</span> : <span className="sr-only">{label}</span>}
      {badge ? (
        <Badge tone="rail" count={badge} className={cn(!expanded && "absolute right-1.5 top-1.5")} aria-label={copy.rail.pending(badge)} />
      ) : null}
    </Link>
  );
}

function RailButton({
  expanded,
  label,
  hint,
  icon,
  onClick,
  ...rest
}: {
  expanded: boolean;
  label: string;
  hint?: readonly string[];
  icon: React.ReactNode;
  onClick: () => void;
  "aria-expanded"?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={expanded ? undefined : label}
      className={cn(
        "flex h-10 w-full items-center gap-2.5 rounded-ctl text-rail-mute transition-colors hover:bg-rail-hover hover:text-rail-ink focus-ring",
        expanded ? "px-3" : "justify-center",
      )}
      {...rest}
    >
      {icon}
      {expanded ? <span className="flex-1 truncate text-left text-base">{label}</span> : <span className="sr-only">{label}</span>}
      {expanded && hint ? (
        <span aria-hidden className="inline-flex gap-0.5">
          {hint.map((k) => (
            <Kbd key={k} variant="onRail">
              {k}
            </Kbd>
          ))}
        </span>
      ) : null}
    </button>
  );
}

/** @deprecated Use `BrandMark` from `@/components/ui`; kept so the shell index export stays stable. */
export const Mark = BrandMark;
