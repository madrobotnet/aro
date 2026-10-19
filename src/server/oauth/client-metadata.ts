import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { z } from "zod";
import { readBoundedText } from "@/server/agents/body";
import { isUnsafeAddress, isUnsafeHostname, requestPinned } from "@/server/inbox/url";
import { OAuthError, type ClientRow } from "./model";
import { RegistrationSchema } from "./validation";

const DocumentSchema = RegistrationSchema.extend({
  client_id: z.url(),
  token_endpoint_auth_method: z.literal("none").default("none"),
});
type Dependencies = {
  readonly resolve?: (hostname: string) => Promise<readonly string[]>;
  readonly fetch?: typeof requestPinned;
  readonly signal?: AbortSignal;
};

/** Covers DNS, headers and streamed body with one deadline, including an unresponsive resolver. */
async function bounded<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export async function fetchClientMetadata(id: string, dependencies: Dependencies = {}): Promise<ClientRow> {
  try {
    const url = new URL(id);
    if (id.length > 2048 || url.protocol !== "https:" || url.username || url.password ||
        url.hash || !url.pathname || url.pathname === "/" || isUnsafeHostname(url.hostname)) {
      throw new OAuthError("invalid_client", "Unsafe client metadata URL");
    }
    const signal = dependencies.signal ?? AbortSignal.timeout(5000);
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    const resolve = dependencies.resolve ?? (async host => (await lookup(host, { all: true, verbatim: true })).map(row => row.address));
    const addresses = isIP(hostname) ? [hostname] : await bounded(resolve(hostname), signal);
    if (!addresses.length || addresses.some(address => !isIP(address) || isUnsafeAddress(address))) {
      throw new OAuthError("invalid_client", "Unsafe client metadata destination");
    }
    const address = addresses[0];
    if (!address) throw new OAuthError("invalid_client", "Missing client metadata destination");
    // Pin the validated DNS result, preserve TLS SNI, and never follow a redirect.
    const response = await bounded((dependencies.fetch ?? requestPinned)(url, address, {
      signal, redirect: "manual", headers: { accept: "application/json" },
    }), signal);
    if (!response.ok || response.status >= 300 ||
        response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
      await response.body?.cancel();
      throw new OAuthError("invalid_client", "Client metadata must be a JSON document without redirects");
    }
    const document = DocumentSchema.parse(JSON.parse(await bounded(readBoundedText(response, 16 * 1024), signal)));
    if (document.client_id !== id) throw new OAuthError("invalid_client", "Client metadata identity mismatch");
    return { id, name: document.client_name, redirect_uris: JSON.stringify(document.redirect_uris),
      auth_method: "none", secret_hash: null, created_at: new Date() };
  } catch (error) {
    if (error instanceof OAuthError) throw error;
    // Network and parse details may contain remote URLs; never expose or log them.
    throw new OAuthError("invalid_client", "Could not load a valid client metadata document");
  }
}

const cache = new Map<string, { readonly expires: number; readonly client: ClientRow }>();
export async function clientMetadata(id: string): Promise<ClientRow> {
  const cached = cache.get(id);
  if (cached && cached.expires > Date.now()) return cached.client;
  const client = await fetchClientMetadata(id);
  for (const [key, value] of cache) if (value.expires <= Date.now()) cache.delete(key);
  if (cache.size >= 100) {
    const first = cache.keys().next().value;
    if (first !== undefined) cache.delete(first);
  }
  cache.set(id, { client, expires: Date.now() + 60_000 });
  return client;
}
