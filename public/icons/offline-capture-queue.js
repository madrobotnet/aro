export const STORAGE_KEY = "aro.offline-captures.v1";
export const LOCK_NAME = "aro.offline-captures.v1";
export const LEGACY_STORAGE_KEY = "irang.offline-captures.v1";
export const MAX_DRAFTS = 50;
export const MAX_BYTES = 512 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export class DraftError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "DraftError";
    this.code = code;
  }
}

function serialize(drafts) {
  if (!Array.isArray(drafts) || drafts.length > MAX_DRAFTS) {
    throw new DraftError("storage", "Draft storage is invalid or exceeds 50 drafts. Existing data was not changed.");
  }
  const ids = new Set();
  for (const draft of drafts) {
    if (!draft || !UUID.test(draft.requestId) || ids.has(draft.requestId)
      || typeof draft.text !== "string" || draft.text.length > 20_000
      || typeof draft.url !== "string" || draft.url.length > 2_000
      || typeof draft.title !== "string" || draft.title.length > 300
      || (!draft.text.trim() && !draft.url.trim())
      || typeof draft.createdAt !== "string" || !Number.isFinite(Date.parse(draft.createdAt))
      || Object.keys(draft).some((key) => !["requestId", "text", "url", "title", "createdAt"].includes(key))) {
      throw new DraftError("storage", "Draft data is invalid. Existing data was not changed.");
    }
    ids.add(draft.requestId);
  }
  const value = JSON.stringify(drafts);
  // Bound actual localStorage UTF-16 usage, including serialized metadata.
  if (value.length * 2 > MAX_BYTES) {
    throw new DraftError("storage", "Local drafts exceed 512 KiB. Delete a draft before saving more.");
  }
  return value;
}

export function readDrafts(storage) {
  try {
    const value = storage.getItem(STORAGE_KEY);
    const drafts = value === null ? [] : JSON.parse(value);
    serialize(drafts);
    return drafts;
  } catch (error) {
    if (error instanceof DraftError) throw error;
    throw new DraftError("storage", "Cannot read local drafts. Browser storage may be blocked or damaged; existing data was not changed.");
  }
}

export function writeDrafts(storage, drafts) {
  const value = serialize(drafts);
  try {
    storage.setItem(STORAGE_KEY, value);
  } catch {
    throw new DraftError("storage", "Could not save locally. Storage may be full or blocked. Keep this page open and copy your text.");
  }
}

/** Caller holds the new Web Lock and the legacy lock during the move. */
export function migrateDrafts(storage) {
  const value = storage.getItem(LEGACY_STORAGE_KEY);
  if (value === null) return;
  const legacy = JSON.parse(value);
  serialize(legacy);
  const drafts = readDrafts(storage);
  const ids = new Set(drafts.map((draft) => draft.requestId));
  writeDrafts(storage, [...drafts, ...legacy.filter((draft) => !ids.has(draft.requestId))]);
  storage.removeItem(LEGACY_STORAGE_KEY);
}

export function draftSnapshot(storage) {
  return serialize(readDrafts(storage));
}

export async function prepareFlush(storage, fetcher) {
  const snapshot = draftSnapshot(storage);
  if (readDrafts(storage).length === 0) throw new DraftError("empty", "No drafts to send.");
  const response = await fetcher("/api/capture", { method: "GET", credentials: "same-origin", cache: "no-store" });
  if (!response.ok) throw new DraftError("auth", "Log in online, then prepare sending again.");
  const identity = await response.json();
  if (typeof identity.ownerId !== "string" || typeof identity.sessionId !== "string"
    || !/^[0-9a-f-]{36}$/.test(identity.ownerId) || !/^[0-9a-f-]{36}$/.test(identity.sessionId)) {
    throw new DraftError("auth", "Could not verify the current owner. Nothing was sent.");
  }
  return { ...identity, snapshot };
}

/** Caller holds the cross-tab Web Lock. Never called from online/load/SW events. */
export async function flushDrafts(storage, confirmation, fetcher) {
  if (!confirmation || draftSnapshot(storage) !== confirmation.snapshot) {
    throw new DraftError("confirmation", "Drafts changed. Review and confirm sending again.");
  }
  const drafts = readDrafts(storage);
  let sent = 0;
  while (drafts.length) {
    const draft = drafts[0];
    let response;
    try {
      response = await fetcher("/api/capture", {
        method: "POST", credentials: "same-origin", cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          requestId: draft.requestId, text: draft.text, url: draft.url, title: draft.title,
          confirmedSessionId: confirmation.sessionId,
        }),
      });
    } catch {
      throw new DraftError("ambiguous", "Connection lost. This draft may already be in the inbox. Prepare and confirm again to retry safely.");
    }
    if (!response.ok) {
      throw new DraftError(response.status === 401 ? "auth" : response.status === 409 ? "conflict" : "http",
        `Sending stopped (HTTP ${response.status}). Remaining drafts were kept. Log in if needed, then review and confirm again.`);
    }
    let result;
    try { result = await response.json(); } catch {
      throw new DraftError("ambiguous", "Unreadable response. Draft kept; confirm again to retry the same request safely.");
    }
    if (!result?.item || typeof result.item.id !== "string" || !/^[0-9a-f-]{36}$/i.test(result.item.id)) {
      throw new DraftError("ambiguous", "Unverified response. Draft kept; confirm again to retry safely.");
    }
    // If deletion fails, stop with the original UUID still durable for a safe replay.
    writeDrafts(storage, drafts.slice(1));
    drafts.shift();
    sent += 1;
  }
  return sent;
}
