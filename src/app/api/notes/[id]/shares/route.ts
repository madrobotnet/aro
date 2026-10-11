import { json, parseJson } from "@/server/http";
import { withShareApi } from "@/server/shares/http";
import { createShare, listShares, shareInput } from "@/server/shares/service";

export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };
export const GET = withShareApi<Context>(async (_request, { params }, ownerId) =>
  json({ shares: await listShares((await params).id, ownerId) }));
export const POST = withShareApi<Context>(async (request, { params }, ownerId) => {
  const input = await parseJson(request, shareInput);
  return json(await createShare({ ...input, noteId: (await params).id, ownerId }), { status: 201 });
});
