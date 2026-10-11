import { ZodError } from "zod";
import { getSession } from "@/server/auth/session";
import { ApiError, errorResponse, withApi } from "@/server/http";

/** Keep database failure details (which can include snapshot data) out of logs. */
export function withShareApi<C>(handler: (request: Request, context: C, ownerId: string) => Promise<Response>) {
  return withApi<C>(async (request, context) => {
    try {
      const session = await getSession();
      if (!session) return errorResponse("unauthorized", "Login required");
      return await handler(request, context, session.userId);
    } catch (error) {
      if (error instanceof ApiError || error instanceof ZodError) throw error;
      return errorResponse("internal", { ko: "공유 요청에 실패했습니다.", en: "Sharing request failed." });
    }
  });
}
