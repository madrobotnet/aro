"use client";

import { AlarmClock, Clock, RefreshCw, Undo2 } from "lucide-react";
import { useState } from "react";
import useSWR from "swr";
import { useCopy, useLocale } from "@/components/i18n";
import { Button, EmptyState, SkeletonLines } from "@/components/ui";
import { fetcher } from "@/lib/api-client";
import { localizedApiError } from "@/lib/i18n/api-error";
import { formatDateTime } from "@/lib/i18n/format-date";
import type { InboxItem } from "@/lib/types";
import { INBOX_COPY } from "./inbox-copy";
import { INBOX_LATER_KEY, type InboxListData } from "./inbox-triage";

export function LaterList({ onBringBack }: { onBringBack: (item: InboxItem) => Promise<void> }) {
  const copy = useCopy(INBOX_COPY);
  const { locale } = useLocale();
  const { data, error, isLoading, mutate } = useSWR<InboxListData>(INBOX_LATER_KEY, fetcher, { revalidateOnFocus: true, shouldRetryOnError: false });
  const [busyId, setBusyId] = useState<string | null>(null);

  if (error && !data) {
    return (
      <div role="alert" className="mt-4 rounded-card border border-danger/30 bg-danger-soft p-5">
        <p className="font-medium text-danger">{copy.loadError.title}</p>
        <p className="mt-1 text-sm text-mute">{localizedApiError(error, locale, copy.loadError.help)}</p>
        <Button className="mt-3" size="lg" leading={<RefreshCw aria-hidden className="size-4" />} onClick={() => void mutate()}>
          {copy.loadError.retry}
        </Button>
      </div>
    );
  }

  if (isLoading && !data) {
    return (
      <div className="surface-card mt-4 flex flex-col gap-5 p-4" aria-label={copy.loading} aria-busy="true">
        <SkeletonLines lines={2} />
        <SkeletonLines lines={2} />
      </div>
    );
  }

  const items = data?.items ?? [];
  if (!items.length) {
    return <EmptyState className="mt-4" icon={Clock} title={copy.later.emptyTitle} description={copy.later.emptyDescription} />;
  }

  return (
    <ol aria-label={copy.later.listLabel} className="surface-card mt-4 divide-y divide-line">
      {items.map((item) => (
        <li key={item.id} className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:gap-4">
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium">{item.title}</p>
            <p className="mt-0.5 line-clamp-1 text-sm text-mute">{item.preview || item.url || copy.noContent}</p>
            {item.snoozedUntil ? (
              <p className="mt-1.5 flex items-center gap-1.5 text-xs text-mute">
                <AlarmClock aria-hidden className="size-3.5 shrink-0" />
                {copy.later.returns(formatDateTime(item.snoozedUntil, locale))}
              </p>
            ) : null}
          </div>
          <Button
            className="max-lg:min-h-touch max-sm:w-full"
            leading={<Undo2 aria-hidden className="size-4" />}
            loading={busyId === item.id}
            disabled={busyId !== null}
            onClick={async () => {
              setBusyId(item.id);
              try {
                await onBringBack(item);
              } finally {
                setBusyId(null);
              }
            }}
          >
            {copy.later.bringBack}
          </Button>
        </li>
      ))}
    </ol>
  );
}
