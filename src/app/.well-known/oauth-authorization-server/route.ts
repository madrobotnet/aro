import { metadata, oauthOptions } from "@/server/oauth/metadata";

export const runtime = "nodejs";
export const GET = (request: Request) => metadata(request, "server");
export const OPTIONS = oauthOptions;
