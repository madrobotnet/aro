import { ApiError } from "@/server/http";

export const MAX_AGENT_BODY_BYTES = 96 * 1024;

export async function readBoundedText(message: Request | Response, limit = MAX_AGENT_BODY_BYTES): Promise<string> {
  const length = message.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) {
    await message.body?.cancel();
    throw new ApiError("payload_too_large", "Request exceeds the body size limit");
  }
  if (!message.body) throw new ApiError("validation", "Body is required");
  const reader = message.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new ApiError("payload_too_large", "Request exceeds the body size limit");
      }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new ApiError("validation", "Invalid UTF-8 body"); }
}

export async function readAgentJson(request: Request): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    throw new ApiError("validation", "Content-Type application/json is required");
  }
  const text = await readBoundedText(request);
  try { return JSON.parse(text); }
  catch { throw new ApiError("validation", "Invalid JSON body"); }
}
