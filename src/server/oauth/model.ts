import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { AgentScopeSchema, type AgentScope } from "@/lib/agent-access";
import { digest, instant, newToken } from "@/server/agents/common";

export class OAuthError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message);
    this.name = "OAuthError";
  }
}
export type ClientRow = {
  readonly id: string; readonly name: string; readonly redirect_uris: string; readonly created_at: string | Date;
  readonly auth_method: "none" | "client_secret_basic" | "client_secret_post"; readonly secret_hash: string | null;
};
export type GrantRow = {
  readonly id: string; readonly owner_id: string; readonly client_id: string; readonly resource: string;
  readonly scopes: string; readonly allowed_note_ids: string;
  readonly created_at: string | Date; readonly revoked_at: string | Date | null;
};
export type CodeRow = {
  readonly code_hash: string; readonly grant_id: string; readonly redirect_uri: string;
  readonly code_challenge: string; readonly expires_at: string | Date; readonly consumed_at: string | Date | null;
};
export type RefreshRow = {
  readonly token_hash: string; readonly grant_id: string;
  readonly expires_at: string | Date; readonly consumed_at: string | Date | null;
};
export type ConnectionRow = GrantRow & {
  readonly name: string; readonly last_used_at: string | Date | null;
};
export type Authorization = {
  readonly client: ClientRow; readonly redirectUri: string; readonly challenge: string;
  readonly state?: string; readonly scopes: readonly AgentScope[]; readonly resource: string;
};
export type Exchange = {
  readonly clientId: string; readonly resource: string; readonly now: Date;
} & (
  | { readonly kind: "code"; readonly hash: string; readonly redirectUri: string; readonly verifier: string }
  | { readonly kind: "refresh"; readonly hash: string; readonly scopes?: readonly AgentScope[] }
);
export const scopeList = (json: string): AgentScope[] => z.array(AgentScopeSchema).parse(JSON.parse(json));
export const expired = (date: string | Date, now: Date): boolean => new Date(date).getTime() <= now.getTime();
export const secret = (): string => randomBytes(32).toString("base64url");
export function pkceMatches(verifier: string, challenge: string): boolean {
  const actual = createHash("sha256").update(verifier).digest("base64url");
  return actual.length === challenge.length && timingSafeEqual(Buffer.from(actual), Buffer.from(challenge));
}
export function newAuthorization(auth: Authorization, ownerId: string, scopes: readonly AgentScope[]) {
  const now = new Date();
  const code = secret();
  const grant: GrantRow = {
    id: randomUUID(), owner_id: ownerId, client_id: auth.client.id, resource: auth.resource,
    scopes: JSON.stringify(scopes), allowed_note_ids: "[]", created_at: now, revoked_at: null,
  };
  return { grant, code, row: {
    code_hash: digest(code), grant_id: grant.id, redirect_uri: auth.redirectUri,
    code_challenge: auth.challenge, expires_at: new Date(now.getTime() + 600_000), consumed_at: null,
  } satisfies CodeRow };
}
export function tokenPair(grant: GrantRow, name: string, now: Date, scopes = scopeList(grant.scopes)) {
  const access = newToken({ name, scopes, allowedNoteIds: JSON.parse(grant.allowed_note_ids) }, grant.owner_id);
  const refresh = secret();
  return {
    access, accessExpires: new Date(now.getTime() + 3_600_000),
    refreshHash: digest(refresh), refreshExpires: new Date(now.getTime() + 30 * 86_400_000),
    response: { access_token: access.secret, token_type: "Bearer", expires_in: 3600,
      refresh_token: refresh, scope: scopes.join(" ") },
  };
}
export type TokenResponse = ReturnType<typeof tokenPair>["response"];
export function connectionDto(row: ConnectionRow) {
  return { id: row.id, clientName: row.name, scopes: scopeList(row.scopes),
    allowedNoteIds: z.array(z.string()).parse(JSON.parse(row.allowed_note_ids)),
    createdAt: instant(row.created_at), revokedAt: row.revoked_at ? instant(row.revoked_at) : null,
    lastUsedAt: row.last_used_at ? instant(row.last_used_at) : null };
}
