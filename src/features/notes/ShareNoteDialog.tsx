import { Share2, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import useSWR from "swr";
import { useCopy, useLocale } from "@/components/i18n";
import { Button, Input, useModalDialog } from "@/components/ui";
import { api, fetcher } from "@/lib/api-client";
import { localizedApiError } from "@/lib/i18n/api-error";
import { formatDateTime } from "@/lib/i18n/format-date";
import type { ShareSummary } from "@/server/shares/service";

const COPY = {
  ko: {
    open: "공유", title: "노트 스냅샷 공유", close: "닫기",
    description: "저장된 제목과 본문만 읽기 전용으로 공유합니다. 이후 편집은 반영되지 않으며, 첨부 파일은 포함되지 않습니다.",
    confirm: "링크를 가진 누구나 만료 전까지 이 스냅샷을 읽을 수 있음을 확인합니다.",
    duration: "유효 기간", day: "24시간", week: "7일", hour: "1시간",
    create: "스냅샷 링크 만들기", once: "링크는 지금 한 번만 표시됩니다. 닫기 전에 복사하세요.",
    link: "공유 링크", copy: "링크 복사", copied: "복사됨", copyFailed: "복사할 수 없습니다. 링크를 선택해 직접 복사하세요.",
    list: "이 노트의 공유", empty: "아직 공유한 스냅샷이 없습니다.", revoke: "공유 해제",
    revoked: "해제됨", expires: "만료", failed: "공유 요청에 실패했습니다. 다시 시도하세요.",
    loadFailed: "공유 목록을 불러오지 못했습니다.", retry: "다시 시도",
    saveFailed: "노트를 먼저 저장해야 합니다. 노트 화면에서 저장을 다시 시도하세요.",
    stop: "공유 해제, 휴지통 이동, 보관 또는 영구 삭제 시 링크는 즉시 무효가 됩니다.",
    revokeTitle: "이 스냅샷의 공유를 해제할까요?", revokeBody: "이 링크로는 더 이상 스냅샷을 읽을 수 없습니다.", cancel: "취소",
  },
  en: {
    open: "Share", title: "Share a note snapshot", close: "Close",
    description: "Share only the saved title and body as read-only text. Later edits are not shared, and files are not included.",
    confirm: "I understand anyone with the link can read this snapshot until it expires.",
    duration: "Link lifetime", day: "24 hours", week: "7 days", hour: "1 hour",
    create: "Create snapshot link", once: "This link is shown only once. Copy it before closing.",
    link: "Share link", copy: "Copy link", copied: "Copied", copyFailed: "Could not copy. Select the link and copy it manually.",
    list: "Shares for this note", empty: "No snapshots shared yet.", revoke: "Revoke",
    revoked: "Revoked", expires: "Expires", failed: "Sharing request failed. Try again.",
    loadFailed: "Could not load shares.", retry: "Retry",
    saveFailed: "Save the note first. Retry saving from the note screen.",
    stop: "Revoking, trashing, archiving or permanently deleting the note immediately invalidates the link.",
    revokeTitle: "Revoke this snapshot?", revokeBody: "This link will no longer open the snapshot.", cancel: "Cancel",
  },
} as const;

export function ShareNoteDialog({ noteId, beforeCreate }: {
  readonly noteId: string;
  readonly beforeCreate: () => Promise<boolean>;
}) {
  const copy = useCopy(COPY);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const { ref, onClose, onBackdropClick } = useModalDialog(open, setOpen);
  const titleId = useId();
  return <>
    <Button iconOnly variant="ghost" className="min-h-touch min-w-touch" title={copy.open} aria-label={copy.open}
      onClick={() => setOpen(true)}>
      <Share2 aria-hidden className="size-4" />
    </Button>
    <dialog ref={ref} onClose={onClose} onClick={busy ? undefined : onBackdropClick}
      onCancel={(event) => { if (busy) event.preventDefault(); }} aria-labelledby={titleId}
      className="m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-lg overflow-y-auto rounded-card border border-line bg-card p-5 text-ink shadow-pop backdrop:bg-scrim">
      {open ? <ShareBody key={noteId} noteId={noteId} beforeCreate={beforeCreate} busy={busy} setBusy={setBusy}
        titleId={titleId} onDismiss={() => setOpen(false)} /> : null}
    </dialog>
  </>;
}

function ShareBody({ noteId, beforeCreate, busy, setBusy, titleId, onDismiss }: {
  readonly noteId: string; readonly beforeCreate: () => Promise<boolean>;
  readonly busy: boolean; readonly setBusy: (value: boolean) => void;
  readonly titleId: string; readonly onDismiss: () => void;
}) {
  const copy = useCopy(COPY);
  const { locale } = useLocale();
  const endpoint = `/api/notes/${noteId}/shares`;
  const list = useSWR<{ shares: ShareSummary[] }>(endpoint, fetcher);
  const [confirmed, setConfirmed] = useState(false);
  const [hours, setHours] = useState("24");
  const [link, setLink] = useState<{ id: string; url: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [failure, setFailure] = useState<{ readonly key: "failed" | "saveFailed" | "copyFailed"; readonly cause?: unknown } | null>(null);
  const [revoking, setRevoking] = useState<ShareSummary | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const active = useRef(false);
  useEffect(() => { if (revoking) cancelRef.current?.focus(); }, [revoking]);
  const create = async () => {
    if (active.current || revoking) return;
    active.current = true;
    setBusy(true); setFailure(null);
    try {
      if (!await beforeCreate()) { setFailure({ key: "saveFailed" }); return; }
      const result = await api<{ share: ShareSummary; path: string }>(endpoint, {
        method: "POST", json: { confirmed, expiresInHours: Number(hours) },
      });
      setLink({ id: result.share.id, url: new URL(result.path, window.location.origin).href });
      setCopied(false); setConfirmed(false);
      await list.mutate();
    } catch (error) {
      setFailure({ key: "failed", cause: error });
    } finally { active.current = false; setBusy(false); }
  };
  const revoke = async (id: string) => {
    if (active.current) return;
    active.current = true;
    setBusy(true); setFailure(null);
    try {
      await api(`${endpoint}/${id}`, { method: "DELETE" });
      if (link?.id === id) setLink(null);
      setRevoking(null);
      await list.mutate();
    } catch (cause) { setFailure({ key: "failed", cause }); }
    finally { active.current = false; setBusy(false); }
  };
  return <>
    <header className="flex items-start justify-between gap-3">
      <h2 id={titleId} className="text-xl font-semibold">{copy.title}</h2>
      <Button iconOnly variant="ghost" aria-label={copy.close} disabled={busy} className="min-h-touch min-w-touch" onClick={onDismiss}><X aria-hidden className="size-4" /></Button>
    </header>
    <p className="mt-3 text-sm text-mute">{copy.description}</p>
    <p className="mt-2 text-sm text-mute">{copy.stop}</p>
    <label className="mt-5 block text-sm font-medium">{copy.duration}
      <select value={hours} disabled={busy} onChange={(event) => setHours(event.target.value)}
        className="mt-1 block min-h-touch w-full rounded-ctl border border-line bg-card px-3 text-ink">
        <option value="1">{copy.hour}</option><option value="24">{copy.day}</option><option value="168">{copy.week}</option>
      </select>
    </label>
    <label className="mt-4 flex min-h-touch items-start gap-3 text-sm">
      <input type="checkbox" checked={confirmed} disabled={busy} onChange={(event) => setConfirmed(event.target.checked)} className="mt-1 size-5 shrink-0 accent-accent" />
      <span>{copy.confirm}</span>
    </label>
    <Button variant="primary" className="mt-3 min-h-touch w-full" disabled={!confirmed || busy || Boolean(link) || Boolean(revoking)} loading={busy && !revoking} onClick={() => void create()}>{copy.create}</Button>
    {failure ? <p role="alert" className="mt-3 text-sm text-danger">{localizedApiError(failure.cause, locale, copy[failure.key])}</p> : null}
    {link ? <section className="mt-5 space-y-3 rounded-ctl bg-desk p-3">
      <p role="status" className="text-sm">{copy.once}</p>
      <Input label={copy.link} value={link.url} readOnly onFocus={(event) => event.currentTarget.select()} />
      <Button className="min-h-touch" onClick={() => {
        if (!navigator.clipboard) { setFailure({ key: "copyFailed" }); return; }
        void navigator.clipboard.writeText(link.url).then(() => setCopied(true), cause => setFailure({ key: "copyFailed", cause }));
      }}>{copied ? copy.copied : copy.copy}</Button>
    </section> : null}
    <section className="mt-6 border-t border-line pt-4">
      <h3 className="font-medium">{copy.list}</h3>
      {list.isLoading ? <p role="status" className="mt-2 text-sm text-mute">...</p>
        : list.error ? <div role="alert" className="mt-2 text-sm"><p>{copy.loadFailed}</p><Button onClick={() => void list.mutate()}>{copy.retry}</Button></div>
        : !list.data?.shares.length ? <p className="mt-2 text-sm text-mute">{copy.empty}</p>
        : <ul className="mt-2 divide-y divide-line">{list.data.shares.map((share) => <li key={share.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
          <div className="text-sm"><time dateTime={share.createdAt}>{formatDateTime(share.createdAt, locale)}</time>
            <p className="text-xs text-mute">{share.revokedAt ? copy.revoked : `${copy.expires}: ${formatDateTime(share.expiresAt, locale)}`}</p>
          </div>
          {!share.revokedAt ? <Button size="sm" className="min-h-touch" disabled={busy} onClick={() => { setFailure(null); setRevoking(share); }}>{copy.revoke}</Button> : null}
        </li>)}</ul>}
    </section>
    {revoking ? <section role="region" aria-label={copy.revokeTitle} className="mt-4 rounded-ctl bg-desk p-4">
      <h3 className="text-md font-medium">{copy.revokeTitle}</h3>
      <p className="mt-2 text-sm">{formatDateTime(revoking.createdAt, locale)}</p>
      <p className="mt-2 text-sm text-mute">{copy.revokeBody}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button ref={cancelRef} disabled={busy} onClick={() => { setRevoking(null); setFailure(null); }}>{copy.cancel}</Button>
        <Button variant="danger" loading={busy} onClick={() => void revoke(revoking.id)}>{copy.revoke}</Button>
      </div>
    </section> : null}
  </>;
}
