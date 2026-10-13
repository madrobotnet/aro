import { lookup } from "node:dns/promises";
import { request as requestHttp } from "node:http";
import { request as requestHttps } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { Readable } from "node:stream";
import { parse } from "next/dist/compiled/node-html-parser";

export const URL_FETCH_TIMEOUT_MS = 10_000;
export const URL_FETCH_BYTE_LIMIT = 262_144;
export const URL_FETCH_REDIRECT_LIMIT = 4;

export type UrlIntakeResult =
  | { ok: true; url: string; text: string }
  | { ok: false; reason: "invalid_url" | "unsafe_destination" | "fetch_failed" | "too_many_redirects" | "http_error" | "unsupported_content" };

export type UrlFetcher = (input: URL, addresses: readonly string[], init?: RequestInit) => Promise<Response>;

export type UrlIntakeDependencies = {
  resolve?: (hostname: string) => Promise<readonly string[]>;
  fetch?: UrlFetcher;
  signal?: AbortSignal;
};

const BLOCKED_NAMES = new Set(["localhost", "metadata", "metadata.google.internal", "instance-data"]);

function parseIpv4(address: string): number[] | null {
  if (isIP(address) !== 4) return null;
  return address.split(".").map(Number);
}

function isUnsafeIpv4(address: string): boolean {
  const octets = parseIpv4(address);
  if (!octets) return false;
  const a = octets[0]!;
  const b = octets[1]!;
  return a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 168)) ||
    (a === 198 && (b === 18 || b === 19 || b === 51)) ||
    (a === 203 && b === 0) || a >= 224;
}

function normalizeIpLiteral(address: string): string {
  const withoutBrackets = address.startsWith("[") && address.endsWith("]") ? address.slice(1, -1) : address;
  return (withoutBrackets.toLowerCase().split("%")[0] ?? "");
}

function expandIpv6(address: string): number[] | null {
  const halves = address.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves[1] ? halves[1].split(":") : [];
  if (halves.length === 1 && head.length !== 8) return null;
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0) return null;
  const parts = [...head, ...Array.from({ length: fill }, () => "0"), ...tail];
  if (parts.length !== 8 || parts.some((part) => !/^[0-9a-f]{1,4}$/i.test(part))) return null;
  return parts.map((part) => Number.parseInt(part, 16));
}

function isUnsafeIpv6(address: string): boolean {
  const value = normalizeIpLiteral(address);
  if (isIP(value) !== 6) return false;
  const parts = expandIpv6(value);
  if (!parts) return true;
  if (parts.slice(0, 5).every((part) => part === 0) && parts[5] === 0xffff) {
    return isUnsafeIpv4(`${parts[6]! >> 8}.${parts[6]! & 255}.${parts[7]! >> 8}.${parts[7]! & 255}`);
  }
  const first = parts[0]!;
  const second = parts[1]!;
  const globalUnicast = first >= 0x2000 && first <= 0x3fff;
  const reserved = (first === 0x2001 && (second <= 0x01ff || second === 0x0db8)) ||
    first === 0x2002 || (first === 0x3fff && second < 0x1000);
  return !globalUnicast || reserved;
}

export function isUnsafeAddress(address: string): boolean {
  const normalized = normalizeIpLiteral(address);
  return isUnsafeIpv4(normalized) || isUnsafeIpv6(normalized);
}

export function isUnsafeHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  const address = normalizeIpLiteral(host);
  return !host || BLOCKED_NAMES.has(host) || host.endsWith(".localhost") || host.endsWith(".local") ||
    (isIP(address) !== 0 && isUnsafeAddress(address));
}

async function defaultResolve(hostname: string): Promise<readonly string[]> {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

async function validateDestination(
  url: URL,
  resolve: NonNullable<UrlIntakeDependencies["resolve"]>,
): Promise<readonly string[] | null> {
  if (!(["http:", "https:"] as string[]).includes(url.protocol) || url.username || url.password || isUnsafeHostname(url.hostname)) {
    return null;
  }
  const literal = normalizeIpLiteral(url.hostname);
  if (isIP(literal)) return isUnsafeAddress(literal) ? null : [literal];
  try {
    const addresses = await resolve(url.hostname);
    return addresses.length > 0 && addresses.every((address) => isIP(address) !== 0 && !isUnsafeAddress(address))
      ? addresses
      : null;
  } catch {
    return null;
  }
}

/** Request a URL while connecting only to one previously validated address. */
export function requestPinned(input: URL, address: string, init: RequestInit = {}): Promise<Response> {
  const family = isIP(address);
  if (family === 0) return Promise.reject(new TypeError("Pinned destination must be an IP address"));

  return new Promise((resolve, reject) => {
    const pinnedLookup: LookupFunction = (_hostname, options, callback) => {
      if (options.all) callback(null, [{ address, family }]);
      else callback(null, address, family);
    };
    const request = (input.protocol === "https:" ? requestHttps : requestHttp)(input, {
      method: init.method ?? "GET",
      headers: init.headers ? Object.fromEntries(new Headers(init.headers)) : undefined,
      lookup: pinnedLookup,
      servername: input.protocol === "https:" ? input.hostname : undefined,
      signal: init.signal ?? undefined,
    }, (incoming) => {
      const status = incoming.statusCode ?? 500;
      const headers = new Headers();
      for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
        headers.append(incoming.rawHeaders[index]!, incoming.rawHeaders[index + 1]!);
      }
      const hasNoBody = status === 204 || status === 205 || status === 304;
      if (hasNoBody) incoming.resume();
      const reader = hasNoBody ? null : Readable.toWeb(incoming).getReader();
      const body = reader ? new ReadableStream<Uint8Array>({
        async pull(controller) {
          const chunk = await reader.read();
          if (chunk.done) {
            controller.close();
          } else {
            controller.enqueue(new Uint8Array(chunk.value));
          }
        },
        cancel(reason) {
          return reader.cancel(reason);
        },
      }) : null;
      resolve(new Response(body, {
        status,
        statusText: incoming.statusMessage,
        headers,
      }));
    });
    request.on("error", reject);
    request.end();
  });
}

async function defaultFetch(input: URL, addresses: readonly string[], init?: RequestInit): Promise<Response> {
  let lastError: unknown;
  for (const address of addresses) {
    try {
      return await requestPinned(input, address, init);
    } catch (error) {
      lastError = error;
      if (init?.signal?.aborted) throw error;
    }
  }
  throw lastError ?? new TypeError("Destination has no validated addresses");
}

async function cancelBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

async function withSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason;
  return await new Promise<T>((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
  });
}

async function readBounded(response: Response): Promise<string | null> {
  const contentLength = response.headers.get("content-length");
  const declared = contentLength === null ? 0 : Number(contentLength);
  if (Number.isFinite(declared) && declared > URL_FETCH_BYTE_LIMIT) {
    await cancelBody(response);
    return null;
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > URL_FETCH_BYTE_LIMIT) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function toText(raw: string, html: boolean): string {
  let value = raw;
  if (html) {
    // The bundled parser treats a document declaration as text rather than a node.
    const document = parse(raw.replace(/<!doctype(?:[^>"']|"[^"]*"|'[^']*')*>/gi, ""));
    for (const element of document.querySelectorAll("head,script,style,nav,noscript")) element.remove();
    // structuredText separates blocks and decodes character references exactly once.
    value = document.structuredText;
  }
  return value.replace(/\s+/g, " ").trim().slice(0, 20_000);
}

/** Fetch a public HTTP(S) page. DNS and every redirect target are checked before each request. */
export async function fetchUrlText(input: string, dependencies: UrlIntakeDependencies = {}): Promise<UrlIntakeResult> {
  let current: URL;
  try {
    current = new URL(input);
  } catch {
    return { ok: false, reason: "invalid_url" };
  }
  const resolve = dependencies.resolve ?? defaultResolve;
  const fetcher = dependencies.fetch ?? defaultFetch;
  const signal = dependencies.signal ?? AbortSignal.timeout(URL_FETCH_TIMEOUT_MS);

  for (let redirects = 0; redirects <= URL_FETCH_REDIRECT_LIMIT; redirects += 1) {
    let addresses: readonly string[] | null;
    try {
      addresses = await withSignal(validateDestination(current, resolve), signal);
    } catch {
      return { ok: false, reason: "fetch_failed" };
    }
    if (!addresses) return { ok: false, reason: "unsafe_destination" };
    let response: Response;
    try {
      response = await fetcher(current, addresses, {
        method: "GET",
        redirect: "manual",
        signal,
        headers: { accept: "text/html,text/plain;q=0.9" },
      });
    } catch {
      return { ok: false, reason: "fetch_failed" };
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      await cancelBody(response);
      if (!location) return { ok: false, reason: "http_error" };
      if (redirects === URL_FETCH_REDIRECT_LIMIT) return { ok: false, reason: "too_many_redirects" };
      try {
        current = new URL(location, current);
      } catch {
        return { ok: false, reason: "invalid_url" };
      }
      continue;
    }
    if (!response.ok) {
      await cancelBody(response);
      return { ok: false, reason: "http_error" };
    }
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "text/plain";
    if (!contentType.includes("text/html") && !contentType.includes("text/plain")) {
      await cancelBody(response);
      return { ok: false, reason: "unsupported_content" };
    }
    try {
      const raw = await readBounded(response);
      if (raw === null) return { ok: false, reason: "unsupported_content" };
      return { ok: true, url: current.href, text: toText(raw, contentType.includes("text/html")) };
    } catch {
      return { ok: false, reason: "fetch_failed" };
    }
  }
  return { ok: false, reason: "too_many_redirects" };
}
