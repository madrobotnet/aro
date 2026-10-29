import { Check, RefreshCw } from "lucide-react";
import { useCopy, useLocale } from "@/components/i18n";
import { Badge, Button, cn, Kbd, Skeleton, SkeletonLines } from "@/components/ui";
import { localizedApiError } from "@/lib/i18n/api-error";
import type { InboxItem } from "@/lib/types";
import { formatCreated, urlStatus, type InboxView as InboxViewName } from "./inbox-triage";
import { INBOX_COPY } from "./inbox-copy";

export function InboxHeading({ count, error, onRetry }: {
  readonly count: number | undefined;
  readonly error: unknown;
  readonly onRetry: () => void;
}) {
  const copy = useCopy(INBOX_COPY);
  const { locale } = useLocale();
  return (
    <>
      <header className="flex flex-col gap-3 border-b border-line pb-5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight lg:text-3xl">{copy.title}</h1>
          <p className="mt-1 text-sm text-mute">{copy.intro}</p>
        </div>
        {count !== undefined ? <Badge className="self-start sm:self-auto" tone={count ? "accent" : "neutral"}>{copy.remaining(count)}</Badge> : null}
      </header>
      {error ? (
        <div role="alert" className="mt-6 rounded-card border border-danger/30 bg-danger-soft p-5">
          <p className="font-medium text-danger">{copy.loadError.title}</p>
          <p className="mt-1 text-sm text-mute">{localizedApiError(error, locale, copy.loadError.help)}</p>
          <Button className="mt-3" size="lg" leading={<RefreshCw aria-hidden className="size-4" />} onClick={onRetry}>
            {copy.loadError.retry}
          </Button>
        </div>
      ) : null}
    </>
  );
}

export function InboxList({ items, selectedId, busy, onSelect }: {
  readonly items: readonly InboxItem[];
  readonly selectedId: string | undefined;
  readonly busy: boolean;
  readonly onSelect: (id: string, keyboard: boolean) => void;
}) {
  const copy = useCopy(INBOX_COPY);
  const { locale } = useLocale();
  return <>
            <ol aria-label={copy.listLabel} className="surface-card max-h-[calc(100dvh-13rem)] divide-y divide-line overflow-y-auto scrollbar-thin">
              {items.map((item) => {
                const active = item.id === selectedId;
                const status = urlStatus(item.body);
                const preview = item.preview;
                return (
                  <li key={item.id}>
                    <button
                      type="button"
                      data-inbox-item={item.id}
                      aria-current={active ? "true" : undefined}
                      disabled={busy}
                      onClick={(event) => onSelect(item.id, event.detail === 0)}
                      className={`min-h-touch w-full px-4 py-3 text-left transition-colors focus-visible:outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--focus)] ${active ? "bg-canvas" : "hover:bg-desk"}`}
                    >
                      <span className="flex items-start justify-between gap-3">
                        <span className="min-w-0 flex-1 truncate font-medium">{item.title}</span>{active ? <Check aria-hidden className="size-4 shrink-0" /> : null}
                        <span className="shrink-0 text-xs text-mute">{formatCreated(item.createdAt, locale)}</span>
                      </span>
                      {preview || item.url ? <span className="mt-1 line-clamp-2 text-sm leading-relaxed text-mute">{preview || item.url}</span> : null}
                      <span className="mt-2 flex flex-wrap items-center gap-1.5">
                        <Badge>{copy.source[item.source]}</Badge>
                        {status === "pending" ? <Badge tone="warn">{copy.badge.urlPending}</Badge> : null}
                        {status === "failed" ? <Badge tone="danger">{copy.badge.urlFailed}</Badge> : null}
                        {item.suggestions?.status === "ready" ? <Badge tone="ok">{copy.badge.suggestionsReady}</Badge> : null}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>
            <TriageKeyHints />
  </>;
}

export function InboxViewSwitch({ view, laterCount, onChange, className }: { view: InboxViewName; laterCount: number; onChange: (view: InboxViewName) => void; className?: string }) {
  const copy = useCopy(INBOX_COPY);
  const options: InboxViewName[] = ["open", "later"];
  return (
    <div role="group" aria-label={copy.views.label} className={cn("grid grid-cols-2 gap-1 rounded-ctl bg-canvas p-1 ring-1 ring-inset ring-line sm:inline-grid", className)}>
      {options.map((option) => {
        const pressed = option === view;
        return (
          <button
            key={option}
            type="button"
            aria-pressed={pressed}
            onClick={() => onChange(option)}
            className={cn(
              "inline-flex min-h-touch items-center justify-center gap-2 rounded-ctl px-4 text-base font-medium transition-[background-color,color,box-shadow] duration-150 focus-ring lg:min-h-9",
              pressed ? "bg-card text-ink shadow-card ring-1 ring-line-strong" : "text-mute hover:text-ink",
            )}
          >
            {copy.views[option]}
            {option === "later" && laterCount > 0 ? <Badge count={laterCount} tone={pressed ? "accent" : "neutral"} /> : null}
          </button>
        );
      })}
    </div>
  );
}

function TriageKeyHints() {
  const copy = useCopy(INBOX_COPY);
  const hints: { keys: string[]; label: string }[] = [
    { keys: ["j", "k"], label: copy.hints.move },
    { keys: ["↵"], label: copy.hints.open },
    { keys: ["1"], label: copy.hints.promote },
    { keys: ["2"], label: copy.hints.discard },
    { keys: ["3"], label: copy.hints.merge },
    { keys: ["H"], label: copy.hints.snooze },
  ];
  return (
    <p className="hidden flex-wrap items-center gap-x-3 gap-y-1.5 px-1 text-xs text-mute lg:flex">
      {hints.map(({ keys, label }) => (
        <span key={label} className="inline-flex items-center gap-1">
          {keys.map((key) => <Kbd key={key}>{key}</Kbd>)} {label}
        </span>
      ))}
    </p>
  );
}

export function InboxSkeleton() {
  const copy = useCopy(INBOX_COPY);
  return (
    <div className="mt-6 grid gap-5 lg:grid-cols-[minmax(17rem,0.8fr)_minmax(0,1.6fr)]" aria-label={copy.loading} aria-busy="true">
      <div className="surface-card flex flex-col gap-5 p-4"><SkeletonLines lines={3} /><SkeletonLines lines={3} /><SkeletonLines lines={3} /></div>
      <div className="surface-card flex flex-col gap-5 p-5"><Skeleton className="h-10 w-full" /><Skeleton className="h-56 w-full" /><SkeletonLines lines={3} /></div>
    </div>
  );
}
