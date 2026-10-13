"use client";

import Link from "next/link";
import Form from "next/form";
import { useSearchParams } from "next/navigation";
import { Search } from "lucide-react";
import useSWR from "swr";
import type { SearchHit, SearchResponse } from "@/lib/types";
import { fetcher } from "@/lib/api-client";
import { localizedApiError } from "@/lib/i18n/api-error";
import { formatDateTime } from "@/lib/i18n/format-date";
import { useCopy, useLocale } from "@/components/i18n";
import { DocumentTitle } from "@/components/i18n/DocumentTitle";
import { Button, EmptyState, Input, SkeletonLines, TagBadge } from "@/components/ui";
import { SEARCH_COPY } from "./search-copy";
import { highlightSegments, matchLabel, searchApiUrl, searchUrl } from "./search-model";
import { sourceNoteUrl } from "./source-passage";
import { displayNoteTitle } from "@/features/notes/display-title";
import { isDayKey, monthOf } from "@/features/notes/daily-date";
import { useDailyMonth } from "@/features/notes/daily-month";

const PAGE = "mx-auto w-full max-w-6xl px-4 pb-12 pt-5 sm:px-6 lg:px-10 lg:pt-10";

/** Suspense fallback for the search route; a client component so it follows a language switch. */
export function SearchPageFallback() {
  const copy = useCopy(SEARCH_COPY);
  return <div className={`${PAGE} text-sm text-mute`}>{copy.loading}</div>;
}

function Highlighted({ text, query }: { text: string; query: string }) {
  return highlightSegments(text, query).map((segment, index) =>
    segment.hit ? (
      <mark key={index} className="rounded-sm bg-accent-soft text-ink">{segment.text}</mark>
    ) : (
      segment.text
    ),
  );
}

/** Search DTOs keep their contract: confirm a date-title hit against existing daily metadata. */
function SearchResultTitle({ hit, query }: { readonly hit: SearchHit; readonly query: string }) {
  const { locale } = useLocale();
  const copy = useCopy(SEARCH_COPY);
  const { notes } = useDailyMonth(isDayKey(hit.title) ? monthOf(hit.title) : null);
  const dailyDate = notes.get(hit.title) === hit.noteId ? hit.title : null;
  const title = displayNoteTitle({ title: hit.title, dailyDate }, locale);
  return title ? <Highlighted text={title} query={query} /> : copy.untitled;
}

export function SearchPage() {
  const params = useSearchParams();
  const { locale } = useLocale();
  const copy = useCopy(SEARCH_COPY);
  const query = (params.get("q") ?? "").trim();
  const tag = (params.get("tag") ?? "").trim().replace(/^#/, "");
  const url = searchApiUrl(query, tag);
  const { data, error, isLoading, mutate } = useSWR<SearchResponse>(url, fetcher, { shouldRetryOnError: false });

  return (
    <section className={PAGE}>
      <DocumentTitle title={copy.title} />
      <div className="max-w-3xl space-y-6">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight lg:text-3xl">{copy.title}</h1>
          <p className="mt-1 text-sm text-mute">{copy.description}</p>
        </header>
        <Form action="/search" scroll={false}>
          <fieldset key={params.toString()} className="space-y-3">
            <div className="flex items-end gap-2">
              <Input
                name="q" label={copy.form.queryLabel} data-search-input autoFocus
                defaultValue={query} maxLength={500} placeholder={copy.form.queryPlaceholder}
                leading={<Search aria-hidden />}
                wrapperClassName="min-w-0 flex-1" className="min-h-touch"
              />
              <Button type="submit" size="lg">{copy.form.submit}</Button>
            </div>
            <div className="flex flex-wrap items-end gap-3">
              <Input name="tag" label={copy.form.tagLabel} defaultValue={tag} maxLength={100}
                placeholder={copy.form.tagPlaceholder} wrapperClassName="w-full max-w-xs" className="min-h-touch" />
              {tag ? <Link href={searchUrl(query, "")} scroll={false}
                className="inline-flex min-h-touch items-center text-sm text-accent">{copy.form.clearTag}</Link> : null}
            </div>
          </fieldset>
        </Form>
        {data?.semanticIndex ? (
          <p role="status" className="space-y-1 rounded-ctl bg-desk px-3 py-2 text-sm text-mute">
            <span className="block text-ink">{copy.index.states[data.semanticIndex.state]}</span>
            <span className="block tabular-nums">{copy.index.progress(data.semanticIndex.indexedNotes, data.semanticIndex.totalNotes)}</span>
            {data.semanticIndex.state !== "ready" ? <span className="block">{copy.index.lexical}</span> : null}
          </p>
        ) : null}
        <div aria-live="polite" aria-busy={isLoading}>
          {!query ? (
            <EmptyState title={copy.idle.title} description={copy.idle.description} />
          ) : isLoading ? (
            <SkeletonLines lines={4} />
          ) : error ? (
            <EmptyState title={copy.error.title} description={localizedApiError(error, locale, copy.error.fallback)}
              action={<Button onClick={() => void mutate()} variant="secondary">{copy.error.retry}</Button>} />
          ) : data?.hits.length === 0 ? (
            <EmptyState title={copy.empty.title} description={copy.empty.description} />
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-mute">{copy.resultCount(data?.hits.length ?? 0)}</p>
              {data?.hits.map((hit) => {
                const signals = matchLabel(hit, locale);
                return (
                  <article key={hit.noteId} className="rounded-card border border-line bg-card p-4 shadow-card">
                    <Link className="block rounded-ctl focus-ring" href={sourceNoteUrl(hit.noteId, hit.passage, hit.updatedAt)} scroll={hit.passage ? false : undefined}>
                      <h2 className="text-lg font-medium text-ink">
                        <SearchResultTitle hit={hit} query={query} />
                      </h2>
                      {hit.passage ? <p className="mt-1 text-xs text-accent">{copy.passage(hit.passage.heading, hit.passage.startLine, hit.passage.endLine)}</p> : null}
                      <p className="mt-2 whitespace-pre-wrap text-sm text-mute">
                        <Highlighted text={hit.snippet} query={query} />
                      </p>
                    </Link>
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      {hit.tags.map((item) => (
                        <Link key={item} href={searchUrl(query, item)} scroll={false}
                          aria-label={copy.searchTag(item)} className="inline-flex min-h-touch items-center rounded-ctl focus-ring">
                          <TagBadge tag={item} />
                        </Link>
                      ))}
                      <div className="ml-auto flex flex-wrap items-center justify-end gap-x-2 text-xs text-mute">
                        {signals.length ? (
                          <>
                            <p>{signals.join(", ")}</p>
                            <span aria-hidden>·</span>
                          </>
                        ) : null}
                        <time dateTime={hit.updatedAt}>{formatDateTime(hit.updatedAt, locale)}</time>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
