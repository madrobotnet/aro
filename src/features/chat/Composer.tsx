import { Send, Square } from "lucide-react";
import type { KeyboardEvent } from "react";
import { useCopy } from "@/components/i18n";
import { Button, Textarea } from "@/components/ui";
import { CHAT_COPY } from "./copy";

export function Composer({ draft, setDraft, send, stop, streaming, available }: { draft: string; setDraft: (value: string) => void; send: (value: string) => Promise<void>; stop: () => void; streaming: boolean; available: boolean }) {
  const copy = useCopy(CHAT_COPY);
  const submit = () => { if (available && !streaming && draft.trim()) void send(draft); };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) { event.preventDefault(); submit(); }
  };
  return (
    <div className="border-t border-line bg-card px-3 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-6 lg:px-10"><div className="mx-auto flex max-w-3xl items-end gap-2">
      <Textarea aria-label={copy.composerLabel} value={draft} rows={2} maxLength={8000} disabled={!available || streaming} placeholder={copy.composerPlaceholder} hint={available ? <span className="hidden sm:inline">{copy.composerHint}</span> : undefined} wrapperClassName="min-w-0 flex-1" className="max-h-36 min-h-touch resize-none" onChange={(event) => setDraft(event.target.value)} onKeyDown={onKeyDown} />
      {streaming ? <Button variant="danger" size="lg" iconOnly aria-label={copy.stop} title={copy.stop} onClick={stop}><Square aria-hidden className="size-4 fill-current" /></Button> : <Button variant="primary" size="lg" iconOnly aria-label={copy.send} title={copy.send} disabled={!available || !draft.trim()} onClick={submit}><Send aria-hidden className="size-4" /></Button>}
    </div></div>
  );
}
