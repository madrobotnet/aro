import { json } from "@/server/http";
import { withShareApi } from "@/server/shares/http";
import { revokeShare } from "@/server/shares/service";

export const runtime = "nodejs";
type Context = { params: Promise<{ id: string; shareId: string }> };
export const DELETE = withShareApi<Context>(async (_request, { params }, ownerId) => {
  const { id, shareId } = await params;
  await revokeShare({ noteId: id, shareId, ownerId });
  return json({ revoked: true });
});
