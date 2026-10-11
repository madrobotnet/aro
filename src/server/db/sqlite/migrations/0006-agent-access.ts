import { createdV1, ID_V1, optionalTimeV1, uuidV1 } from "./columns-v1";

export const agentAccessV1 = [
  `CREATE TABLE agent_tokens (
    ${ID_V1},
    owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    prefix TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash)=64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
    scopes TEXT NOT NULL CHECK (json_valid(scopes) AND json_type(scopes)='array'),
    allowed_note_ids TEXT NOT NULL CHECK (json_valid(allowed_note_ids) AND json_type(allowed_note_ids)='array'),
    ${createdV1()},
    ${optionalTimeV1("revoked_at")}
  ) STRICT`,
  `CREATE TABLE agent_proposals (
    ${ID_V1},
    token_id TEXT NOT NULL REFERENCES agent_tokens(id) ON DELETE CASCADE,
    note_id TEXT NOT NULL ${uuidV1("note_id")},
    expected_version TEXT NOT NULL,
    patch TEXT NOT NULL CHECK (json_valid(patch) AND json_type(patch)='object'),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
    ${createdV1()},
    ${optionalTimeV1("reviewed_at")}
  ) STRICT`,
  "CREATE INDEX agent_proposals_status_idx ON agent_proposals(status,created_at DESC,id)",
  `CREATE TABLE agent_requests (
    token_id TEXT NOT NULL REFERENCES agent_tokens(id) ON DELETE CASCADE,
    tool TEXT NOT NULL CHECK (tool IN ('capture_inbox','propose_note_update')),
    request_id TEXT NOT NULL ${uuidV1("request_id")},
    content_hash TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK (json_valid(outcome) AND json_type(outcome)='object'),
    PRIMARY KEY(token_id,tool,request_id)
  ) STRICT`,
  `CREATE TABLE agent_activity (
    ${ID_V1},
    token_id TEXT NOT NULL REFERENCES agent_tokens(id) ON DELETE CASCADE,
    tool TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('ok','denied','error')),
    target_id TEXT ${uuidV1("target_id")},
    ${createdV1()}
  ) STRICT`,
  "CREATE INDEX agent_activity_time_idx ON agent_activity(created_at DESC,id)",
] as const;
