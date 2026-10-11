import { randomUUID } from "node:crypto";
import type { AgentProposalDto, AgentToolCall, CreateAgentTokenInput } from "@/lib/agent-access";
import { sqliteStore } from "@/server/db/backend";
import { sqliteTimestamp, type SQLiteExecutor } from "@/server/db/sqlite";
import { ApiError } from "@/server/http";
import { listSQLiteNotes, updateSQLiteNote } from "@/server/notes/sqlite";
import {
  activityDto, callHash, callTarget, checkVersion, digest, newToken, noteResult, proposalDto,
  replayResult, requireNote, requireScope, requireToken, reviewState, tokenDto, TOOL_SCOPES,
  type ActivityRow, type AgentNoteRow, type ProposalRow, type TokenRow,
} from "./common";

function owner(q: SQLiteExecutor): string {
  const row = q.get<{ id: string }>("SELECT id FROM users ORDER BY created_at,id LIMIT 1");
  if (!row) throw new ApiError("forbidden", "Owner has not been configured");
  return row.id;
}
function findToken(q: SQLiteExecutor, hash: string): TokenRow | null {
  return q.get<TokenRow>("SELECT * FROM agent_tokens WHERE token_hash=? AND owner_id=?", [hash, owner(q)]);
}
function note(q: SQLiteExecutor, id: string): AgentNoteRow {
  return requireNote(q.get<AgentNoteRow>(
    "SELECT id,title,body,updated_at,deleted_at,tags,aliases,CAST(pinned AS TEXT) AS pinned,status FROM notes WHERE id=?", [id]));
}
function audit(q: SQLiteExecutor, tokenId: string, tool: string, status: ActivityRow["status"], target: string | null): void {
  q.run("INSERT INTO agent_activity(id,token_id,tool,status,target_id) VALUES (?,?,?,?,?)",
    [randomUUID(), tokenId, tool, status, target]);
}
export async function createToken(input: CreateAgentTokenInput) {
  return (await sqliteStore()).transaction((q) => {
    for (const id of input.allowedNoteIds) note(q, id);
    const created = newToken(input, owner(q));
    const row = created.row;
    q.run(`INSERT INTO agent_tokens(id,owner_id,name,prefix,token_hash,scopes,allowed_note_ids)
      VALUES (?,?,?,?,?,?,?)`,
    [row.id, row.owner_id, row.name, row.prefix, created.hash, row.scopes, row.allowed_note_ids]);
    const persisted = q.get<TokenRow>("SELECT * FROM agent_tokens WHERE id=?", [row.id]);
    if (!persisted) throw new ApiError("internal", "Token insert failed");
    return { token: tokenDto(persisted), secret: created.secret };
  });
}
export async function listTokens() {
  const q = await sqliteStore();
  return q.all<TokenRow>("SELECT * FROM agent_tokens WHERE owner_id=? ORDER BY created_at DESC,id DESC", [owner(q)]).map(tokenDto);
}
export async function revokeToken(id: string): Promise<void> {
  (await sqliteStore()).transaction((q) => {
    const row = q.get<TokenRow>("SELECT * FROM agent_tokens WHERE id=? AND owner_id=?", [id, owner(q)]);
    if (!row) throw new ApiError("not_found", "Agent token not found");
    q.run("UPDATE agent_tokens SET revoked_at=coalesce(revoked_at,?) WHERE id=?", [sqliteTimestamp(new Date()), id]);
  });
}
export async function authenticate(secret: string) {
  return tokenDto(requireToken(findToken(await sqliteStore(), digest(secret))));
}
export async function listActivity(limit: number) {
  const q = await sqliteStore();
  return q.all<ActivityRow>(`SELECT a.* FROM agent_activity a JOIN agent_tokens t ON t.id=a.token_id
    WHERE t.owner_id=? ORDER BY a.created_at DESC,a.id DESC LIMIT ?`, [owner(q), limit]).map(activityDto);
}
export async function listProposals(status: AgentProposalDto["status"], limit: number) {
  const q = await sqliteStore();
  return q.all<ProposalRow>(`SELECT p.* FROM agent_proposals p JOIN agent_tokens t ON t.id=p.token_id
    WHERE t.owner_id=? AND p.status=? ORDER BY p.created_at DESC,p.id DESC LIMIT ?`, [owner(q), status, limit]).map(proposalDto);
}
export async function reviewProposal(id: string, decision: "approved" | "rejected") {
  return (await sqliteStore()).transaction((q) => {
    const row = q.get<ProposalRow>(`SELECT p.* FROM agent_proposals p JOIN agent_tokens t ON t.id=p.token_id
      WHERE p.id=? AND t.owner_id=?`, [id, owner(q)]);
    if (!row) throw new ApiError("not_found", "Proposal not found");
    if (reviewState(row, decision)) return proposalDto(row);
    if (decision === "approved") {
      const token = q.get<TokenRow>("SELECT * FROM agent_tokens WHERE id=?", [row.token_id]);
      if (!token) throw new ApiError("forbidden", "Proposal token no longer exists");
      requireScope(token, "propose-write", row.note_id);
      checkVersion(note(q, row.note_id), row.expected_version);
      // Non-coalescing native revision reason keeps the exact state replaced by approval.
      updateSQLiteNote(q, row.note_id, proposalDto(row).patch, "merge");
    }
    const reviewedAt = sqliteTimestamp(new Date());
    q.run("UPDATE agent_proposals SET status=?,reviewed_at=? WHERE id=?", [decision, reviewedAt, row.id]);
    audit(q, row.token_id, `proposal/${decision}`, "ok", row.note_id);
    return proposalDto({ ...row, status: decision, reviewed_at: reviewedAt });
  });
}
export async function callTool(secret: string, call: AgentToolCall): Promise<unknown> {
  const store = await sqliteStore();
  let tokenId: string | null = null;
  try {
    return store.transaction((q) => {
      const found = findToken(q, digest(secret));
      tokenId = found?.id ?? null;
      const token = requireToken(found);
      requireScope(token, TOOL_SCOPES[call.name], callTarget(call) ?? undefined);
      const recent = q.get<{ total: bigint }>(
        "SELECT count(*) AS total FROM agent_activity WHERE token_id=? AND created_at>=?",
        [token.id, sqliteTimestamp(new Date(Date.now() - 60000))]);
      if (recent && recent.total >= 120n) throw new ApiError("rate_limited", "Agent tool rate limit exceeded");
      let result: unknown;
      let target = callTarget(call);
      switch (call.name) {
        case "search_notes": {
          const page = listSQLiteNotes(q, { q: call.arguments.query, limit: call.arguments.limit });
          result = { notes: page.notes.map((n) => ({ id: n.id, title: n.title.slice(0, 200), excerpt: n.excerpt.slice(0, 300), updatedAt: n.updatedAt })) };
          break;
        }
        case "get_note":
          result = noteResult(note(q, call.arguments.noteId), call.arguments.offset, call.arguments.limit);
          break;
        case "capture_inbox":
        case "propose_note_update": {
          const args = call.arguments;
          const hash = callHash(call);
          const previous = q.get<{ content_hash: string; outcome: string }>(
            "SELECT content_hash,outcome FROM agent_requests WHERE token_id=? AND tool=? AND request_id=?",
            [token.id, call.name, args.requestId]);
          if (previous) {
            const replay = replayResult(previous, hash);
            result = replay;
            if ("inboxItemId" in replay) target = replay.inboxItemId;
            break;
          }
          const id = randomUUID();
          if (call.name === "capture_inbox") {
            const capture = call.arguments;
            q.run("INSERT INTO inbox_items(id,title,body,source) VALUES (?,?,?,'agent')",
              [id, capture.title ?? (capture.text.split("\n")[0] ?? "").slice(0, 200), capture.text]);
            result = { inboxItemId: id };
            target = id;
          } else {
            const proposal = call.arguments;
            checkVersion(note(q, proposal.noteId), proposal.expectedVersion);
            q.run(`INSERT INTO agent_proposals(id,token_id,note_id,expected_version,patch)
              VALUES (?,?,?,?,?)`, [id, token.id, proposal.noteId, proposal.expectedVersion, JSON.stringify(proposal.patch)]);
            result = { proposalId: id, status: "pending" };
          }
          q.run("INSERT INTO agent_requests(token_id,tool,request_id,content_hash,outcome) VALUES (?,?,?,?,?)",
            [token.id, call.name, args.requestId, hash, JSON.stringify(result)]);
          break;
        }
      }
      audit(q, token.id, call.name, "ok", target);
      return result;
    });
  } catch (error) {
    if (tokenId) {
      const failedTokenId = tokenId;
      const status = error instanceof ApiError && ["unauthorized", "forbidden"].includes(error.code) ? "denied" : "error";
      store.transaction((q) => audit(q, failedTokenId, call.name, status, callTarget(call)));
    }
    throw error;
  }
}
