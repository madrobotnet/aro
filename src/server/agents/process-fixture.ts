import { z } from "zod";
import { AgentToolCallSchema } from "@/lib/agent-access";
import { ApiError } from "@/server/http";
import { authenticate, callTool } from "./service";

const Command = z.object({ action: z.enum(["authenticate", "read"]), secret: z.string(), noteId: z.string() }).strict();

process.on("message", async (message: unknown) => {
  try {
    const input = Command.parse(message);
    if (input.action === "authenticate") await authenticate(input.secret);
    else await callTool(input.secret, AgentToolCallSchema.parse({ name: "get_note", arguments: { noteId: input.noteId } }));
    process.send?.({ ok: true });
  } catch (error) {
    process.send?.({ ok: false, code: error instanceof ApiError ? error.code : "internal" });
  }
});
