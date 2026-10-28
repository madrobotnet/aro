import { BookOpen, MoreHorizontal } from "lucide-react";
import Link from "next/link";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useCopy, useLocale } from "@/components/i18n";
import { Button, cn } from "@/components/ui";
import type { ChatMessage, Citation } from "@/lib/types";
import { failureMessage, partitionCitations } from "./chat-model";
import { CHAT_COPY } from "./copy";
import type { Exchange } from "./use-chat-thread";

export function Message({ message }: { message: ChatMessage }) {
  const copy = useCopy(CHAT_COPY);
  const assistant = message.role === "assistant";
  return (
    <article aria-label={assistant ? copy.assistantLabel : copy.userLabel} className={cn("flex", assistant ? "justify-start" : "justify-end")}>
      <div className={cn("max-w-[92%] sm:max-w-[82%]", assistant ? "w-full" : "rounded-card bg-accent px-4 py-3 text-accent-ink")}>
        {assistant ? <p className="mb-1 text-xs font-medium text-mute">{copy.assistantLabel}</p> : null}
        {assistant ? <SafeMarkdown content={message.content} /> : <p className="whitespace-pre-wrap text-md leading-relaxed">{message.content}</p>}
        {assistant && message.citations.length > 0 ? <Sources citations={message.citations} answer={message.content} /> : null}
      </div>
    </article>
  );
}

function SafeMarkdown({ content }: { content: string }) {
  const copy = useCopy(CHAT_COPY);
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{
      h1: ({ children }) => <h2 className="mb-2 mt-4 text-xl font-semibold first:mt-0">{children}</h2>,
      h2: ({ children }) => <h3 className="mb-2 mt-4 text-lg font-semibold first:mt-0">{children}</h3>,
      h3: ({ children }) => <h4 className="mb-1 mt-3 text-md font-semibold first:mt-0">{children}</h4>,
      p: ({ children }) => <p className="my-2 text-read first:mt-0 last:mb-0">{children}</p>,
      ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5 text-read">{children}</ul>,
      ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-5 text-read">{children}</ol>,
      blockquote: ({ children }) => <blockquote className="my-3 border-l-2 border-line-strong pl-3 text-mute">{children}</blockquote>,
      code: ({ children, className }) => className ? <code className={cn("block overflow-x-auto rounded-ctl bg-rail p-3 text-sm text-rail-ink scrollbar-thin", className)}>{children}</code> : <code className="rounded bg-line/60 px-1 py-0.5 text-sm">{children}</code>,
      pre: ({ children }) => <pre className="my-3 overflow-x-auto">{children}</pre>,
      a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer" className="rounded-sm font-medium text-accent underline underline-offset-2 focus-ring">{children}</a>,
      img: ({ alt }) => <span className="text-sm text-mute">{alt ?? copy.imageFallback}</span>,
      table: ({ children }) => <div className="my-3 overflow-x-auto"><table className="w-full border-collapse text-sm">{children}</table></div>,
      th: ({ children }) => <th className="border border-line bg-desk px-2 py-1.5 text-left font-semibold">{children}</th>,
      td: ({ children }) => <td className="border border-line px-2 py-1.5 align-top">{children}</td>,
    }}>{content}</ReactMarkdown>
  );
}

/**
 * Retrieved sources under an answer. With the settled `answer` text, the sources it cites with [n]
 * markers come first as cards and the rest of the retrieved notes follow as a quieter list; while
 * an answer is still streaming (no `answer`), every source stays a card so nothing reshuffles mid-read.
 */
function Sources({ citations, answer }: { citations: Citation[]; answer?: string }) {
  const copy = useCopy(CHAT_COPY);
  const { cited, others } = answer === undefined ? { cited: citations, others: [] } : partitionCitations(answer, citations);
  return (
    <section aria-label={copy.sources} className="mt-4 border-t border-line pt-3">
      <h3 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-mute"><BookOpen aria-hidden className="size-4" />{copy.sources}</h3>
      <div className="grid gap-2 sm:grid-cols-2">
        {cited.map((citation) => <Link key={`${citation.index}-${citation.noteId}`} href={`/notes/${citation.noteId}`} className="surface-desk group min-w-0 p-3 hover:bg-card hover:shadow-card focus-ring"><span className="text-xs font-medium text-accent">{copy.sourceLabel(citation.index)}</span><p className="mt-0.5 truncate text-sm font-semibold group-hover:text-accent">{citation.title}</p>{citation.excerpt ? <p className="mt-1 line-clamp-3 text-xs text-mute">{citation.excerpt}</p> : null}<span className="mt-2 inline-block text-xs font-medium text-mute">{copy.sourceOpen}</span></Link>)}
      </div>
      {others.length > 0 ? (
        <div className="mt-3">
          <h4 className="mb-1 px-2 text-xs font-medium text-mute">{copy.sourcesAlso}</h4>
          <ul className="grid gap-x-2 sm:grid-cols-2">
            {others.map((citation) => (
              <li key={`${citation.index}-${citation.noteId}`} className="min-w-0">
                <Link href={`/notes/${citation.noteId}`} className="flex min-h-touch items-center rounded-ctl px-2 text-sm text-mute hover:bg-desk hover:text-ink focus-ring sm:min-h-9">
                  <span className="truncate">{citation.title}</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

export function PendingExchange({ exchange }: { exchange: Exchange }) {
  const copy = useCopy(CHAT_COPY);
  return (
    <><Message message={{ id: "pending-user", role: "user", content: exchange.content, citations: [], createdAt: "" }} /><article aria-label={copy.assistantLabel} className="w-full" aria-live="polite">
      {exchange.text ? <><p className="mb-1 text-xs font-medium text-mute">{copy.assistantLabel}</p>{exchange.phase === "failed" ? <p className="mb-2 text-xs font-medium text-warn">{copy.partialAnswer}</p> : null}<SafeMarkdown content={exchange.text} />{exchange.citations.length > 0 ? <Sources citations={exchange.citations} /> : null}</> : exchange.phase === "streaming" ? <div className="flex items-center gap-2 text-sm text-mute"><MoreHorizontal aria-hidden className="size-5 animate-pulse" />{exchange.citations.length ? copy.streaming : copy.thinking}</div> : null}

    </article></>
  );
}


export function ExchangeFailure({ exchange, onDismiss, onResend }: { exchange: Exchange; onDismiss: () => void; onResend: () => void }) {
  const { locale } = useLocale();
  const copy = useCopy(CHAT_COPY);
  return <div role="alert" className="rounded-card border border-danger/30 bg-danger-soft px-4 py-3"><p className="font-medium text-danger">{copy.failedTitle}</p><p className="mt-1 text-sm">{exchange.failure ? failureMessage(exchange.failure, locale) : null}</p><p className="mt-1 text-xs text-mute">{copy.failedDraftKept}</p><div className="mt-3 flex gap-2"><Button size="sm" onClick={onDismiss}>{copy.dismiss}</Button><Button variant="primary" size="sm" onClick={onResend}>{copy.resend}</Button></div></div>;
}
