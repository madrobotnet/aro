import { tx } from "@/server/db";
import { databaseBackend, sqliteStore } from "@/server/db/backend";
import { ApiError } from "@/server/http";
import { assertInboxId, mapItem, type CaptureInboxInput, type InboxItemDto, type InboxRow } from "./service";

export type CaptureReplay = { readonly requestId: string; readonly ownerId: string };
type StoredReplay = { owner_id: string; content: string; outcome: string };

function replayOutcome(row: StoredReplay, ownerId: string, content: string): InboxItemDto {
  if (row.owner_id !== ownerId || row.content !== content) {
    throw new ApiError("conflict", "Capture request identity is already bound to another owner or content");
  }
  // Repository-owned serialized DTO, committed with the original inbox insert.
  return JSON.parse(row.outcome);
}

/** No provider/network work inside either transaction; outcomes survive item edits/deletion. */
export async function persistCaptureReplay(
  input: CaptureInboxInput,
  replay: CaptureReplay,
  title: string,
  body: string,
  url: string | null,
): Promise<InboxItemDto> {
  assertInboxId(replay.requestId);
  assertInboxId(replay.ownerId);
  const requestId = replay.requestId.toLowerCase();
  const ownerId = replay.ownerId.toLowerCase();
  const source = input.source ?? (url ? "url" : "web");
  const content = JSON.stringify([input.text ?? null, input.url ?? null, input.title ?? null, input.source ?? null]);
  if (databaseBackend() === "sqlite") {
    return (await sqliteStore()).transaction((q) => {
      const previous = q.get<StoredReplay>("SELECT owner_id,content,outcome FROM capture_requests WHERE id=?", [requestId]);
      if (previous) return replayOutcome(previous, ownerId, content);
      const row = q.get<InboxRow>(
        "INSERT INTO inbox_items(title,body,source,url) VALUES (?,?,?,?) RETURNING *",
        [title, body, source, url],
      );
      if (!row) throw new ApiError("internal", "Inbox insert did not return a row");
      const item = mapItem(row);
      q.run("INSERT INTO capture_requests(id,owner_id,content,outcome) VALUES (?,?,?,?)",
        [requestId, ownerId, content, JSON.stringify(item)]);
      return item;
    });
  }
  return tx(async (client) => {
    // Concurrent first attempts must serialize before testing for an absent row.
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 7431012))", [requestId]);
    const previous = await client.query<StoredReplay>(
      "SELECT owner_id,content,outcome FROM capture_requests WHERE id=$1", [requestId],
    );
    const stored = previous.rows[0];
    if (stored) return replayOutcome(stored, ownerId, content);
    const inserted = await client.query<InboxRow>(
      "INSERT INTO inbox_items(title,body,source,url) VALUES ($1,$2,$3,$4) RETURNING *",
      [title, body, source, url],
    );
    const row = inserted.rows[0];
    if (!row) throw new ApiError("internal", "Inbox insert did not return a row");
    const item = mapItem(row);
    await client.query("INSERT INTO capture_requests(id,owner_id,content,outcome) VALUES ($1,$2,$3,$4)",
      [requestId, ownerId, content, JSON.stringify(item)]);
    return item;
  });
}
