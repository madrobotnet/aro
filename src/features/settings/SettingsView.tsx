"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useSyncExternalStore } from "react";
import { LANGUAGE_COPY, LanguageSwitch, useCopy } from "@/components/i18n";
import { DocumentTitle } from "@/components/i18n/DocumentTitle";
import { useShell } from "@/components/shell/ShellProvider";
import { modKey } from "@/components/shell/shortcuts";
import type { Theme } from "@/components/shell/ThemeProvider";
import { cn } from "@/components/ui/cn";
import { Shortcut } from "@/components/ui/Kbd";
import { INSTALL_NAME } from "@/lib/brand";
import { AiConnections } from "./AiConnections";
import { ExportSection } from "./ExportSection";
import { ImportSection } from "./ImportSection";
import { AgentsSection } from "./AgentsSection";
import { DiagnosticsSection } from "./DiagnosticsSection";
import { Section, SettingsGroup } from "./SettingsSection";
import { SessionDangerSection, SessionSection } from "./SettingsSession";
import { SETTINGS_COPY } from "./settings-copy";
import { TemplatesSection } from "./TemplatesSection";

export function SettingsView() {
  const copy = useCopy(SETTINGS_COPY);
  return (
    <div className="mx-auto w-full max-w-4xl px-4 pb-12 pt-5 sm:px-6 lg:px-10 lg:pt-10">
      <DocumentTitle title={copy.title} />
      <header className="border-b border-line pb-5">
        <h1 className="text-2xl font-semibold tracking-tight lg:text-3xl">{copy.title}</h1>
        <p className="mt-1 text-sm text-mute">{copy.lead}</p>
      </header>
      <div className="mt-8 space-y-10">
        <SettingsGroup id="settings-account-group" title={copy.groups.account}>
          <SessionSection />
          <AgentsSection />
        </SettingsGroup>
        <SettingsGroup id="settings-display-group" title={copy.groups.display}>
          <ThemeSection />
          <LanguageSection />
          <InstallSection />
        </SettingsGroup>
        <SettingsGroup id="settings-notes-group" title={copy.groups.notes}>
          <TemplatesSection />
          <ShortcutSection />
        </SettingsGroup>
        <SettingsGroup id="settings-ai-group" title={copy.groups.ai}>
          <AiConnections />
        </SettingsGroup>
        <SettingsGroup id="settings-data-group" title={copy.groups.data}>
          <DataSection />
          <ExportSection />
          <ImportSection />
          <DiagnosticsSection />
        </SettingsGroup>
        <SettingsGroup id="settings-danger-group" title={copy.groups.danger} danger>
          <SessionDangerSection />
        </SettingsGroup>
      </div>
    </div>
  );
}

const THEME_OPTIONS: readonly { value: Theme; icon: typeof Sun }[] = [
  { value: "system", icon: Monitor },
  { value: "light", icon: Sun },
  { value: "dark", icon: Moon },
];

function ThemeSection() {
  const { theme, resolvedTheme, setTheme } = useShell();
  const copy = useCopy(SETTINGS_COPY).theme;
  return (
    <Section id="settings-theme" title={copy.title} description={copy.description}>
      <fieldset>
        <legend className="sr-only">{copy.legend}</legend>
        <div className="grid grid-cols-3 gap-1 rounded-card border border-line bg-desk p-1">
          {THEME_OPTIONS.map(({ value, icon: Icon }) => (
            <label
              key={value}
              className={cn(
                "flex min-h-touch cursor-pointer items-center justify-center gap-2 rounded-ctl text-base font-medium transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-focus",
                theme === value ? "bg-card text-ink shadow-card ring-1 ring-line-strong" : "text-mute hover:text-ink",
              )}
            >
              <input type="radio" name="theme" value={value} checked={theme === value} onChange={() => setTheme(value)} className="sr-only" />
              <Icon aria-hidden className="size-4" />
              {copy[value]}
            </label>
          ))}
        </div>
      </fieldset>
      <p className="mt-2 text-sm text-mute" aria-live="polite">
        {theme === "system"
          ? resolvedTheme === "dark" ? copy.systemDark : copy.systemLight
          : theme === "dark" ? copy.alwaysDark : copy.alwaysLight}
      </p>
    </Section>
  );
}

/** Applies instantly in place: no navigation, refresh or remount, so drafts and pending sign-ins stay. */
function LanguageSection() {
  const copy = useCopy(LANGUAGE_COPY);
  return (
    <Section id="settings-language" title={copy.label} description={copy.description}>
      <LanguageSwitch hideLabel />
    </Section>
  );
}

function subscribeDisplayMode(onChange: () => void): () => void {
  const media = window.matchMedia("(display-mode: standalone)");
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}
const readStandalone = () => window.matchMedia("(display-mode: standalone)").matches;

function InstallSection() {
  const standalone = useSyncExternalStore(subscribeDisplayMode, readStandalone, () => null);
  const copy = useCopy(SETTINGS_COPY).install;
  return (
    <Section id="settings-install" title={copy.title} description={copy.description}>
      <p className="text-md">
        {standalone === null ? "\u00a0" : standalone ? copy.standalone : copy.browser}
      </p>
      <ul className="mt-2 flex list-disc flex-col gap-1.5 pl-5 text-sm text-mute">
        <li>{copy.chromium}</li>
        <li>{copy.safari}</li>
        <li>{copy.android(INSTALL_NAME)}</li>
        <li>{copy.offline}</li>
      </ul>
    </Section>
  );
}

function DataSection() {
  const copy = useCopy(SETTINGS_COPY).data;
  return (
    <Section id="settings-data" title={copy.title} description={copy.description}>
      <p className="text-sm text-mute">{copy.body}</p>
    </Section>
  );
}

const readMod = () => modKey();

function ShortcutSection() {
  const mod = useSyncExternalStore(subscribeNever, readMod, () => "Ctrl");
  const copy = useCopy(SETTINGS_COPY).shortcuts;
  const rows: readonly (readonly [readonly string[], string])[] = [
    [[mod, "K"], copy.palette],
    [[mod, "P"], copy.quickOpen],
    [["c"], copy.capture],
    [["/"], copy.search],
    [["g", "h"], copy.home],
    [["g", "i"], copy.inbox],
    [["g", "n"], copy.notes],
    [["g", "t"], copy.tasks],
    [["g", "s"], copy.search],
    [["g", "g"], copy.graph],
    [["g", "c"], copy.chat],
  ];
  return (
    <Section
      id="settings-keys"
      title={copy.title}
      description={copy.description}
      className="max-lg:hidden"
    >
      <dl className="grid grid-cols-2 gap-x-8">
        {rows.map(([keys, label]) => (
          <div key={keys.join("+")} className="flex items-center justify-between gap-3 border-b border-line py-2">
            <dt className="text-base">{label}</dt>
            <dd>
              <span className="sr-only">{keys.join(" ")}</span>
              <Shortcut keys={keys} />
            </dd>
          </div>
        ))}
      </dl>
    </Section>
  );
}

function subscribeNever(): () => void {
  return () => undefined;
}
