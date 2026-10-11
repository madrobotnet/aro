import { ApiError, json, withApi } from "@/server/http";
import { readImportUpload } from "@/server/import/request";
import { commitImport } from "@/server/import/service";

export const runtime = "nodejs";

export const POST = withApi(async (request) => {
  const digest = request.headers.get("x-import-digest");
  if (request.headers.get("x-import-confirm") !== "true" || !digest || !/^[0-9a-f]{64}$/.test(digest)) {
    throw new ApiError("validation", "Preview the upload and explicitly confirm the import first.", { imported: false });
  }
  const { filename, bytes } = await readImportUpload(request);
  return json(await commitImport(filename, bytes, digest), { status: 201 });
});
