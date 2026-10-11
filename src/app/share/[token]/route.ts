import { getRequestLocale } from "@/lib/i18n/server";
import { snapshotResponse } from "@/server/shares/public";
import { readShare } from "@/server/shares/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ token: string }> };
export async function GET(_request: Request, { params }: Context): Promise<Response> {
  const locale = await getRequestLocale();
  try {
    return snapshotResponse(await readShare((await params).token), locale);
  } catch {
    // Never log bearer URLs or database errors containing snapshot data.
    return snapshotResponse(null, locale);
  }
}
