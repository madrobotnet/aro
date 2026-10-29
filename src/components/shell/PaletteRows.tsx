import { Command } from "cmdk";
import { CalendarDays, ChevronRight, FileStack, FileText, Monitor, Moon, Plus, Settings, Sun, Zap } from "lucide-react";
import { useCopy } from "@/components/i18n";
import { Kbd } from "@/components/ui/Kbd";
import type { NoteTemplate } from "@/lib/templates";
import type { NoteRef } from "@/lib/types";
import { keywordsInEveryLocale, SHELL_COPY } from "./copy";
import { NAV_ITEMS } from "./nav";
import type { Theme } from "./theme";

export function TemplateCommands({ templates, loading, failed, onCreate, go }: { templates: NoteTemplate[]; loading: boolean; failed: boolean; onCreate: (template: NoteTemplate) => void; go: (href: string) => void }) {
  const copy = useCopy(SHELL_COPY);
  return (
    <>
      {failed ? (
        <p role="alert" className="px-3 py-3 text-sm text-danger">{copy.palette.templates.loadFailed}</p>
      ) : loading ? (
        <p className="px-3 py-3 text-sm text-mute">{copy.palette.templates.loading}</p>
      ) : templates.length === 0 ? (
        <p className="px-3 py-3 text-sm text-mute">{copy.palette.templates.none}</p>
      ) : (
        <Command.Group heading={copy.palette.groups.templates} className={GROUP}>
          {templates.map((template) => (
            <Command.Item key={template.id} value={`template-${template.id}`} keywords={[template.name]} onSelect={() => onCreate(template)} className={ITEM}>
              <FileStack aria-hidden className={ICON} />
              <span className="flex-1 truncate">{template.name}</span>
            </Command.Item>
          ))}
        </Command.Group>
      )}
      <Command.Group className={GROUP}>
        <Command.Item
          value="manage-templates"
          keywords={keywordsInEveryLocale((c) => c.palette.templates.manage)}
          onSelect={() => go("/settings#settings-templates")}
          className={ITEM}
        >
          <Settings aria-hidden className={ICON} />
          <span className="flex-1">{copy.palette.templates.manage}</span>
        </Command.Item>
      </Command.Group>
    </>
  );
}

export function NoteCommands({ notes, recent, canCreate, query, go, onCreate }: { notes: NoteRef[]; recent: boolean; canCreate: boolean; query: string; go: (href: string) => void; onCreate: (title: string) => void }) {
  const copy = useCopy(SHELL_COPY);
  return (
    <Command.Group heading={recent ? copy.palette.groups.recent : copy.palette.groups.notes} className={GROUP}>
      {notes.map((note) => (
        <Command.Item key={note.id} value={`note-${note.id}`} keywords={[note.title, query]} onSelect={() => go(`/notes/${note.id}`)} className={ITEM}>
          <FileText aria-hidden className={ICON} />
          <span className="flex-1 truncate">{note.title}</span>
        </Command.Item>
      ))}
      {canCreate ? (
        <Command.Item
          value={`create-${query}`}
          keywords={[query, ...keywordsInEveryLocale((c) => c.palette.newNote)]}
          onSelect={() => onCreate(query)}
          className={ITEM}
        >
          <Plus aria-hidden className={ICON} />
          <span className="flex-1 truncate">{copy.palette.createNamed(query)}</span>
        </Command.Item>
      ) : null}
    </Command.Group>
  );
}

export function RootCommands({ onCapture, onNewNote, onTemplates, onDaily, go, theme, onTheme }: {
  readonly onCapture: () => void;
  readonly onNewNote: () => void;
  readonly onTemplates: () => void;
  readonly onDaily: () => void;
  readonly go: (href: string) => void;
  readonly theme: Theme;
  readonly onTheme: (theme: Theme) => void;
}) {
  const copy = useCopy(SHELL_COPY);
  return (
    <>
      <Command.Group heading={copy.palette.groups.actions} className={GROUP}>
        <Command.Item
          value="capture"
          keywords={[...keywordsInEveryLocale((c) => c.actions.capture, (c) => c.palette.keywords.capture), "c"]}
          onSelect={onCapture}
          className={ITEM}
        >
          <Zap aria-hidden className={ICON} />
          <span className="flex-1">{copy.actions.capture}</span>
          <Hint keys={["c"]} />
        </Command.Item>
        <Command.Item
          value="new-note"
          keywords={keywordsInEveryLocale((c) => c.palette.newNote, (c) => c.palette.keywords.newNote)}
          onSelect={onNewNote}
          className={ITEM}
        >
          <Plus aria-hidden className={ICON} />
          <span className="flex-1">{copy.palette.newNote}</span>
        </Command.Item>
        <Command.Item
          value="new-from-template"
          keywords={keywordsInEveryLocale((c) => c.palette.newFromTemplate, (c) => c.palette.keywords.template)}
          onSelect={onTemplates}
          className={ITEM}
        >
          <FileStack aria-hidden className={ICON} />
          <span className="flex-1">{copy.palette.newFromTemplate}</span>
          <ChevronRight aria-hidden className={ICON} />
        </Command.Item>
        <Command.Item
          value="daily"
          keywords={keywordsInEveryLocale((c) => c.palette.openDaily, (c) => c.palette.keywords.daily)}
          onSelect={onDaily}
          className={ITEM}
        >
          <CalendarDays aria-hidden className={ICON} />
          <span className="flex-1">{copy.palette.openDaily}</span>
        </Command.Item>
      </Command.Group>
      <Command.Group heading={copy.palette.groups.go} className={GROUP}>
        {NAV_ITEMS.map((item) => (
          <Command.Item
            key={item.id}
            value={`go-${item.id}`}
            keywords={[...keywordsInEveryLocale((c) => c.nav[item.id]), item.id, item.href]}
            onSelect={() => go(item.href)}
            className={ITEM}
          >
            <item.icon aria-hidden className={ICON} />
            <span className="flex-1">{copy.nav[item.id]}</span>
            {item.goKey ? <Hint keys={["g", item.goKey]} /> : null}
          </Command.Item>
        ))}
      </Command.Group>
      <Command.Group heading={copy.palette.groups.theme} className={GROUP}>
        {(
          [
            ["light", Sun],
            ["dark", Moon],
            ["system", Monitor],
          ] as const
        ).map(([value, Icon]) => (
          <Command.Item
            key={value}
            value={`theme-${value}`}
            keywords={[...keywordsInEveryLocale((c) => c.palette.keywords.theme, (c) => c.theme.palette[value]), value]}
            onSelect={() => onTheme(value)}
            className={ITEM}
          >
            <Icon aria-hidden className={ICON} />
            <span className="flex-1">{copy.theme.palette[value]}</span>
            {theme === value ? <span className="text-xs text-mute">{copy.palette.current}</span> : null}
          </Command.Item>
        ))}
      </Command.Group>
    </>
  );
}

const GROUP =
  "[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-mute";
const ITEM =
  "flex h-touch cursor-pointer select-none items-center gap-2.5 rounded-ctl px-2.5 text-base text-ink data-[selected=true]:bg-accent-soft data-[selected=true]:text-ink aria-disabled:opacity-50 lg:h-10";
const ICON = "size-4 shrink-0 text-mute";

function Hint({ keys }: { keys: readonly string[] }) {
  return (
    <span aria-hidden className="hidden items-center gap-0.5 sm:inline-flex">
      {keys.map((k, i) => (
        <Kbd key={`${k}-${i}`}>{k}</Kbd>
      ))}
    </span>
  );
}
