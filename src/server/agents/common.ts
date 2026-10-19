import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { AgentActivityDto, AgentProposalDto, AgentScope, AgentTokenDto, AgentToolCall, AgentToolName, CreateAgentTokenInput } from "@/lib/agent-access";
import { ApiError } from "@/server/http";

export type TokenRow = {
  readonly id: string; readonly owner_id: string; readonly name: string; readonly prefix: string;
  readonly scopes: string; readonly allowed_note_ids: string;
  readonly created_at: string | Date; readonly revoked_at: string | Date | null;
  readonly expires_at: string | Date | null; readonly oauth_grant_id: string | null; readonly resource: string | null;
};
export type ProposalRow = {
  readonly id: string; readonly token_id: string; readonly note_id: string; readonly expected_version: string;
  readonly patch: string; readonly status: AgentProposalDto["status"];
  readonly created_at: string | Date; readonly reviewed_at: string | Date | null;
};
export type ActivityRow = {
  readonly id: string; readonly token_id: string; readonly tool: string;
  readonly status: AgentActivityDto["status"]; readonly target_id: string | null; readonly created_at: string | Date;
};
export type AgentNoteRow = {
  readonly id: string; readonly title: string; readonly body: string;
  readonly updated_at: string; readonly deleted_at: string | Date | null;
  readonly tags: string; readonly aliases: string; readonly pinned: string; readonly status: string;
};
export const TOOL_SCOPES: Readonly<Record<AgentToolName, AgentScope>> = {
  search_notes: "read", get_note: "read", capture_inbox: "capture", propose_note_update: "propose-write",
};
export const digest = (content: string): string => createHash("sha256").update(content).digest("hex");
export const instant = (value: string | Date): string => new Date(value).toISOString();
export function tokenDto(row: TokenRow): AgentTokenDto {
  return { id: row.id, name: row.name, prefix: row.prefix, scopes: JSON.parse(row.scopes),
    allowedNoteIds: JSON.parse(row.allowed_note_ids), createdAt: instant(row.created_at),
    revokedAt: row.revoked_at ? instant(row.revoked_at) : null,
    expiresAt: row.expires_at ? instant(row.expires_at) : null, resource: row.resource };
}
export function proposalDto(row: ProposalRow): AgentProposalDto {
  return { id: row.id, tokenId: row.token_id, noteId: row.note_id, expectedVersion: row.expected_version,
    patch: JSON.parse(row.patch), status: row.status, createdAt: instant(row.created_at),
    reviewedAt: row.reviewed_at ? instant(row.reviewed_at) : null };
}
export function activityDto(row: ActivityRow): AgentActivityDto {
  return { id: row.id, tokenId: row.token_id, tool: row.tool, status: row.status,
    targetId: row.target_id, createdAt: instant(row.created_at) };
}
export function newToken(input: CreateAgentTokenInput, ownerId: string): { row: TokenRow; secret: string; hash: string } {
  const secret = `aro_agent_${randomBytes(32).toString("base64url")}`;
  return { secret, hash: digest(secret), row: {
    id: randomUUID(), owner_id: ownerId, name: input.name, prefix: secret.slice(0, 18),
    scopes: JSON.stringify(input.scopes), allowed_note_ids: JSON.stringify(input.allowedNoteIds),
    created_at: new Date().toISOString(), revoked_at: null, expires_at: null, oauth_grant_id: null, resource: null,
  } };
}
export function requireToken(row: TokenRow | null): TokenRow {
  if (!row || row.revoked_at || (row.expires_at && new Date(row.expires_at).getTime() <= Date.now())) {
    throw new ApiError("unauthorized", "Agent token is invalid, expired or revoked");
  }
  return row;
}
export function requireScope(row: TokenRow, scope: AgentScope, noteId?: string): void {
  const token = tokenDto(row);
  if (row.revoked_at || (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) || !token.scopes.includes(scope) ||
      (scope === "propose-write" && noteId !== undefined && !token.allowedNoteIds.includes(noteId))) {
    throw new ApiError("forbidden", "Agent token does not grant this operation");
  }
}
export function requireNote(row: AgentNoteRow | null): AgentNoteRow {
  if (!row || row.deleted_at) throw new ApiError("not_found", "Active note not found");
  return row;
}
/** Includes exact native timestamp and content; detects edits within one millisecond too. */
export const noteVersion = (row: AgentNoteRow): string =>
  digest(JSON.stringify([row.id, row.title, row.body, row.tags, row.aliases, row.pinned, row.status, row.updated_at]));
export function checkVersion(row: AgentNoteRow, expected: string): void {
  if (noteVersion(row) !== expected) throw new ApiError("conflict", "Note changed since proposal was prepared");
}
export function noteResult(row: AgentNoteRow, offset: number, limit: number) {
  const body = row.body.slice(offset, offset + limit);
  return { id: row.id, title: row.title.slice(0, 200), body, offset,
    nextOffset: offset + body.length < row.body.length ? offset + body.length : null,
    version: noteVersion(row), updatedAt: instant(row.updated_at) };
}
export type AgentWriteResult = { readonly inboxItemId: string } | { readonly proposalId: string; readonly status: "pending" };
export function replayResult(row: { readonly content_hash: string; readonly outcome: string }, hash: string): AgentWriteResult {
  if (row.content_hash !== hash) throw new ApiError("conflict", "Request ID is already bound to different content");
  return JSON.parse(row.outcome);
}
export const callHash = (call: AgentToolCall): string => digest(JSON.stringify(call.arguments));
export const callTarget = (call: AgentToolCall): string | null =>
  "noteId" in call.arguments ? call.arguments.noteId : null;
export function reviewState(row: ProposalRow, decision: "approved" | "rejected"): boolean {
  if (row.status === decision) return true;
  if (row.status !== "pending") throw new ApiError("conflict", "Proposal was already reviewed");
  return false;
}
