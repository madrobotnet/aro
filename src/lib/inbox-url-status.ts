export const URL_PENDING_MARKER = "<!-- aro:url-status:pending -->";
export const URL_FAILED_MARKER = "<!-- aro:url-status:failed -->";

const LEGACY_PENDING = new Set(["<!-- second-brain:url-status:pending -->", "> URL 내용을 가져오는 중입니다."]);
const LEGACY_FAILED = new Set([
  "<!-- second-brain:url-status:failed -->",
  "> URL 내용을 가져오지 못했습니다. 원문 링크는 보존되었습니다.",
]);

function lineStatus(line: string): "pending" | "failed" | null {
  if (line === URL_PENDING_MARKER || LEGACY_PENDING.has(line)) return "pending";
  if (line === URL_FAILED_MARKER || LEGACY_FAILED.has(line)) return "failed";
  return null;
}

export function inboxUrlStatus(body: string): "pending" | "failed" | null {
  for (const line of body.split(/\r?\n/)) {
    const status = lineStatus(line);
    if (status) return status;
  }
  return null;
}

export function stripInboxUrlStatus(body: string): string {
  return body.split(/\r?\n/).filter((line) => lineStatus(line) === null).join("\n").trim();
}

export function replacePendingInboxUrlStatus(body: string, replacement: string): string {
  return body.split(/\r?\n/).map((line) => lineStatus(line) === "pending" ? replacement : line).join("\n");
}
