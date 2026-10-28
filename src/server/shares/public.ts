import type { SharedSnapshot } from "./service";
import { formatDateTime } from "@/lib/i18n/format-date";

const escape = (value: string) => value.replace(/[&<>"']/g, (char) => {
  switch (char) {
    case "&": return "&amp;";
    case "<": return "&lt;";
    case ">": return "&gt;";
    case '"': return "&quot;";
    default: return "&#39;";
  }
});

/** Plain readable text: no Markdown URLs, HTML, attachment or image requests. */
export function snapshotResponse(snapshot: SharedSnapshot | null, locale: "ko" | "en"): Response {
  const headers = {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "private, no-store, max-age=0",
    "referrer-policy": "no-referrer",
    "x-robots-tag": "noindex, nofollow, noarchive",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  };
  const unavailable = locale === "ko" ? "찾을 수 없습니다." : "Not found.";
  const title = snapshot?.title ?? unavailable;
  const label = locale === "ko" ? "읽기 전용 스냅샷 · 첨부 파일은 포함되지 않습니다." : "Read-only snapshot · Files are not included.";
  const expiry = locale === "ko" ? "만료" : "Expires";
  const body = snapshot ? `<p>${label}</p><p>${expiry}: <time datetime="${escape(snapshot.expiresAt)}">${escape(formatDateTime(snapshot.expiresAt, locale, { timeZone: "UTC" }))} UTC</time></p><pre>${escape(snapshot.body)}</pre>` : "";
  return new Response(`<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow,noarchive"><meta name="referrer" content="no-referrer"><title>${escape(title)}</title><style>
    :root{color-scheme:light dark}body{margin:0;font:16px/1.75 system-ui,sans-serif;background:#fffcf7;color:#1c1917;word-break:keep-all;overflow-wrap:anywhere}
    main{max-width:48rem;margin:auto;padding:clamp(20px,5vw,48px)}h1{font-size:1.65rem;line-height:1.4;overflow-wrap:anywhere}
    p{color:#68615b;font-size:.875rem}pre{font:inherit;white-space:pre-wrap;overflow-wrap:anywhere}
    @media(prefers-color-scheme:dark){body{background:#141210;color:#efe8dc}p{color:#b6afa7}}
    </style></head><body><main><h1>${escape(title)}</h1>${body}</main></body></html>`,
  { status: snapshot ? 200 : 404, headers });
}
