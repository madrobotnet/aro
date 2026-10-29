"use client";

import { Eraser, Inbox, Link2, Save } from "lucide-react";
import { useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useSWRConfig } from "swr";
import { useCopy, useLocale } from "@/components/i18n";
import { modKey } from "@/components/shell/shortcuts";
import { Button, Dialog, Input, Shortcut, Textarea, useToast } from "@/components/ui";
import { api } from "@/lib/api-client";
import { localizedApiError } from "@/lib/i18n/api-error";
import { textInEveryLocale } from "@/lib/i18n/copy";
import type { InboxItem } from "@/lib/types";
import { INBOX_KEY, type InboxListData, withItem } from "@/features/inbox/inbox-triage";
import { CAPTURE_COPY } from "./capture-copy";
import { buildCapturePayload, EMPTY_DRAFT, isDraftEmpty, type CaptureDraft, type CaptureInvalidReason } from "./capture-form";

/**
 * CONTRACT (owned by the inbox lane): quick-capture dialog.
 * The shell renders <CaptureDialog open onOpenChange /> and opens it from the
 * capture button, the command palette, and the "c" / Ctrl+Shift+Space shortcut.
 */
export type CaptureDialogProps = { open: boolean; onOpenChange: (open: boolean) => void };

/** Locale-neutral: validation keys and the retained API failure re-render after a language switch. */
type CaptureErrors = { text?: CaptureInvalidReason; url?: CaptureInvalidReason; form?: { cause: unknown } };

export function CaptureDialog({ open, onOpenChange }: CaptureDialogProps) {
  const [draft, setDraft] = useState<CaptureDraft>(EMPTY_DRAFT);
  const [errors, setErrors] = useState<CaptureErrors>({});
  const [saving, setSaving] = useState(false);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const revisionRef = useRef(0);
  const { mutate } = useSWRConfig();
  const { toast } = useToast();
  const { locale } = useLocale();
  const copy = useCopy(CAPTURE_COPY);

  const update = (field: keyof CaptureDraft, value: string) => {
    revisionRef.current += 1;
    setDraft((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined, form: undefined }));
  };

  const clear = () => {
    if (!isDraftEmpty(draft) && !window.confirm(copy.confirmClear)) return;
    revisionRef.current += 1;
    setDraft(EMPTY_DRAFT);
    setErrors({});
    textRef.current?.focus();
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const built = buildCapturePayload(draft);
    if (!built.ok) {
      setErrors(built.field === "text" ? { text: built.reason } : { url: built.reason });
      return;
    }
    const submittedRevision = revisionRef.current;
    setSaving(true);
    setErrors({});
    try {
      const { item } = await api<{ item: InboxItem }>("/api/capture", { method: "POST", json: built.payload });
      void mutate(INBOX_KEY, (current: InboxListData | undefined) => withItem(current, item), { revalidate: true });
      void mutate("/api/home");
      const draftUnchanged = revisionRef.current === submittedRevision;
      if (draftUnchanged) {
        revisionRef.current += 1;
        setDraft(EMPTY_DRAFT);
        onOpenChange(false);
      }
      toast(textInEveryLocale((locale) => CAPTURE_COPY[locale][draftUnchanged ? "saved" : "savedKeptDraft"]), { tone: "ok" });
    } catch (cause) {
      setErrors({ form: { cause } });
    } finally {
      setSaving(false);
    }
  };

  const onFormKeyDown = (event: ReactKeyboardEvent<HTMLFormElement>) => {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      event.currentTarget.requestSubmit();
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      dismissible={!saving}
      title={copy.title}
      description={copy.description}
      initialFocusRef={textRef}
      footer={
        <>
          {!isDraftEmpty(draft) ? (
            <Button variant="ghost" leading={<Eraser aria-hidden className="size-4" />} disabled={saving} onClick={clear} className="mr-auto">
              {copy.clear}
            </Button>
          ) : null}
          <Button variant="ghost" disabled={saving} onClick={() => onOpenChange(false)}>
            {copy.close}
          </Button>
          <Shortcut keys={[modKey(), "↵"]} className="max-sm:hidden" />
          <Button
            variant="primary"
            loading={saving}
            aria-keyshortcuts="Control+Enter Meta+Enter"
            leading={<Save aria-hidden className="size-4" />}
            onClick={() => textRef.current?.form?.requestSubmit()}
          >
            {copy.save}
          </Button>
        </>
      }
    >
      <form noValidate className="flex flex-col gap-4" onSubmit={submit} onKeyDown={onFormKeyDown}>
        <Textarea
          ref={textRef}
          label={copy.textLabel}
          rows={7}
          value={draft.text}
          onChange={(event) => update("text", event.target.value)}
          placeholder={copy.textPlaceholder}
          error={errors.text ? copy.invalid[errors.text] : undefined}
          disabled={saving}
          className="min-h-36"
        />
        <Input
          label={copy.urlLabel}
          type="url"
          inputMode="url"
          value={draft.url}
          onChange={(event) => update("url", event.target.value)}
          placeholder="https://example.com/article"
          error={errors.url ? copy.invalid[errors.url] : undefined}
          disabled={saving}
          leading={<Link2 aria-hidden />}
        />
        <Input
          label={copy.titleLabel}
          value={draft.title}
          onChange={(event) => update("title", event.target.value)}
          placeholder={copy.titlePlaceholder}
          disabled={saving}
          leading={<Inbox aria-hidden />}
        />
        {errors.form ? (
          <p role="alert" className="rounded-ctl border border-danger/30 bg-danger-soft px-3 py-2 text-sm text-danger">
            {localizedApiError(errors.form.cause, locale, copy.saveFailed)}
          </p>
        ) : null}
      </form>
    </Dialog>
  );
}
