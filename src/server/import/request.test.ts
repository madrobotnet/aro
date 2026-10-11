import { describe, expect, test } from "bun:test";
import { IMPORT_LIMITS } from "@/lib/import-format";
import { readImportUpload } from "./request";

function upload(body: BodyInit, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/import/preview", {
    method: "POST", body, headers: {
      "content-type": "application/octet-stream",
      "x-import-filename": encodeURIComponent("한글.md"),
      ...headers,
    },
  });
}

describe("bounded import request", () => {
  test("reads exact bytes and decodes a Unicode filename", async () => {
    const result = await readImportUpload(upload("hello"));
    expect(result.filename).toBe("한글.md");
    expect(new TextDecoder().decode(result.bytes)).toBe("hello");
  });

  test("rejects an oversized declared body before consuming it", async () => {
    await expect(readImportUpload(upload("small", { "content-length": String(IMPORT_LIMITS.uploadBytes + 1) })))
      .rejects.toMatchObject({ code: "payload_too_large" });
  });

  test("bounds streamed bytes even without content length and cancels the source", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)); },
      cancel() { cancelled = true; },
    });

    await expect(readImportUpload(upload(stream))).rejects.toMatchObject({ code: "payload_too_large" });

    expect(cancelled).toBe(true);
  });

  test("rejects malformed filenames and wrong content types", async () => {
    await expect(readImportUpload(upload("hello", { "x-import-filename": "%zz" })))
      .rejects.toMatchObject({ code: "validation" });
    await expect(readImportUpload(upload("hello", { "content-type": "application/json" })))
      .rejects.toMatchObject({ code: "validation" });
  });
});
