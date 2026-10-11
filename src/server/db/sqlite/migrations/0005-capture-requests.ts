import { uuidV1 } from "./columns-v1";

export const captureRequestsV1 = [
  `CREATE TABLE capture_requests (
    id TEXT PRIMARY KEY NOT NULL ${uuidV1("id")},
    owner_id TEXT NOT NULL ${uuidV1("owner_id")},
    content TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK (json_valid(outcome) AND json_type(outcome) = 'object')
  ) STRICT`,
] as const;
