import { CalendarDays } from "lucide-react";
import Link from "next/link";
import { useCopy, useLocale } from "@/components/i18n";
import { Button, buttonClassName } from "@/components/ui/Button";
import type { NoteSummary } from "@/lib/types";
import { HOME_COPY } from "./home-copy";
import { formatDateKey } from "./use-local-date";

export function TodaySection({
  today,
  daily,
  busy,
  disabled,
  onCreate,
}: {
  readonly today: string | null;
  readonly daily: NoteSummary | null;
  readonly busy: boolean;
  readonly disabled: boolean;
  readonly onCreate: () => void;
}) {
  const { locale } = useLocale();
  const copy = useCopy(HOME_COPY).today;
  return (
    <section aria-labelledby="home-today" className="rounded-card border border-line bg-accent-soft/60 px-4 py-4 sm:px-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="min-w-0 flex-1">
          <h2 id="home-today" className="flex items-center gap-2 text-sm font-medium text-mute">
            <CalendarDays aria-hidden className="size-4" />
            {copy.title}
            {today ? <span className="text-ink">{formatDateKey(today, locale, { weekday: false })}</span> : null}
          </h2>
          {daily && daily.title === daily.dailyDate ? (
            // The default daily title is the date the heading already shows, so lead with the excerpt.
            <p className="mt-1 line-clamp-2 text-md text-ink">{daily.excerpt || copy.emptyExcerpt}</p>
          ) : daily ? (
            <>
              <p className="mt-1 truncate text-lg font-semibold tracking-tight">{daily.title}</p>
              <p className="mt-0.5 line-clamp-2 text-sm text-mute">{daily.excerpt || copy.emptyExcerpt}</p>
            </>
          ) : (
            <p className="mt-1 text-md text-ink">{copy.prompt}</p>
          )}
        </div>
        {daily ? (
          <Link href={`/notes/${daily.id}`} className={buttonClassName({ variant: "primary", size: "lg" })}>
            {copy.continue}
          </Link>
        ) : (
          <Button variant="primary" size="lg" loading={busy} disabled={disabled} onClick={onCreate}>
            {copy.create}
          </Button>
        )}
      </div>
    </section>
  );
}
