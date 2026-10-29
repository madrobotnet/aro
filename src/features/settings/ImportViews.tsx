"use client";

import { Upload } from "lucide-react";
import Link from "next/link";
import { useId } from "react";
import { useCopy } from "@/components/i18n";
import { Button } from "@/components/ui";
import type { ImportPreview, ImportReceipt } from "@/lib/import-types";
import { IMPORT_COPY } from "./import-copy";

export function ImportPreviewView({ preview, blocked, confirmed, busy, pending, onConfirm, onImport }: {
 readonly preview: ImportPreview; readonly blocked: boolean; readonly confirmed: boolean; readonly busy: boolean;
 readonly pending: "preview" | "commit" | null; readonly onConfirm: (checked: boolean) => void; readonly onImport: () => void;
}) {
 const copy = useCopy(IMPORT_COPY);
 const id = useId();
 return <>
        {(
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
                    onChange={(event) => onConfirm(event.target.checked)}
                  />
                  <span>{preview.warnings.length > 0 ? copy.confirmWarnings : copy.confirm}</span>
                </label>
                <Button
                  variant="primary"
                  size="lg"
                  loading={pending === "commit"}
                  disabled={busy || !confirmed}
                  leading={<Upload aria-hidden className="size-4" />}
                  onClick={onImport}
                >
                  {copy.import}
                </Button>
              </div>
            ) : null}
          </div>
         )}
 </>;
}

export function ImportReceiptView({receipt}: { readonly receipt: ImportReceipt }) {
 const copy = useCopy(IMPORT_COPY);
 const id = useId();
 return <>
        {(
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
         )}
 </>;
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
