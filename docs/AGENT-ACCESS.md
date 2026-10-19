# Owner-controlled agent access

Connect Claude or ChatGPT through OAuth, or create a bearer token in
**Settings → Agent access** for a client you configure yourself. Both use the
same bounded tools, access history and owner-reviewed proposals.

## Claude and ChatGPT connectors

For a public server, explicitly set `ARO_MCP_ALLOWED_HOSTS` to its exact
hostname (and non-default port when present), separated by commas for multiple
hosts, and recreate the app container. Localhost works without this setting.
When configured, the allowlist replaces the localhost default. Do not use a
wildcard. Put the public server behind HTTPS and preserve its `Host` header at
the TLS-terminating proxy; forwarded host/protocol headers are not used to
construct OAuth URLs. Restrict app ingress to your trusted proxy, and configure
`TRUSTED_PROXY_HOPS` for the existing client-IP/rate-limit convention.

- **claude.ai:** Settings → Connectors → Add custom connector. Enter
  `https://<host>/api/mcp`, then connect.
- **ChatGPT:** Settings → Connectors (or Apps, depending on the interface) /
  developer mode → add an MCP server with URL `https://<host>/api/mcp`.
  Availability and the developer-mode switch depend on the account/workspace.

The client opens Aro's `/oauth/authorize` endpoint. Sign in to Aro if needed;
login returns to that same request, then opens `/oauth/consent`. The consent screen shows the client-supplied
name, its callback host, and the permissions it requests. Check the address:
a display name is not a verified identity. Read and capture are checked by
default when requested; propose-write is never checked automatically. Denying
returns `access_denied` to the registered callback.

Proposals initially have an empty note allowlist. If you enable propose-write,
add explicit note UUIDs in **Settings → Agent access → OAuth connections**.
Each proposed edit still needs separate owner approval. A connection never
receives direct note creation or modification access.

OAuth connections appear once per grant, labelled with the client name and
**OAuth**, with scopes and last-used time. **Revoke access** invalidates all
access and refresh tokens for that grant, including tokens rotated earlier.
Reconnect through the client to grant access again.

## Owner-created bearer tokens

New owner-created tokens default to read-only access and do not expire.
Existing tokens and their UI keep working. A token is shown once and stored
only as a hash plus its existing display prefix. Keep it in the intended
client's private configuration, not a note, repository, URL, terminal history
or shared transcript.

Use `/api/mcp` with a Streamable HTTP client and an explicit
`Authorization: Bearer …` header. **Copy connection settings** copies an
endpoint/header object, not a client-specific configuration file. Adapt it to
the client's documented format. MCP browser requests still require a matching
origin; OAuth discovery, registration and token endpoints allow credential-free
browser CORS. Owner routes use session authentication and same-origin checks.

## Capabilities

| Permission | Tools | Effect |
| --- | --- | --- |
| `read` | `search_notes`, `get_note` | Search and read the owner's active notebook |
| `capture` | `capture_inbox` | Add to the inbox; never directly create a note |
| `propose-write` | `propose_note_update` | Queue a change to explicitly allowed note IDs |

Unpermitted tools are absent from the list and rejected if called directly.
Write proposals do not apply until the owner reviews them in Settings.
Approval rechecks both access and the target note version. A stale proposal
cannot silently overwrite subsequent human edits.

Revoke a connection in Settings to deny subsequent requests. Revocation is read
from the database, not a process-local permission cache. Access history records
tool names, result, target identity and time; it does not retain note bodies,
prompt text or bearer secrets.

## Machine usage contract

1. Initialize the MCP connection with protocol version `2025-06-18`.
2. Discover capabilities with `tools/list`; do not assume write permission.
3. Use `search_notes` to find IDs and `get_note` for note content and its current
   version. Note reads are bounded; use the returned paging information.
4. For capture or proposals, generate one UUID `requestId` per intended action.
   On an uncertain response, reuse that exact UUID and identical arguments.
   A changed action needs a new UUID; reusing an ID with changed content fails.
5. Send captures to the inbox. Do not translate a capture into an unapproved
   direct note update.
6. For proposals, retain the `expectedVersion` from the note read and supply
   only the intended `patch` fields (`title` and/or `body`). The target must
   appear in the token's allowed note IDs. Tell the owner that approval is
   pending; a queued proposal is not an applied edit.
7. Treat revoked credentials and rejected/stale proposals as failures requiring
   owner attention, not permission to obtain broader credentials.

The transport returns JSON responses for JSON-RPC requests and does not offer a
separate server event stream. The tools list includes machine-readable input
schemas; use those schemas rather than extracting arguments from this prose.
See the [MCP Streamable HTTP specification](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports).

This is delegation from one owner, not a multiuser account system. External
agent software receives whatever note data its read permission allows; the
owner chooses that client and scope explicitly.

## OAuth protocol and endpoints

The authorization-code flow requires S256 PKCE for every client. Codes expire
after 10 minutes and can be used once. Access tokens expire after one hour;
refresh tokens expire after 30 days and rotate on every use. Reusing a consumed
code or rotated refresh token revokes the grant. A refresh request may reduce
but never expand permissions. Tokens are bound to this server's `/api/mcp`
resource; an optional `resource` parameter must match it exactly.

| Endpoint | Method | Purpose |
| --- | --- | --- |
| `/.well-known/oauth-protected-resource` | GET, OPTIONS | Protected resource discovery |
| `/.well-known/oauth-protected-resource/api/mcp` | GET, OPTIONS | Path-specific resource discovery |
| `/.well-known/oauth-authorization-server` | GET, OPTIONS | Authorization server discovery |
| `/oauth/register` | POST, OPTIONS | RFC 7591 dynamic registration |
| `/oauth/authorize` | GET | Validate authorization; redirect to owner login or consent |
| `/oauth/consent` | GET | Server-rendered owner consent page |
| `/oauth/authorize/decision` | POST | Same-origin owner approval or denial |
| `/oauth/token` | POST, OPTIONS | Code exchange or refresh |
| `/oauth/revoke` | POST, OPTIONS | Grant revocation |
| `/api/agents/connections` | GET | Owner-only connection list |
| `/api/agents/connections/{id}` | DELETE, PATCH | Owner revocation / allowed-note IDs |

Registration accepts public `none` clients and confidential
`client_secret_basic` / `client_secret_post` clients. Confidential clients
receive a secret once and must authenticate at the token endpoint. Redirects
must match exactly: HTTPS URLs on any host, or HTTP callbacks on `localhost`
and `127.0.0.1`. No ChatGPT/OpenAI callback hostname is hardcoded.

HTTPS Client ID Metadata Documents are also supported, including Claude's
URL-shaped client ID. Aro checks the document's exact `client_id`, name and
redirects. Fetches pin validated public DNS addresses, reject private and
loopback destinations, allow no redirects, have a 5-second deadline and 16 KiB
body limit, and cache valid documents for 60 seconds. These clients are public
(`none`) and still require PKCE.

Discovery and OAuth API responses are not cached by browsers. Registration is
limited to 20 attempts per client IP per hour; other OAuth operations to 120
per minute. Codes, refresh tokens and confidential client secrets are stored
only as SHA-256 hashes. No secrets or note content are written to activity logs.
Migrations are additive: PostgreSQL `0015_oauth_clients` and SQLite
`0008_oauth_clients` (SQLite has its own contiguous migration history).

## Optional incoming capture webhook

Automation that does not speak MCP can send JSON to
`POST /api/webhooks/capture` using a separately created token with `capture`
permission. The same public-host allowlist, revocation, payload limits and
idempotency rules apply. Supply `{requestId, text, title?}`; `requestId` is a
UUID retained across identical retries. HTTP 202 returns the inbox item ID.
Changed content with the same ID is a conflict. A browser session cookie
does not authorize this endpoint.
OAuth tokens are bound to `/api/mcp` and cannot be used for this webhook.

This is an inbound integration only. It does not fetch submitted URLs, invoke
AI enrichment, send outbound webhooks, or write directly to notes. Revoke the
connection in Settings to turn it off.
