"use client";

import { useState } from "react";
import useSWR from "swr";
import { useLocale } from "@/components/i18n";
import { Button, Input } from "@/components/ui";
import { api, fetcher } from "@/lib/api-client";
import type { AgentScope as Scope, AgentTokenDto as Token, AgentProposalDto as Proposal, AgentActivityDto as Activity } from "@/lib/agent-access";
import { Section } from "./SettingsSection";
import { OAuthConnections } from "./OAuthConnections";

export function AgentsSection() {
  const { locale } = useLocale();
  const ko = locale === "ko";
  const tokens = useSWR<{ tokens: Token[] }>("/api/agents/tokens", fetcher);
  const proposals = useSWR<{ proposals: Proposal[] }>("/api/agents/proposals", fetcher);
  const activity = useSWR<{ activity: Activity[] }>("/api/agents/activity", fetcher);
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<Scope[]>(["read"]);
  const [noteIds, setNoteIds] = useState("");
  const [secret, setSecret] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const allowedNoteIds = noteIds.split(/[\s,]+/).filter(Boolean);

  async function refresh() {
    await Promise.all([tokens.mutate(), proposals.mutate(), activity.mutate()]);
  }
  async function action(run: () => Promise<void>) {
    setBusy(true); setError(""); setNotice("");
    try { await run(); await refresh(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : ko ? "요청을 완료하지 못했어요." : "Request failed."); }
    finally { setBusy(false); }
  }
  function selectScope(scope: Scope, checked: boolean) {
    setScopes(current => checked ? [...current, scope] : current.filter(value => value !== scope));
  }
  const loadError = tokens.error || proposals.error || activity.error;

  return (
    <Section id="settings-agents" title={ko ? "에이전트 접근" : "Agent access"}
      description={ko ? "필요한 권한만 주고 언제든 회수하세요. 노트 수정은 직접 승인해야 적용돼요." : "Grant only needed access. Revoke it anytime. Note changes require your approval."}>
      <div className="space-y-6">
        <p className="text-sm text-mute">{ko
          ? "Claude나 ChatGPT에 /api/mcp 주소를 추가하고 Aro에서 권한을 승인하세요. 직접 만든 Bearer 토큰도 계속 사용할 수 있어요. 로그인 쿠키나 비밀번호는 공유하지 마세요."
          : "Add /api/mcp in Claude or ChatGPT and approve access in Aro. Owner-created Bearer tokens also work. Never share your login cookie or password."}</p>
        <Input aria-label={ko ? "MCP 연결 주소" : "MCP endpoint"} readOnly value="/api/mcp" />
        <form className="space-y-4" onSubmit={event => {
          event.preventDefault();
          void action(async () => {
            const result = await api<{ token: Token; secret: string }>("/api/agents/tokens", { method: "POST",
              json: { name: name.trim(), scopes, allowedNoteIds: scopes.includes("propose-write") ? allowedNoteIds : [] } });
            setSecret(result.secret); setName("");
          });
        }}>
          <label className="block text-sm" htmlFor="agent-name">{ko ? "연결 이름" : "Connection name"}</label>
          <Input id="agent-name" value={name} onChange={event => setName(event.target.value)} maxLength={80}
            placeholder={ko ? "예: 로컬 코딩 도우미" : "For example: local coding assistant"} disabled={busy} />
          <fieldset className="space-y-2">
            <legend className="mb-2 text-sm font-medium">{ko ? "허용할 권한" : "Allowed capabilities"}</legend>
            {([
              ["read", ko ? "노트 검색과 읽기" : "Search and read notes"],
              ["capture", ko ? "인박스에 캡처 추가" : "Add captures to the inbox"],
              ["propose-write", ko ? "지정한 노트의 수정 제안 (승인 필요)" : "Propose changes to selected notes (approval required)"],
            ] as const).map(([scope, label]) => (
              <label key={scope} className="flex min-h-touch items-center gap-3 text-sm">
                <input type="checkbox" checked={scopes.includes(scope)} disabled={busy}
                  onChange={event => selectScope(scope, event.target.checked)} />
                {label}
              </label>
            ))}
          </fieldset>
          {scopes.includes("propose-write") && <div>
            <label htmlFor="agent-note-ids" className="block text-sm">{ko ? "수정 제안을 허용할 노트 ID" : "Note IDs allowed for proposals"}</label>
            <textarea id="agent-note-ids" className="mt-2 w-full rounded border border-line bg-canvas p-3 text-sm focus-ring"
              rows={3} value={noteIds} onChange={event => setNoteIds(event.target.value)} disabled={busy} />
            <p className="mt-2 text-xs text-mute">{ko ? "노트 주소의 UUID를 줄바꿈이나 쉼표로 구분하세요. 전체 노트 수정 권한은 주지 않아요." : "Separate note URL UUIDs with commas or newlines. This does not grant blanket write access."}</p>
          </div>}
          <Button type="submit" variant="primary" disabled={busy || secret !== null || !name.trim() || !scopes.length || (scopes.includes("propose-write") && !allowedNoteIds.length)}>
            {ko ? "접근 토큰 만들기" : "Create access token"}
          </Button>
        </form>
        {secret && <div className="rounded border border-accent p-4" role="region" aria-label={ko ? "새 접근 토큰" : "New access token"}>
          <p className="mb-3 text-sm font-medium">{ko ? "이 토큰은 지금 한 번만 보여요. 연결할 에이전트에만 전달하세요." : "Shown only once. Give this token only to the intended agent."}</p>
          <Input aria-label={ko ? "접근 토큰" : "Access token"} readOnly value={secret} type="password" autoComplete="off" />
          <div className="mt-3 flex flex-wrap gap-2">
            <Button type="button" onClick={() => void navigator.clipboard.writeText(secret).then(
              () => setNotice(ko ? "토큰을 복사했어요." : "Token copied."),
              () => setError(ko ? "클립보드에 복사하지 못했어요." : "Could not copy to the clipboard."),
            )}>{ko ? "토큰 복사" : "Copy token"}</Button>
            <Button type="button" variant="ghost" onClick={() => void navigator.clipboard.writeText(JSON.stringify({
              url: new URL("/api/mcp", window.location.origin).href, headers: { Authorization: `Bearer ${secret}` },
            }, null, 2)).then(
              () => setNotice(ko ? "주소와 인증 헤더를 복사했어요. 클라이언트의 HTTP 연결 설정에 사용하세요." : "Endpoint and authorization header copied. Use them in your client's HTTP connection settings."),
              () => setError(ko ? "연결 설정을 복사하지 못했어요." : "Could not copy connection settings."),
            )}>{ko ? "연결 설정 복사" : "Copy connection settings"}</Button>
            <Button type="button" variant="ghost" onClick={() => setSecret(null)}>{ko ? "토큰 표시 닫기" : "Dismiss token"}</Button>
          </div>
        </div>}
        {(error || loadError) && <p role="alert" className="text-sm text-danger">{error || (ko ? "접근 설정을 불러오지 못했어요." : "Could not load access settings.")}</p>}
        {notice && <p role="status" className="text-sm">{notice}</p>}
        <OAuthConnections />
        <div className="border-t border-line pt-5">
          <div className="flex items-center justify-between gap-3">
            <h4 className="text-sm font-medium">{ko ? "연결된 에이전트" : "Agent connections"}</h4>
            <Button type="button" variant="ghost" disabled={busy} onClick={() => void refresh().catch(() => setError(ko ? "새로고침하지 못했어요." : "Could not refresh."))}>{ko ? "새로고침" : "Refresh"}</Button>
          </div>
          {!tokens.data ? <p className="text-sm text-mute">{ko ? "불러오는 중…" : "Loading…"}</p> : !tokens.data.tokens.length
            ? <p className="text-sm text-mute">{ko ? "허용한 에이전트가 없어요." : "No agents have access."}</p>
            : <ul className="divide-y divide-line">{tokens.data.tokens.map(token => <li key={token.id} data-token-id={token.id} className="flex flex-wrap items-center justify-between gap-3 py-4">
              <div className="min-w-0"><p className="break-words text-sm font-medium">{token.name}</p>
                <p className="text-xs text-mute">{token.scopes.join(" · ")}{token.revokedAt ? ko ? " · 회수됨" : " · Revoked" : ""}</p>
              </div>
              {!token.revokedAt && <Button type="button" variant="ghost" disabled={busy} onClick={() => void action(async () => {
                await api(`/api/agents/tokens/${token.id}`, { method: "DELETE" });
                setSecret(null);
              })}>{ko ? "접근 회수" : "Revoke access"}</Button>}
            </li>)}</ul>}
        </div>
        <div className="border-t border-line pt-5">
          <h4 className="text-sm font-medium">{ko ? "승인할 수정 제안" : "Changes awaiting approval"}</h4>
          {proposals.data?.proposals.filter(proposal => proposal.status === "pending").map(proposal => <article key={proposal.id} data-proposal-id={proposal.id} className="mt-4 rounded border border-line p-4">
            <a href={`/notes/${proposal.noteId}`} className="text-sm text-accent underline">{ko ? "현재 노트 확인" : "Review current note"}</a>
            {proposal.patch.title !== undefined && <p className="mt-3 break-words text-sm font-medium">{ko ? "제안한 제목: " : "Proposed title: "}{proposal.patch.title}</p>}
            {proposal.patch.body !== undefined && <pre className="my-3 max-h-64 overflow-auto whitespace-pre-wrap break-words text-sm">{proposal.patch.body}</pre>}
            <div className="flex flex-wrap gap-2">
              {(["approve", "reject"] as const).map(decision => <Button key={decision} type="button" variant={decision === "approve" ? "primary" : "ghost"} disabled={busy}
                onClick={() => void action(async () => { await api(`/api/agents/proposals/${proposal.id}/${decision}`, { method: "POST" }); })}>
                {decision === "approve" ? ko ? "검토한 수정 적용" : "Apply reviewed change" : ko ? "거절" : "Reject"}
              </Button>)}
            </div>
          </article>)}
          {proposals.data && !proposals.data.proposals.some(proposal => proposal.status === "pending") && <p className="mt-2 text-sm text-mute">{ko ? "대기 중인 제안이 없어요." : "No pending proposals."}</p>}
        </div>
        <div className="border-t border-line pt-5">
          <h4 className="text-sm font-medium">{ko ? "최근 접근 기록" : "Recent access activity"}</h4>
          <p className="mt-2 text-xs text-mute">{ko ? "도구 이름·결과·시각만 표시해요. 노트 본문이나 토큰은 기록하지 않아요." : "Tool, result and time only. Note bodies and tokens are not logged."}</p>
          <ul className="mt-3 space-y-2">{activity.data?.activity.map(item => <li key={item.id} className="break-words text-xs">
            {item.tool} · {item.status} · {new Date(item.createdAt).toLocaleString(locale)}
          </li>)}</ul>
        </div>
      </div>
    </Section>
  );
}
