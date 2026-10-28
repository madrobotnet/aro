"use client";

import { FileSearch } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useCopy, useLocale } from "@/components/i18n";
import { Button, Input } from "@/components/ui";
import { api, ApiClientError } from "@/lib/api-client";
import { localizedApiError } from "@/lib/i18n/api-error";
import { IMPORT_COPY } from "./import-copy";
import { ImportPreviewView, ImportReceiptView } from "./ImportViews";
import type { ImportPreview, ImportReceipt } from "@/lib/import-types";
import { Section } from "./SettingsSection";

const MAX_UPLOAD_BYTES = 24 * 1024 * 1024;

type ImportFailure = {
  readonly operation: "preview" | "commit";
  readonly cause: unknown;
};

export function ImportSection() {
  const copy = useCopy(IMPORT_COPY);
  const { locale } = useLocale();
  const inputRef = useRef<HTMLInputElement>(null);
  // Revisions invalidate responses; active serializes requests even before React renders.
  const request = useRef<{ revision: number; active: number | null }>({ revision: 0, active: null });
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<"fileType" | "fileSize" | "fileEmpty" | null>(null);
  const [pending, setPending] = useState<"preview" | "commit" | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [receipt, setReceipt] = useState<ImportReceipt | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [failure, setFailure] = useState<ImportFailure | null>(null);
  const busy = pending !== null;
  const blocked = preview !== null && (!preview.canCommit || preview.conflicts.length > 0 || preview.notes.length === 0);

  useEffect(() => () => {
    request.current.revision += 1;
    request.current.active = null;
  }, []);

  const selectFile = (next: File | null) => {
    request.current.revision += 1;
    setPreview(null);
    setReceipt(null);
    setConfirmed(false);
    setFailure(null);
    const error = next
      ? !/\.(md|markdown|zip)$/i.test(next.name) ? "fileType"
        : next.size > MAX_UPLOAD_BYTES ? "fileSize"
          : next.size === 0 ? "fileEmpty" : null
      : null;
    setFileError(error);
    setFile(error ? null : next);
  };

  const previewFile = async () => {
    if (!file || request.current.active !== null) return;
    const revision = ++request.current.revision;
    request.current.active = revision;
    setPending("preview");
    setPreview(null);
    setReceipt(null);
    setConfirmed(false);
    setFailure(null);
    try {
      const result = await api<ImportPreview>("/api/import/preview", {
        method: "POST",
        body: file,
        headers: {
          "Content-Type": "application/octet-stream",
          "x-import-filename": encodeURIComponent(file.name),
        },
      });
      if (request.current.revision === revision) setPreview(result);
    } catch (cause) {
      if (request.current.revision === revision) setFailure({ operation: "preview", cause });
    } finally {
      if (request.current.active === revision) {
        request.current.active = null;
        setPending(null);
      }
    }
  };

  const commitFile = async () => {
    if (!file || !preview || blocked || !confirmed || request.current.active !== null) return;
    const revision = ++request.current.revision;
    request.current.active = revision;
    setPending("commit");
    setFailure(null);
    try {
      const result = await api<ImportReceipt>("/api/import/commit", {
        method: "POST",
        body: file,
        headers: {
          "Content-Type": "application/octet-stream",
          "x-import-filename": encodeURIComponent(file.name),
          "x-import-digest": preview.digest,
          "x-import-confirm": "true",
        },
      });
      if (request.current.revision === revision) setReceipt(result);
    } catch (cause) {
      if (request.current.revision === revision) setFailure({ operation: "commit", cause });
    } finally {
      if (request.current.revision === revision) {
        // A commit attempt consumes the preview, including when its outcome is uncertain.
        setPreview(null);
        setConfirmed(false);
      }
      if (request.current.active === revision) {
        request.current.active = null;
        setPending(null);
      }
    }
  };

  const failureMessage = failure?.operation === "commit"
    ? failure.cause instanceof ApiClientError && failure.cause.status < 500 ? copy.importFailed : copy.uncertain
    : copy.previewFailed;

  return (
    <Section id="settings-import" title={copy.title} description={copy.description}>
      <div className="surface-card min-w-0 px-4 py-4 sm:px-5">
        <p className="mb-4 text-sm text-mute">{copy.scope}</p>
        <Input
          ref={inputRef}
          type="file"
          accept=".md,.markdown,.zip"
          label={copy.fileLabel}
          hint={copy.fileHint}
          error={fileError ? copy[fileError] : undefined}
          disabled={busy}
          className="h-auto min-h-touch py-2 text-sm file:mr-3 file:rounded-ctl file:border-0 file:bg-desk file:px-3 file:py-2 file:text-sm file:font-medium file:text-ink"
          onChange={(event) => selectFile(event.target.files?.[0] ?? null)}
        />
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            size="lg"
            loading={pending === "preview"}
            disabled={!file || busy}
            leading={<FileSearch aria-hidden className="size-4" />}
            onClick={() => void previewFile()}
          >
            {copy.preview}
          </Button>
          <Button size="lg" variant="ghost" disabled={busy} onClick={() => {
            selectFile(null);
            if (inputRef.current) inputRef.current.value = "";
            inputRef.current?.focus();
          }}>
            {copy.clear}
          </Button>
        </div>
        <p role="status" aria-atomic="true" className="mt-3 text-sm text-mute">
          {pending === "preview" ? copy.previewing : pending === "commit" ? copy.committing
            : receipt ? copy.imported : preview ? copy.previewReady : null}
        </p>

        {failure ? (
          <div role="alert" className="mt-3 space-y-2 rounded-ctl bg-danger-soft px-3 py-2 text-sm text-danger">
            <p>{failureMessage}</p>
            {failure.cause instanceof ApiClientError ? (
              <p className="whitespace-pre-wrap break-words">
                {localizedApiError(failure.cause, locale, failure.cause.message)} ({failure.cause.code})
              </p>
            ) : null}
          </div>
        ) : null}

        {preview ? <ImportPreviewView preview={preview} blocked={blocked} confirmed={confirmed} busy={busy} pending={pending}
          onConfirm={setConfirmed} onImport={() => void commitFile()} /> : null}
        {receipt ? <ImportReceiptView receipt={receipt} /> : null}

      </div>
    </Section>
  );
}
