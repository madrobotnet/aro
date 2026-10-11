import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { AgentProposalDto, AgentToolCall, CreateAgentTokenInput } from "@/lib/agent-access";
import { db, tx } from "@/server/db";
import { ApiError } from "@/server/http";
import { updateNote } from "@/server/notes/service";
import {
  activityDto, callHash, callTarget, checkVersion, digest, newToken, noteResult, proposalDto,
  replayResult, requireNote, requireScope, requireToken, reviewState, tokenDto, TOOL_SCOPES,
  type ActivityRow, type AgentNoteRow, type ProposalRow, type TokenRow,
} from "./common";

type Executor = Pick<PoolClient, "query">;
async function owner(q: Executor): Promise<string> {
  const result = await q.query<{ id: string }>("SELECT id FROM users ORDER BY created_at,id LIMIT 1");
  const row = result.rows[0];
  if (!row) throw new ApiError("forbidden", "Owner has not been configured");
  return row.id;
}
async function findToken(q: Executor, hash: string, lock = false): Promise<TokenRow | null> {
  const result = await q.query<TokenRow>(`SELECT * FROM agent_tokens WHERE token_hash=$1 AND owner_id=$2${lock ? " FOR UPDATE" : ""}`,
    [hash, await owner(q)]);
  return result.rows[0] ?? null;
}
async function note(q: Executor, id: string, lock = false): Promise<AgentNoteRow> {
  const result = await q.query<AgentNoteRow>(`SELECT id,title,body,deleted_at,
    to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at,
    tags::text AS tags,aliases::text AS aliases,pinned::text AS pinned,status
    FROM notes WHERE id=$1${lock ? " FOR UPDATE" : ""}`, [id]);
  return requireNote(result.rows[0] ?? null);
}
async function audit(q: Executor, tokenId: string, tool: string, status: ActivityRow["status"], target: string | null): Promise<void> {
  await q.query("INSERT INTO agent_activity(id,token_id,tool,status,target_id) VALUES ($1,$2,$3,$4,$5)",
    [randomUUID(), tokenId, tool, status, target]);
}
export async function createToken(input: CreateAgentTokenInput) {
  return tx(async (q) => {
    for (const id of input.allowedNoteIds) await note(q, id);
    const created = newToken(input, await owner(q));
    const row = created.row;
    const inserted = await q.query<TokenRow>(`INSERT INTO agent_tokens(id,owner_id,name,prefix,token_hash,scopes,allowed_note_ids)
      VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [row.id, row.owner_id, row.name, row.prefix, created.hash, row.scopes, row.allowed_note_ids]);
    const persisted = inserted.rows[0];
    if (!persisted) throw new ApiError("internal", "Token insert failed");
    return { token: tokenDto(persisted), secret: created.secret };
  });
}
export async function listTokens() {
  const q = await db();
  return (await q.query<TokenRow>("SELECT * FROM agent_tokens WHERE owner_id=$1 ORDER BY created_at DESC,id DESC", [await owner(q)])).rows.map(tokenDto);
}
export async function revokeToken(id: string): Promise<void> {
  const q = await db();
  const result = await q.query("UPDATE agent_tokens SET revoked_at=coalesce(revoked_at,now()) WHERE id=$1 AND owner_id=$2",
    [id, await owner(q)]);
  if (!result.rowCount) throw new ApiError("not_found", "Agent token not found");
}
export async function authenticate(secret: string) {
  return tokenDto(requireToken(await findToken(await db(), digest(secret))));
}
export async function listActivity(limit: number) {
  const q = await db();
  return (await q.query<ActivityRow>(`SELECT a.* FROM agent_activity a JOIN agent_tokens t ON t.id=a.token_id
    WHERE t.owner_id=$1 ORDER BY a.created_at DESC,a.id DESC LIMIT $2`, [await owner(q), limit])).rows.map(activityDto);
}
export async function listProposals(status: AgentProposalDto["status"], limit: number) {
  const q = await db();
  return (await q.query<ProposalRow>(`SELECT p.* FROM agent_proposals p JOIN agent_tokens t ON t.id=p.token_id
    WHERE t.owner_id=$1 AND p.status=$2 ORDER BY p.created_at DESC,p.id DESC LIMIT $3`, [await owner(q), status, limit])).rows.map(proposalDto);
}
export async function reviewProposal(id: string, decision: "approved" | "rejected") {
  return tx(async (q) => {
    const found = await q.query<ProposalRow>(`SELECT p.* FROM agent_proposals p JOIN agent_tokens t ON t.id=p.token_id
      WHERE p.id=$1 AND t.owner_id=$2`, [id, await owner(q)]);
    const initial = found.rows[0];
    if (!initial) throw new ApiError("not_found", "Proposal not found");
    // Token first, then proposal, then note: same order as tool calls; revocation takes
    // an exclusive token lock and cannot commit ahead of an in-flight approval.
    const tokens = await q.query<TokenRow>("SELECT * FROM agent_tokens WHERE id=$1 FOR SHARE", [initial.token_id]);
    const locked = await q.query<ProposalRow>("SELECT * FROM agent_proposals WHERE id=$1 FOR UPDATE", [id]);
    const row = locked.rows[0];
    if (!row) throw new ApiError("not_found", "Proposal not found");
    if (reviewState(row, decision)) return proposalDto(row);
    if (decision === "approved") {
      const token = tokens.rows[0];
      if (!token) throw new ApiError("forbidden", "Proposal token no longer exists");
      requireScope(token, "propose-write", row.note_id);
      checkVersion(await note(q, row.note_id, true), row.expected_version);
      await updateNote(row.note_id, proposalDto(row).patch, { client: q, reason: "merge" });
    }
    const updated = await q.query<ProposalRow>("UPDATE agent_proposals SET status=$2,reviewed_at=now() WHERE id=$1 RETURNING *", [row.id, decision]);
    const reviewed = updated.rows[0];
    if (!reviewed) throw new ApiError("internal", "Proposal review failed");
    await audit(q, row.token_id, `proposal/${decision}`, "ok", row.note_id);
    return proposalDto(reviewed);
  });
}
export async function callTool(secret: string, call: AgentToolCall): Promise<unknown> {
  let tokenId: string | null = null;
  try {
    return await tx(async (q) => {
      const found = await findToken(q, digest(secret), true);
      tokenId = found?.id ?? null;
      const token = requireToken(found);
      requireScope(token, TOOL_SCOPES[call.name], callTarget(call) ?? undefined);
      const recent = await q.query<{ total: string }>(
        "SELECT count(*) AS total FROM agent_activity WHERE token_id=$1 AND created_at>=now()-interval '1 minute'", [token.id]);
      if (Number(recent.rows[0]?.total ?? 0) >= 120) throw new ApiError("rate_limited", "Agent tool rate limit exceeded");
      let result: unknown;
      let target = callTarget(call);
      switch (call.name) {
        case "search_notes": {
          const matches = await q.query<{ id: string; title: string; excerpt: string; updated_at: Date }>(
            `SELECT id,left(title,200) AS title,left(body,300) AS excerpt,updated_at FROM notes
             WHERE deleted_at IS NULL AND status<>'archived' AND (title ILIKE $1 OR body ILIKE $1)
             ORDER BY updated_at DESC,id DESC LIMIT $2`, [`%${call.arguments.query}%`, call.arguments.limit]);
          result = { notes: matches.rows.map((n) => ({ id: n.id, title: n.title, excerpt: n.excerpt, updatedAt: n.updated_at.toISOString() })) };
          break;
        }
        case "get_note":
          result = noteResult(await note(q, call.arguments.noteId), call.arguments.offset, call.arguments.limit);
          break;
        case "capture_inbox":
        case "propose_note_update": {
          const args = call.arguments;
          const hash = callHash(call);
          await q.query("SELECT pg_advisory_xact_lock(hashtextextended($1,7431013))", [`${token.id}:${call.name}:${args.requestId}`]);
          const previous = await q.query<{ content_hash: string; outcome: string }>(
            "SELECT content_hash,outcome FROM agent_requests WHERE token_id=$1 AND tool=$2 AND request_id=$3",
            [token.id, call.name, args.requestId]);
          const replay = previous.rows[0];
          if (replay) {
            const outcome = replayResult(replay, hash);
            result = outcome;
            if ("inboxItemId" in outcome) target = outcome.inboxItemId;
            break;
          }
          const id = randomUUID();
          if (call.name === "capture_inbox") {
            const capture = call.arguments;
            await q.query("INSERT INTO inbox_items(id,title,body,source) VALUES ($1,$2,$3,'agent')",
              [id, capture.title ?? (capture.text.split("\n")[0] ?? "").slice(0, 200), capture.text]);
            result = { inboxItemId: id };
            target = id;
          } else {
            const proposal = call.arguments;
            checkVersion(await note(q, proposal.noteId, true), proposal.expectedVersion);
            await q.query(`INSERT INTO agent_proposals(id,token_id,note_id,expected_version,patch)
              VALUES ($1,$2,$3,$4,$5)`, [id, token.id, proposal.noteId, proposal.expectedVersion, JSON.stringify(proposal.patch)]);
            result = { proposalId: id, status: "pending" };
          }
          await q.query("INSERT INTO agent_requests(token_id,tool,request_id,content_hash,outcome) VALUES ($1,$2,$3,$4,$5)",
            [token.id, call.name, args.requestId, hash, JSON.stringify(result)]);
          break;
        }
      }
      await audit(q, token.id, call.name, "ok", target);
      return result;
    });
  } catch (error) {
    if (tokenId) {
      const status = error instanceof ApiError && ["unauthorized", "forbidden"].includes(error.code) ? "denied" : "error";
      await audit(await db(), tokenId, call.name, status, callTarget(call));
    }
    throw error;
  }
}
