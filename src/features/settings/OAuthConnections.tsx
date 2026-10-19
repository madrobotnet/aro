"use client";

import { useState } from "react";
import useSWR from "swr";
import { useLocale } from "@/components/i18n";
import { Badge, Button, Textarea } from "@/components/ui";
import type { OAuthConnectionDto } from "@/lib/agent-access";
import { api, fetcher } from "@/lib/api-client";
import { formatDateTime } from "@/lib/i18n/format-date";

function Connection({ connection, refresh }: { readonly connection: OAuthConnectionDto; readonly refresh: () => Promise<unknown> }) {
  const { locale } = useLocale();
  const ko = locale === "ko";
  const [noteIds, setNoteIds] = useState(connection.allowedNoteIds.join("\n"));
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [saved, setSaved] = useState(false);
  async function change(method: "DELETE" | "PATCH") {
    setBusy(true); setFailed(false); setSaved(false);
    try {
      await api(`/api/agents/connections/${connection.id}`, {
        method, ...(method === "PATCH" ? { json: { allowedNoteIds: noteIds.split(/[\s,]+/).filter(Boolean) } } : {}),
      });
      await refresh();
      setSaved(method === "PATCH");
    } catch { setFailed(true); }
    finally { setBusy(false); }
  }
  return <li className="py-4" data-grant-id={connection.id}>
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2"><p className="break-words text-sm font-medium">{connection.clientName}</p><Badge>OAuth</Badge></div>
        <p className="mt-1 text-xs text-mute">{connection.scopes.join(" · ")}{connection.revokedAt ? ko ? " · 회수됨" : " · Revoked" : ""}</p>
        <p className="mt-1 text-xs text-mute">{ko ? "최근 사용: " : "Last used: "}{
          connection.lastUsedAt ? formatDateTime(connection.lastUsedAt, locale) : ko ? "아직 사용하지 않음" : "Not used yet"
        }</p>
      </div>
      {!connection.revokedAt && <Button type="button" variant="ghost" disabled={busy} onClick={() => {
        if (window.confirm(ko ? "이 연결의 모든 접근을 회수할까요?" : "Revoke all access for this connection?")) void change("DELETE");
      }}>{ko ? "접근 회수" : "Revoke access"}</Button>}
    </div>
    {!connection.revokedAt && connection.scopes.includes("propose-write") && <form className="mt-4 space-y-3" onSubmit={event => {
      event.preventDefault(); void change("PATCH");
    }}>
      <Textarea label={ko ? "수정 제안을 허용할 노트 ID" : "Note IDs allowed for proposals"}
        value={noteIds} onChange={event => { setNoteIds(event.target.value); setSaved(false); }}
        rows={2} disabled={busy} hint={ko
          ? "노트 주소의 UUID를 쉼표나 줄바꿈으로 구분하세요. 비워 두면 수정 제안을 허용하지 않아요."
          : "Separate note URL UUIDs with commas or newlines. An empty list allows no proposals."} />
      <Button type="submit" disabled={busy}>{ko ? "허용 노트 저장" : "Save allowed notes"}</Button>
    </form>}
    {failed && <p role="alert" className="mt-3 text-sm text-danger">{ko ? "변경하지 못했어요. 노트 ID를 확인하고 다시 시도하세요." : "Could not save this change. Check note IDs and try again."}</p>}
    {saved && <p role="status" className="mt-3 text-sm text-ok">{ko ? "허용 노트를 저장했어요." : "Allowed notes saved."}</p>}
  </li>;
}

export function OAuthConnections() {
  const { locale } = useLocale();
  const ko = locale === "ko";
  const connections = useSWR<{ connections: OAuthConnectionDto[] }>("/api/agents/connections", fetcher);
  return <div className="border-t border-line pt-5">
    <div className="flex items-center justify-between gap-3">
      <h4 className="text-sm font-medium">{ko ? "OAuth 연결" : "OAuth connections"}</h4>
      <Button type="button" variant="ghost" onClick={() => void connections.mutate().catch(() => undefined)}>{ko ? "새로고침" : "Refresh"}</Button>
    </div>
    {connections.error && <p role="alert" className="mt-2 text-sm text-danger">{ko ? "연결을 불러오지 못했어요. 새로고침하세요." : "Could not load connections. Refresh to try again."}</p>}
    {!connections.data && !connections.error && <p className="mt-2 text-sm text-mute">{ko ? "불러오는 중…" : "Loading…"}</p>}
    {connections.data && !connections.data.connections.length && <p className="mt-2 text-sm text-mute">{ko
      ? "연결된 커넥터가 없어요. Claude나 ChatGPT에서 MCP 주소를 추가하면 여기에 표시돼요."
      : "No connectors yet. Add the MCP URL in Claude or ChatGPT to connect."}</p>}
    <ul className="divide-y divide-line">{connections.data?.connections.map(connection =>
      <Connection key={connection.id} connection={connection} refresh={() => connections.mutate()} />)}</ul>
  </div>;
}
