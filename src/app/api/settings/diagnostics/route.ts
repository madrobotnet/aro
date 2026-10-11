import { json, withApi } from "@/server/http";
import { localDiagnostics } from "@/server/setup/diagnostics";

export const GET = withApi(async () => json(await localDiagnostics()));
