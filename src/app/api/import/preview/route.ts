import { json, withApi } from "@/server/http";
import { readImportUpload } from "@/server/import/request";
import { previewImport } from "@/server/import/service";

export const runtime = "nodejs";

export const POST = withApi(async (request) => {
  const { filename, bytes } = await readImportUpload(request);
  return json(await previewImport(filename, bytes));
});
