import { after } from "next/server";
import { z } from "zod";
import { captureInbox, enrichInboxItem } from "@/server/inbox";
import { ApiError, json, parseJson, withApi } from "@/server/http";
import { localeFromRequest } from "@/lib/i18n/server";
import { getSession } from "@/server/auth/session";

export const runtime = "nodejs";

const CaptureBody = z.object({
  text: z.string().max(2_000_000).optional(),
  url: z.string().max(2_000).optional(),
  title: z.string().max(300).optional(),
}).strict();

const QueuedCaptureBody = CaptureBody.extend({
  text: z.string().max(20_000).optional(),
  requestId: z.string().uuid(),
  confirmedSessionId: z.string().uuid(),
}).strict();

/** Fresh identity for a user-visible, memory-only flush confirmation. */
export const GET = withApi(async () => {
  const session = await getSession();
  if (!session) throw new ApiError("unauthorized", "Login required");
  return json({ ownerId: session.userId, sessionId: session.id });
});

export const POST = withApi(async (request) => {
  const locale = localeFromRequest(request);
  const input = await parseJson(request, z.union([QueuedCaptureBody, CaptureBody]));
  if ("requestId" in input) {
    const session = await getSession();
    if (!session) throw new ApiError("unauthorized", "Login required");
    if (input.confirmedSessionId !== session.id) {
      throw new ApiError("conflict", "Login changed. Review the current owner and confirm sending again");
    }
    const item = await captureInbox(input, locale, { requestId: input.requestId, ownerId: session.userId });
    // Queued intake is capture only: no optional AI/URL calls on first send or replay.
    return json({ item }, { status: 201 });
  }
  const item = await captureInbox(input, locale);
  after(async () => { await enrichInboxItem(item.id, {}, locale); });
  return json({ item }, { status: 201 });
});
