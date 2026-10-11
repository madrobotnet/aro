import { z } from "zod";
import { createChatMessageStream, getChatRequestOutcome } from "@/server/chat/service";
import { json, parseJson, withApi } from "@/server/http";
import { localeFromRequest } from "@/lib/i18n/server";

export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };
const MessageBody = z.object({ content: z.string().trim().min(1).max(8_000), requestId: z.string().uuid() }).strict();

export const GET = withApi<Context>(async (request, { params }) => {
  const { id } = await params;
  const requestId = z.string().uuid().parse(new URL(request.url).searchParams.get("requestId"));
  return json(await getChatRequestOutcome(id, requestId));
});

export const POST = withApi<Context>(async (request, { params }) => {
  const { id } = await params;
  const input = await parseJson(request, MessageBody);
  return createChatMessageStream(id, input.content, { requestId: input.requestId, signal: request.signal, locale: localeFromRequest(request) });
});
