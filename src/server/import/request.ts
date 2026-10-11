import { IMPORT_LIMITS } from "@/lib/import-format";
import { ApiError } from "@/server/http";

/** Raw file uploads avoid buffering a multipart envelope before enforcing the byte limit. */
export async function readImportUpload(request: Request): Promise<{ filename: string; bytes: Uint8Array }> {
  const rawName = request.headers.get("x-import-filename");
  if (!rawName || rawName.length > 2048) throw new ApiError("validation", "An import filename is required.");
  let filename: string;
  try {
    filename = decodeURIComponent(rawName);
  } catch (error) {
    if (!(error instanceof URIError)) throw error;
    throw new ApiError("validation", "The import filename is invalid.");
  }
  if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/octet-stream") {
    throw new ApiError("validation", "Send the file as application/octet-stream.");
  }
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > IMPORT_LIMITS.uploadBytes)) {
    throw new ApiError("payload_too_large", "Import uploads are limited to 24 MiB.");
  }
  if (!request.body) throw new ApiError("validation", "The import file is empty.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > IMPORT_LIMITS.uploadBytes) {
        await reader.cancel();
        throw new ApiError("payload_too_large", "Import uploads are limited to 24 MiB.");
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { filename, bytes };
}
