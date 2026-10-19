"use client";

import { FileSearch, Upload } from "lucide-react";
import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { useCopy, useLocale } from "@/components/i18n";
import { Button, Input } from "@/components/ui";
import { api, ApiClientError } from "@/lib/api-client";
import { localizedApiError } from "@/lib/i18n/api-error";
import { defineCopy } from "@/lib/i18n/copy";
import type { ImportPreview, ImportReceipt } from "@/lib/import-types";
import { Section } from "./SettingsSection";

const MAX_UPLOAD_BYTES = 24 * 1024 * 1024;

const IMPORT_COPY = defineCopy({
  ko: {
    title: "노트 가져오기",
    description: "Markdown 파일이나 ZIP에서 노트와 로컬 첨부 파일만 가져옵니다.",
    scope: "수집함, 채팅, 설정, 휴지통은 가져오지 않습니다. 전체 상태를 복원하는 기능이 아닙니다.",
    fileLabel: "가져올 파일",
    fileHint: ".md, .markdown, .zip 파일 하나, 최대 24 MiB. 먼저 미리보기로 내용을 확인하세요.",
    fileType: ".md, .markdown, .zip 파일만 선택할 수 있습니다.",
    fileSize: "파일 크기는 24 MiB 이하여야 합니다.",
    fileEmpty: "빈 파일은 가져올 수 없습니다.",
    clear: "선택 지우기",
    preview: "미리보기",
    previewing: "미리보기 확인 중...",
    committing: "가져오는 중...",
    previewReady: "미리보기가 준비되었습니다. 아직 가져온 항목은 없습니다.",
    previewTitle: "가져올 내용",
    notes: (count: number) => `노트 ${count}개`,
    attachments: (count: number) => `로컬 첨부 파일 ${count}개`,
    noteList: "노트 목록",
    noNotes: "가져올 노트가 없습니다.",
    conflicts: (count: number) => `충돌 ${count}개`,
    conflictHint: "충돌이 하나라도 있으면 전체 가져오기가 차단됩니다. 기존 노트를 덮어쓰지 않습니다. 원본에서 충돌하는 노트의 제목이나 파일 이름을 바꾸고, 수정한 파일을 다시 선택해 미리보기를 확인하세요.",
    blocked: "이 파일은 가져올 수 없습니다. 아래 내용을 확인하고 원본을 수정한 뒤 다시 미리보기를 확인하세요.",
    warnings: (count: number) => `경고 ${count}개`,
    warningHint: "모든 경고를 확인하세요. 누락된 로컬 첨부 파일은 가져오지 못하며, 해당 참조는 연결되지 않을 수 있습니다.",
    confirm: "미리보기를 확인했으며, 이 노트와 로컬 첨부 파일을 가져오겠습니다.",
    confirmWarnings: "모든 경고를 확인했으며, 누락된 파일은 가져오지 못하고 참조가 연결되지 않을 수 있음을 이해한 상태로 가져오겠습니다.",
    import: "가져오기",
    imported: "가져오기가 완료되었습니다.",
    importedNotes: "가져온 노트 열기",
    previewFailed: "미리보기를 확인하지 못했습니다. 파일을 확인한 뒤 다시 미리보기를 요청하세요.",
    importFailed: "가져오기에 실패했습니다. 성공적으로 가져온 항목이 없습니다. 다시 미리보기를 확인한 뒤 시도하세요.",
    uncertain: "응답을 받지 못해 가져오기 완료 여부를 확인할 수 없습니다. 이미 가져온 항목이 있을 수 있습니다. 다시 가져오기를 시도하기 전에 반드시 미리보기를 확인하세요.",
  },
  en: {
    title: "Import notes",
    description: "Import only notes and local attachments from Markdown or a ZIP file.",
    scope: "Inbox, chat, settings, and trash are not imported. This is not a full-state restore.",
    fileLabel: "File to import",
    fileHint: "One .md, .markdown, or .zip file, up to 24 MiB. Preview its contents first.",
    fileType: "Choose a .md, .markdown, or .zip file.",
    fileSize: "The file must be 24 MiB or smaller.",
    fileEmpty: "An empty file cannot be imported.",
    clear: "Clear selection",
    preview: "Preview",
    previewing: "Checking preview...",
    committing: "Importing...",
    previewReady: "Preview ready. Nothing has been imported yet.",
    previewTitle: "Contents to import",
    notes: (count: number) => `${count} ${count === 1 ? "note" : "notes"}`,
    attachments: (count: number) => `${count} local ${count === 1 ? "attachment" : "attachments"}`,
    noteList: "Notes",
    noNotes: "There are no notes to import.",
    conflicts: (count: number) => `${count} ${count === 1 ? "conflict" : "conflicts"}`,
    conflictHint: "Any conflict blocks the entire batch. Existing notes are never overwritten. Rename conflicting note titles or filenames in the source, select the updated file, then preview again.",
    blocked: "This file cannot be imported. Review the details below, correct the source, then preview again.",
    warnings: (count: number) => `${count} ${count === 1 ? "warning" : "warnings"}`,
    warningHint: "Review every warning. Missing local attachments cannot be imported, and their references may remain broken.",
    confirm: "I have reviewed the preview and want to import these notes and local attachments.",
    confirmWarnings: "I have reviewed every warning and agree to import knowing that missing files cannot be imported and their references may remain broken.",
    import: "Import",
    imported: "Import completed.",
    importedNotes: "Open imported notes",
    previewFailed: "Preview failed. Check the file, then request another preview.",
    importFailed: "Import failed. Nothing was successfully imported. Preview again before trying another import.",
    uncertain: "No response was received, so the import outcome is unknown. Some items may already have been imported. You must preview again before trying another import.",
  },
});

type ImportFailure = {
  readonly operation: "preview" | "commit";
  readonly cause: unknown;
};

export function ImportSection() {
  const copy = useCopy(IMPORT_COPY);
  const { locale } = useLocale();
  const id = useId();
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

        {preview ? (
          <div className="mt-4 space-y-4 border-t border-line pt-4">
            <h4 className="text-md font-medium">{copy.previewTitle}</h4>
            <ImportCounts notes={preview.notes.length} attachments={preview.attachments} />
            {preview.notes.length === 0 ? <p className="text-sm text-mute">{copy.noNotes}</p> : (
              <div>
                <h5 id={`${id}-notes`} className="mb-2 text-sm font-medium">{copy.noteList}</h5>
                <div role="region" aria-labelledby={`${id}-notes`} tabIndex={0} className="max-h-48 overflow-y-auto overscroll-contain rounded-ctl border border-line px-3 py-2">
                  <ul className="space-y-3">
                    {preview.notes.map((note, index) => (
                      <li key={`${note.path}-${index}`} className="min-w-0 break-words">
                        <p className="whitespace-pre-wrap text-sm font-medium">{note.title}</p>
                        <p className="whitespace-pre-wrap text-xs text-mute">{note.path}</p>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            )}
            {blocked ? (
              <p className="rounded-ctl bg-danger-soft px-3 py-2 text-sm text-danger">
                {preview.conflicts.length > 0 ? copy.conflictHint : copy.blocked}
              </p>
            ) : null}
            {preview.conflicts.length > 0 ? (
              <div>
                <h5 id={`${id}-conflicts`} className="mb-2 text-md font-medium text-danger">{copy.conflicts(preview.conflicts.length)}</h5>
                <div role="region" aria-labelledby={`${id}-conflicts`} tabIndex={0} className="max-h-60 overflow-y-auto overscroll-contain rounded-ctl border border-line px-3 py-2">
                  <ul className="space-y-3">
                    {preview.conflicts.map((conflict, index) => (
                      <li key={`${conflict.path}-${index}`} className="min-w-0 space-y-1 whitespace-pre-wrap break-words text-sm">
                        <p className="font-medium">{conflict.title}</p>
                        <p className="text-xs text-mute">{conflict.path}</p>
                        <p>{conflict.reason}</p>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            ) : null}
            <ImportWarnings warnings={preview.warnings} />
            {!blocked ? (
              <div className="space-y-3">
                <label className="flex min-h-touch cursor-pointer items-start gap-3 py-2 text-sm">
                  <input
                    type="checkbox"
                    className="mt-0.5 size-4 shrink-0 accent-accent"
                    checked={confirmed}
                    disabled={busy}
                    onChange={(event) => setConfirmed(event.target.checked)}
                  />
                  <span>{preview.warnings.length > 0 ? copy.confirmWarnings : copy.confirm}</span>
                </label>
                <Button
                  variant="primary"
                  size="lg"
                  loading={pending === "commit"}
                  disabled={busy || !confirmed}
                  leading={<Upload aria-hidden className="size-4" />}
                  onClick={() => void commitFile()}
                >
                  {copy.import}
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}

        {receipt ? (
          <div className="mt-4 space-y-4 border-t border-line pt-4">
            <h4 className="text-md font-medium text-ok">{copy.imported}</h4>
            <ImportCounts notes={receipt.notes.length} attachments={receipt.attachments} />
            <div>
              <h5 id={`${id}-receipt`} className="mb-2 text-sm font-medium">{copy.importedNotes}</h5>
              <div role="region" aria-labelledby={`${id}-receipt`} tabIndex={0} className="max-h-60 overflow-y-auto overscroll-contain rounded-ctl border border-line px-3 py-2">
                <ul className="space-y-3">
                  {receipt.notes.map((note, index) => (
                    <li key={`${note.id}-${index}`} className="min-w-0 break-words">
                      <Link href={`/notes/${encodeURIComponent(note.id)}`} className="whitespace-pre-wrap text-sm font-medium text-accent underline underline-offset-2">
                        {note.title}
                      </Link>
                      <p className="whitespace-pre-wrap text-xs text-mute">{note.path}</p>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
            <ImportWarnings warnings={receipt.warnings} />
          </div>
        ) : null}
      </div>
    </Section>
  );
}

function ImportCounts({ notes, attachments }: { readonly notes: number; readonly attachments: number }) {
  const copy = useCopy(IMPORT_COPY);
  return (
    <p className="flex flex-wrap gap-x-4 gap-y-1 text-sm tabular-nums">
      <span>{copy.notes(notes)}</span>
      <span>{copy.attachments(attachments)}</span>
    </p>
  );
}

function ImportWarnings({ warnings }: { readonly warnings: ImportPreview["warnings"] }) {
  const copy = useCopy(IMPORT_COPY);
  const id = useId();
  if (warnings.length === 0) return null;
  return (
    <div>
      <h5 id={id} className="mb-2 text-md font-medium text-warn">{copy.warnings(warnings.length)}</h5>
      <p className="mb-2 text-sm text-mute">{copy.warningHint}</p>
      <div role="region" aria-labelledby={id} tabIndex={0} className="max-h-60 overflow-y-auto overscroll-contain rounded-ctl border border-line px-3 py-2">
        <ul className="space-y-3">
          {warnings.map((warning, index) => (
            <li key={`${warning.path}-${index}`} className="min-w-0 space-y-1 whitespace-pre-wrap break-words text-sm">
              <p className="font-medium">{warning.code}</p>
              <p className="text-xs text-mute">{warning.path}</p>
              <p>{warning.detail}</p>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
