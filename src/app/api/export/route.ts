import { exportResponse } from "@/server/export/service";
import { withApi } from "@/server/http";
import { z } from "zod";

export const runtime = "nodejs";

const wikiLinks = z.enum(["preserve", "portable"]).default("preserve");

export const GET = withApi(async (request) => exportResponse(new Date(), {
  wikiLinks: wikiLinks.parse(new URL(request.url).searchParams.get("wikiLinks") ?? undefined),
}));
