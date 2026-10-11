# Owner-controlled agent access

Create a connection in **Settings → Agent access**. New connections default to
read-only access. The token is shown once and stored by the server only as a
hash. Keep it in the intended client's private configuration, not a note,
repository, URL, terminal history or shared transcript.

Use the displayed `/api/mcp` endpoint with a client that supports Streamable
HTTP and an explicit `Authorization: Bearer …` header. **Copy connection
settings** copies an endpoint/header object, not a client-specific configuration
file. Adapt it to the client's documented format. This endpoint does not claim
to provide OAuth discovery or browser-based client authorization.

For a public server, explicitly set `ARO_MCP_ALLOWED_HOSTS` to its exact
hostname (and non-default port when present), separated by commas for multiple
hosts, and recreate the app container. Localhost works without this setting.
Do not use a wildcard or trust a forwarded host header. Browser origins must
match the request host; the standard cookie-authenticated owner routes remain
separate. When upgrading from an older image, first complete the default
closed-by-default upgrade, then configure the public allowlist.

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

## Optional incoming capture webhook

Automation that does not speak MCP can send JSON to
`POST /api/webhooks/capture` using a separately created token with `capture`
permission. The same public-host allowlist, revocation, payload limits and
idempotency rules apply. Supply `{requestId, text, title?}`; `requestId` is a
UUID retained across identical retries. HTTP 202 returns the inbox item ID.
Changed content with the same ID is a conflict. A browser session cookie
does not authorize this endpoint.

This is an inbound integration only. It does not fetch submitted URLs, invoke
AI enrichment, send outbound webhooks, or write directly to notes. Revoke the
connection in Settings to turn it off.
