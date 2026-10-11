import { aiAuthCopy } from "@/server/i18n/ai-auth-copy";
import { connectionIssueCopy } from "@/lib/i18n/ai-validation-copy";
import type { PoolClient } from "pg";
import { OAuthCredentialSchema, type OAuthCredential, type WebAuthProvider } from "@/lib/ai-auth";
import { ApiError } from "@/server/http";
import type { SQLiteExecutor } from "@/server/db/sqlite";
import { sqliteUuid } from "@/server/db/sqlite/values";

export type AiAuthScope = {
  readonly key: string;
  readonly browserHash?: string;
};

export function consumeSQLiteAuthAttempt(
  executor: SQLiteExecutor,
  claim: { readonly id: string; readonly provider: WebAuthProvider; readonly scope: AiAuthScope },
): OAuthCredential {
  if (!claim.scope.browserHash) throw new ApiError("forbidden", aiAuthCopy.saveInStartBrowser);
  const id = sqliteUuid(claim.id);
  const attempt = executor.get<{
    provider: string; status: string; scope_key: string; browser_hash: string; payload: string; expires_at: string;
  }>("SELECT provider,status,scope_key,browser_hash,payload,expires_at FROM ai_auth_attempts WHERE id=?", [id]);
  if (!attempt || attempt.provider !== claim.provider || attempt.scope_key !== claim.scope.key
    || attempt.browser_hash !== claim.scope.browserHash) {
    throw new ApiError("forbidden", aiAuthCopy.wrongConnection);
  }
  if (new Date(attempt.expires_at).getTime() <= Date.now() || attempt.status !== "ready") {
    throw new ApiError("conflict", aiAuthCopy.notReady);
  }
  const credential = OAuthCredentialSchema.parse(JSON.parse(attempt.payload));
  if (credential.provider !== claim.provider) throw new ApiError("conflict", connectionIssueCopy.credentialMismatch);
  executor.run("DELETE FROM ai_auth_attempts WHERE id=?", [id]);
  return credential;
}

/** Claim and delete in the caller's transaction, so rollback preserves the login. */
export async function consumeAuthAttempt(
  client: PoolClient,
  claim: { readonly id: string; readonly provider: WebAuthProvider; readonly scope: AiAuthScope },
): Promise<OAuthCredential> {
  if (!claim.scope.browserHash) throw new ApiError("forbidden", aiAuthCopy.saveInStartBrowser);
  const result = await client.query<{
    provider: string; status: string; scope_key: string; browser_hash: string;
    payload: unknown; valid: boolean;
  }>(
    `SELECT provider, status, scope_key, browser_hash, payload, expires_at > now() AS valid
     FROM ai_auth_attempts WHERE id = $1 FOR UPDATE`,
    [claim.id],
  );
  const attempt = result.rows[0];
  if (!attempt || attempt.provider !== claim.provider || attempt.scope_key !== claim.scope.key
    || attempt.browser_hash !== claim.scope.browserHash) {
    throw new ApiError("forbidden", aiAuthCopy.wrongConnection);
  }
  if (!attempt.valid || attempt.status !== "ready") {
    throw new ApiError("conflict", aiAuthCopy.notReady);
  }
  const credential = OAuthCredentialSchema.parse(attempt.payload);
  if (credential.provider !== claim.provider) throw new ApiError("conflict", connectionIssueCopy.credentialMismatch);
  await client.query("DELETE FROM ai_auth_attempts WHERE id = $1", [claim.id]);
  return credential;
}
