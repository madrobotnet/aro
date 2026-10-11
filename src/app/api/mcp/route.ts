import { mcpNoStream, mcpPost } from "@/server/agents/transport";

export const runtime = "nodejs";
export const POST = mcpPost;
export const GET = mcpNoStream;
export const DELETE = mcpNoStream;
