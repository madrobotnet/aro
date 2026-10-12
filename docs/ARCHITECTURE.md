# Aro architecture

This document describes Aro 2.4.0. Upgrade compatibility is covered in
[UPDATE.md](UPDATE.md).

## Product boundaries

- One owner controls the notebook. Agent credentials delegate only explicitly
  granted capabilities; they do not introduce additional human accounts.
- Capture, links and ordinary search must work without AI. External model calls
  require the owner's enabled configuration; disabling AI must remain effective.
- Markdown note transfer and full-instance backup are different operations.
  Transfer must report unsupported state and missing attachment bytes rather than
  silently claiming a complete migration.
- Desktop and server are separate primary environments, not a live sync pair.
  Movement between them is an explicit export/import operation.
- Diagnostics stay local by default. External analytics or webhook delivery
  require a specific opt-in and a documented data payload.
- SQLite desktop support uses native repositories and append-only migrations,
  not a connection-string substitution. See `SQLITE.md` and `DESKTOP.md`.
  The PostgreSQL contracts documented below describe the server backend.

Aro is a single-owner, self-hosted second brain built with **Next.js 16 App Router, React 19, strict TypeScript, Tailwind CSS 4, PostgreSQL 18 + pgvector + pg_trgm, and Bun**. Bun is the package manager, script runner, test runner and production runtime.

Flow: **capture → inbox triage → linked Markdown notes → search, graph and AI chat over your notes.**

## Commands

| Command | Purpose |
| --- | --- |
| `bun install` | install dependencies (lockfile `bun.lock`) |
| `bun run db:up` / `bun run db:down` | start / stop local PostgreSQL with pgvector on `127.0.0.1:55432` (docker-compose.dev.yml) |
| `bun run dev` | Bun dev server (`--no-env-file`, Next `--webpack`) |
| `bun run typecheck` | `tsc --noEmit` |
| `bun run lint` | `eslint .` |
| `bun test` | unit and PostgreSQL integration tests (`bun:test`, requires `db:up`) |
| `bun run build` / `bun run start` | build / start the production app |
| `bun run seed` | seed demo notes into `DATABASE_URL` |

## Layout

```
src/
  proxy.ts                     cookie gate (Next 16 "proxy" = old middleware)
  app/
    layout.tsx, globals.css    root, fonts, design tokens
    login/                     login page
    (app)/layout.tsx           authenticated shell (server: getSession() else redirect)
    (app)/page.tsx             home dashboard
    (app)/notes/, (app)/notes/[id]/, (app)/daily/, (app)/inbox/, (app)/tasks/, (app)/search/,
    (app)/graph/, (app)/chat/, (app)/chat/[id]/, (app)/settings/
    api/**/route.ts            JSON APIs (all wrapped with withApi / withPublicApi)
  components/ui/               design-system primitives (Button, Input, Dialog, Sheet, Badge, Kbd, Skeleton, EmptyState, Toast)
  components/shell/            Sidebar, MobileNav, CommandPalette, ShellProvider
  features/<area>/             client feature components per area
  lib/                         isomorphic: types.ts (wire types), api-client.ts, markdown/wikilink helpers
  server/                      server-only modules per area; db/, auth/, http.ts, jev/, setup/
```

## Core contracts (implemented; reuse rather than rewrite)

- `src/server/db/index.ts`: `db()`, `query<T>(sql, params)`, `queryOne<T>()`, `tx(fn)`, `closeDb()`. Migrations in `src/server/db/migrations.ts` run automatically on first use. **Append a new migration for schema changes** (never edit `0001`).
- `src/server/http.ts`: `withApi(handler)` (session required), `withPublicApi`, `ApiError(code, message)`, `json()`, `parseJson(request, zodSchema)`. Error body: `{ error: { code, message } }`.
- `src/server/auth/session.ts`: `getSession()`; cookie `aro_session`.
- `src/server/jev/client.ts`: `await getJev()` returns a TypeSafe client or `null`. `aiSelection(purpose)` independently resolves chat and Jev to a saved profile, an explicit off state, or environment-managed configuration. When no settings row exists, legacy behavior is preserved; adding an inactive profile doesn't change it. Off prevents ambient credentials from reactivating that purpose. Chat uses the same selection in `configuredChatProvider()`. **Optional AI failures must not block capture, notes, search, or graph operations. Chat reports its own unavailable/provider-error state.**
- `src/server/setup/service.ts` + `src/server/setup/settings.ts`: protected first-run setup and active selections. `setupState()` is `complete` when an environment password is set or users or protected data already exist. It is `ready` only for an empty server with a valid installer token. Owner creation, initial profiles and consumption of ready authorization attempts share one transaction and the occupied-state advisory lock. The environment password remains authoritative.
- `src/server/setup/ai-profiles.ts`: owner-scoped profile creation, update and deletion. Off preserves profiles; deleting an active profile disables its purpose. Keys and headers are retained only for the same provider and normalized endpoint. `aiSettingsView()` returns safe metadata, never keys, header values or OAuth credentials. Changes apply without restart.
- `src/server/ai-auth/`: stateless GitHub Copilot/xAI device and OpenRouter PKCE clients, DB-backed attempts, owner/installer and browser binding, one-time consumption, and serialized refresh. HTTP responses are bounded to 64 KiB and 15 seconds; credential-bearing redirects are refused. Native ChatGPT and Gemini CLI login remain separate.
- `src/lib/types.ts`: every API response type. `src/lib/api-client.ts`: `api<T>(path, { method, json })`, `fetcher` for SWR, `ApiClientError`.
- `src/server/test/db.ts`: `connectTestDatabase()`, `resetData()`, `closeDb()` for integration tests.

## Data model (PostgreSQL, compatible with v1 production tables)

- `notes(id, title, body markdown, status, tags text[], aliases text[], pinned, source_url, daily_date, created_at, updated_at, deleted_at, search_embedding vector(128), search_source_hash, search_tsv generated)`. Archived = `status = 'archived'`. Trash = `deleted_at IS NOT NULL`.
- `note_passages(note_id, model_id, source_hash, ordinal, heading, start_line, end_line, content, embedding vector(768))` and `note_semantic_index(note_id, model_id, source_hash, complete)`: optional learned retrieval, separate from the legacy 128d hashes. Foreign keys cascade on permanent note deletion.
- `links(from_note_id, to_note_id, relation='link')`: materialized from `[[wikilinks]]` on every note write.
- `unresolved_links(from_note_id, target_title)`: `[[targets]]` with no matching note; resolved when a note with that title or alias is created or renamed.
- `inbox_items(id, title, body, source web|url|share|api, url, promoted_note_id, discarded_at, suggestions jsonb, created_at)`.
- `attachments(id, note_id?, filename, mime, size_bytes, storage_key)` stored under `ATTACHMENTS_DIR` (default `.data/attachments`).
- `attachment_cleanup(storage_key)`: durable file-removal work inserted in the same transaction as permanent note deletion. Keys disappear only after successful removal. Failed work is retried after later purges and during note maintenance. The Node instrumentation hook runs this maintenance at startup and every six hours, alongside expired-trash purging and revision pruning. Failures log only a count and error code, not filenames or paths.
- `chat_threads`, `chat_messages(role, content, citations jsonb)`.
- `installation_settings(owner_id, setup_completed, ai jsonb)`: `ai` is `{version:2, chatId, jevId}`. IDs are a profile UUID, `null` (off), or `"environment"`.
- `ai_connections(id, owner_id, purpose, name, connection jsonb, created_at, updated_at)`: separate chat/Jev profiles and server-only credentials. Migration `0003_ai_connections` converts prior inline settings without changing active choices.
- `ai_auth_attempts(id, provider, scope_key, browser_hash, status, payload, expires_at, next_poll_at)`: private transient authorization state; never a process-local session map. A profile save consumes a ready attempt inside its transaction.

## Wikilink rules (src/lib/wikilinks.ts)

- Syntax: `[[Target]]`, `[[Target|label]]`, `[[Target#Heading]]`. Targets match note titles or aliases case-insensitively, with repeated whitespace collapsed.
- Tags: body tags written as `#tag` (letters including Hangul, digits, `-`, `_`, `/`; not inside code) are merged with explicit `tags`, then lowercased and deduplicated.
- Preview clicks resolve through `/api/notes/by-title` and navigate to the real note ID. Missing targets are created only by that explicit action. The graph distinguishes unresolved targets.

## HTTP API

| Method & path | Body / query | Response |
| --- | --- | --- |
| POST `/api/setup` | `{setupToken, password, passwordConfirmation, ai}` | public first-run: 201 `{ok}`; 403 wrong setup token; 409 when setup is complete or data exists |
| POST `/api/auth/login` | `{password}` | `{ok}` + cookie; 429 `{retryAfterSeconds}` |
| POST `/api/auth/logout` | | `{ok}` |
| POST `/api/auth/sessions/revoke-all` | | `{ok, revoked}`; clears the current cookie |
| GET `/api/auth/me` | | `{ok, expiresAt}` |
| GET `/api/notes` | `?q=&tag=&pinned=1&archived=1&trash=1&limit=50&cursor=` | `{notes: NoteSummary[], nextCursor: string\|null}` |
| POST `/api/notes` | `{title?, body?, tags?}` | `{note: Note}` (title defaults to "제목 없음" + n) |
| GET/PATCH/DELETE `/api/notes/:id` | PATCH `{title?, body?, tags?, aliases?, pinned?, archived?}` | `{note: Note}`; DELETE = move to trash |
| POST `/api/notes/:id/restore` | | `{note}` |
| DELETE `/api/notes/:id?purge=1` | | permanent delete (only when in trash) |
| GET `/api/notes/:id/links` | | `NoteLinks` |
| GET `/api/notes/:id/related` | | `{notes: RelatedNote[]}` (fresh learned passage neighbors when indexed; otherwise character similarity, with explicit match signals) |
| GET `/api/notes/titles` | `?q=&limit=10` | `{notes: NoteRef[]}`; title/alias lookup for the switcher and autocomplete |
| POST `/api/notes/by-title` | `{title}` | `{note}` get-or-create (clicking an unresolved link) |
| POST `/api/daily` | `{date?: YYYY-MM-DD}` | `{note}` get-or-create daily note |
| GET `/api/tags` | | `{tags: TagCount[]}` |
| POST `/api/attachments` | multipart `file` (≤ 25 MB), `noteId?` | `{id, url, filename, mime, markdown}` |
| GET `/api/attachments/:id` | | file bytes |
| POST `/api/capture` | `{text?, url?, title?}` | `{item: InboxItem}` (Jev suggestions run after the insert, best-effort) |
| POST `/api/capture/share` | PWA share-target form | 303 → `/inbox` |
| GET `/api/inbox` | | `{items: InboxItem[], count}` |
| POST `/api/inbox/:id/promote` | `{title?, body?, tags?}` | `{note}` |
| POST `/api/inbox/:id/discard` | | `{ok}` |
| POST `/api/inbox/:id/suggest` | | `{item}` (re-run Jev) |
| GET `/api/search` | `?q=&tag=&limit=20` | `SearchResponse` |
| GET `/api/graph` | `?focus=<noteId>&depth=1..3&tags=1&orphans=1&tag=<filter>` | `GraphData` |
| GET `/api/chat/status` | | `{available: boolean}` |
| GET/POST `/api/chat/threads` | POST `{title?}` | `{threads}` / `{thread}` |
| GET/PATCH/DELETE `/api/chat/threads/:id` | PATCH `{title}` | GET `{thread, messages}`; PATCH `{thread}`; DELETE `{ok}` |
| POST `/api/chat/threads/:id/messages` | `{content}` | `text/event-stream`: `citations` (Citation[]), `delta` ({text}), `done` ({message: ChatMessage}), `error` ({code, message}) |
| GET/PUT `/api/settings/ai` | PUT `{chat, chatConsent, jev, jevConsent}` | `{settings, connections}`; `settings` is redacted (`hasApiKey` flags, no credentials); PUT saves and applies immediately (no restart) |
| POST `/api/settings/ai/connections` | `{purpose, name, connection, consent:true}` | 201 `{profile, settings}` with safe metadata; adds without activating |
| PUT/DELETE `/api/settings/ai/connections/:id` | PUT same profile input | PUT `{profile, settings}`; DELETE `{settings}` |
| POST `/api/ai/auth` | `{provider, setupToken?, enterpriseDomain?}` | public handler requiring owner session or installer authorization; browser-bound `AuthAttemptView`, never tokens |
| POST/DELETE `/api/ai/auth/:id` | `{setupToken?}` | scoped poll status / `{ok}` cancellation |
| GET `/api/ai/auth/openrouter/callback/:id` | provider code or error | browser-bound PKCE completion, then 303 to `/connect/complete` |
| GET `/api/home` | `?timeZone=<IANA zone>` (optional) | `HomeData`; client supplies its local zone |
| GET `/api/health` | public | `{ok}` |

Selection inputs accept inline connections (initial setup), `{mode:"saved",id}`,
`{mode:"environment"}`, or `null`. Optional `chatName` and `jevName` fields name
the initial profiles. Browser Auth uses an input-only `authAttemptId`; stored
credentials never appear in client input or settings output. Supported schemas live in
`src/lib/ai-settings.ts`, `ai-connections.ts` and `ai-auth-flow.ts`.

## Design system

The interface uses a warm parchment canvas, matte cards, charcoal rail and
terracotta accent, with Korean and English copy. Pretendard Variable is
self-hosted; code uses the system monospace stack.

[DESIGN.md](https://github.com/madrobotnet/aro/blob/v2.4.0/DESIGN.md) defines the design guidance and interface contract.
[src/app/globals.css](https://github.com/madrobotnet/aro/blob/v2.4.0/src/app/globals.css) is the executable source for
light/dark color, typography, spacing and focus token values, exposed to Tailwind 4
through `@theme inline`. Use semantic utilities such as `bg-card`, `text-ink`
and `border-line` rather than copying color values into components. Focus uses
`--focus` with `focus-ring` or `focus-ring-offset` as specified in the contract.

The desktop shell (≥ 1024px) has a 64px charcoal rail that expands to 220px.
Without a stored choice, the rail starts expanded at 1280px and wider, and
collapsed below that width. Mobile has a top bar and bottom navigation:
Home · Inbox · [capture] · Notes · More. Search stays in the top bar;
the remaining destinations appear in More.

[src/components/shell/nav.ts](https://github.com/madrobotnet/aro/blob/v2.4.0/src/components/shell/nav.ts) defines the shared
route order: Home `/`, Inbox `/inbox`, Notes `/notes`, Tasks `/tasks`,
Today `/daily`, Search `/search`, Graph `/graph`, Chat `/chat`, Settings
`/settings`. Labels are localized, and Inbox shows the open-item count.

Keyboard shortcuts: `Ctrl/⌘+K` opens the command palette, `Ctrl/⌘+P` opens its note
switcher, `c` or `Ctrl/⌘+Shift+Space` opens capture, `g` followed by
`h/i/n/t/s/g/c` navigates, and `/` focuses search. Single-key shortcuts are
ignored while an input or editor is focused; explicit Ctrl/⌘ modifier chords
remain supported there. Shortcut handling guards IME composition.

## State and retrieval boundaries

- Each SWR key retains a single response shape. Chat and settings share the plain chat-status DTO.
- Note mutations invalidate individual list pages, SWR Infinite aggregates, title lookups, links, graph/search and time-zone-qualified home snapshots.
- Draft writes are serialized. Failed flushes prevent destructive actions, and late attachment completion reads the current draft.
- Hashed n-gram search candidates require literal query n-gram overlap; a hash collision alone is not a match.
- Optional local learned retrieval is enabled with `EMBEDDING_BASE_URL` pointing to the pinned llama.cpp text embedding server. EmbeddingGemma 2 uses mean pooling, 768 dimensions, normalized vectors, `task: search result | query: ...` queries and `title: ... | text: ...` documents. The model identity includes the weight hash, prompts, pooling, dimensions and chunker revision; other model identities never contribute candidates.
- Markdown passages preserve source lines and headings, including duplicate headings. Each passage is bounded by 512 UTF-8 bytes (a conservative token upper bound), with title and heading metadata limited to 64 UTF-16 characters each. Total inference input is limited to 1024 UTF-8 bytes, including query prompts. These bounds fit the measured 2-GiB ARM64 runtime envelope; oversized queries stay lexical-only. The startup worker processes one passage every three seconds, one run at a time, with a 15-second document deadline. Progress is durable and resumable. Inference occurs outside note transactions; publication locks and rechecks the current source hash and visibility after inference. Restored notes reuse only fresh passages.
- Search fuses full-text/fuzzy and learned passage rankings with reciprocal rank fusion, prioritizing exact titles/aliases. A ready learned index replaces the approximate hash vote; incomplete or unavailable indexes retain the hash fallback. Learned matches do not need literal n-gram overlap. Tag filters and archive/trash exclusions apply to every lane. A learned query has a 1.5-second timeout; unavailable or malformed embeddings leave lexical search usable. Note writes never call the learned model. Related discovery can use cached fresh passage vectors without live inference.
- Search responses expose index counts and disabled/unavailable/indexing/ready state. Dense results are discovery candidates, not an abstention guarantee for unrelated queries. Source passage links carry line locations and the note timestamp so changed evidence is not silently presented as the original source.
- Chat without fresh matches reloads prior cited active notes for follow-up context. Deleted or archived notes are not revived as evidence.
- `--workspace-h` reserves mobile header, navigation and safe-area space. Note/chat panes scroll internally instead of adding an extra document-height gap.
