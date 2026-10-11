# SQLite foundation (not an enabled desktop mode)

`src/server/db/sqlite` is an independently usable, Bun-only persistence unit.
Nothing imports it from the running application. PostgreSQL remains the production
backend. There is no environment switch, SQL translation, provider call, installer,
service implementation, attachment filesystem writer, or automatic data transfer here.

## Runtime and executor

The repository pins Bun 1.4.2. Its locally installed documentation
`node_modules/bun-types/docs/runtime/sqlite.mdx` and `sqlite.d.ts` document
`bun:sqlite`: synchronous prepared statements, native transactions, WAL, exact
integer reads, strict bindings, and deterministic `close(true)`. Development
verification used Bun 1.4.2 / SQLite 3.53.2 on Linux arm64. No remote documentation
or provider was contacted. This is not native macOS/Windows verification.

```ts
import { openSQLite, sqliteStringArray, sqliteTimestamp } from "@/server/db/sqlite";

using store = openSQLite({
  filename: "/absolute/private/existing-directory/aro.sqlite",
  busyTimeoutMs: 1000,
});

const id = store.transaction((tx) => {
  const inserted = tx.get<{ id: string }>(
    "INSERT INTO notes(title,body,tags) VALUES (?,?,?) RETURNING id",
    ["Example", "Markdown body", sqliteStringArray(["reference"])],
  );
  if (!inserted) throw new Error("Insert did not return an identity");
  tx.run("UPDATE notes SET updated_at=? WHERE id=?", [
    sqliteTimestamp(new Date()), inserted.id,
  ]);
  return inserted.id;
});
const row = store.get("SELECT id,title FROM notes WHERE id=?", [id]);
```

`all<T>`, `get<T>` (null when absent), and `run` (Bun's `Changes`) accept one
SQLite-native statement with positional parameters. Row type parameters describe
trusted repository SQL, not runtime validation. Parse domain JSON and map rows
before exposing public DTOs. Bind strings, finite numbers, bigint, Uint8Array, or
null; do not bind PostgreSQL arrays, Date objects, or booleans directly.
Native SQLite errors, including constraint and busy errors, propagate unchanged.
Foundation contract violations have `SQLiteFoundationError.code`.

Statements are prepared afresh and finalized even on failure. This deliberately
avoids cached statements retaining bindings when a caller omits a parameter.
The executor scans statement boundaries while respecting SQLite quotes and comments;
it never rewrites SQL or splits trigger bodies. The small leading-command gate accepts
SELECT/INSERT/UPDATE/DELETE/WITH/EXPLAIN, not DDL, transaction control, or PRAGMA.
This is a trusted repository API, **not a sandbox for user-supplied SQL**.

Transactions use `BEGIN IMMEDIATE`: writer ownership is acquired before reading
state that will be changed. Synchronous completion commits; any exception rolls
back. Compose helpers by passing the callback's `SQLiteExecutor`. Nested
transactions, root-store access and close during a callback are rejected. A
captured transaction executor expires when its callback ends, including rollback.
Promise-returning callbacks are rejected by the public type and runtime; native
async functions are rejected before invocation. A synchronous callback must not
schedule asynchronous work or capture the root store for later side effects.

Never hold the writer across fetch, provider streaming, filesystem work, or await.
The driver blocks its current thread, including during busy waiting. The default
busy timeout is 1000 ms, configurable from 0 to 60000 ms. Busy errors are not
retried; repositories decide whether to return busy or retry an entire idempotent
operation. Tests use 0 for deterministic competing-writer failures, not sleeps.

Every connection enables foreign keys, `synchronous=FULL`, and
`wal_autocheckpoint=1000`. File-backed opens require WAL; explicitly requested
`:memory:` uses SQLite's memory journal instead. WAL allows readers on an old
snapshot while one writer commits, not concurrent writers. Close is idempotent
and uses `close(true)`; no forced checkpoint can invalidate another reader.
SQLite manages checkpointing and WAL/SHM files. Never delete sidecars to resolve
locks or copy just the main database while live. A future backup adapter must use
a consistent SQLite backup/snapshot or quiesce all connections, and separately
include attachment bytes. Tests close every handle and remove their unique temp
directory including all sidecars.

The caller supplies an absolute filename in an already-created private directory;
this unit does not choose a data directory or chmod files. A directory mode of
0700 and an appropriate umask belong to the future local runtime/bootstrap.
There is no global connection singleton, environment inspection, or shared pool.

## Independent, append-only migrations

The SQLite history intentionally does not reuse PostgreSQL IDs:

| SQLite migration | Coverage from PostgreSQL history |
| --- | --- |
| `0001_core` | `0001_v2_baseline`: auth, notes, links, inbox, attachments, chat; excludes PostgreSQL search indexes and generated tsvector |
| `0002_configuration` | `0002_installation_settings`, `0003_ai_connections`, `0005_attachment_cleanup`, `0006_browser_auth_providers`; starts at current version-2 AI settings and full provider enum |
| `0003_history` | `0007_note_revisions`, `0008_inbox_snooze`, `0009_note_templates`; includes trash retention backfill for an older SQLite file |
| `0004_retrieval_chat` | `0010_passage_embeddings`, `0011_chat_requests`; cache storage and request identity only |

PostgreSQL `0004_reset_legacy_embeddings` has no data transformation to replay:
there is no preexisting SQLite legacy feature space. Imported cache data must
either match the exact model/chunking/hash contract or be invalidated by its
future transfer adapter. PostgreSQL's legacy AI-profile extraction also has no
SQLite predecessor; migrating a PostgreSQL instance is not opening it as SQLite.

The application ID is `0x41524f31` (`ARO1`).
`aro_schema_migrations(position INTEGER PRIMARY KEY, id TEXT UNIQUE,
checksum TEXT, applied_at TEXT)` records the contiguous prefix and SHA-256 of
each migration ID and ordered statement list. Applied definitions, including
`migrations/columns-v1.ts`, are immutable; append a numbered migration and new
versioned helpers instead. Checksums detect edited definitions, not malicious
file tampering. Unknown/newer history, gaps, missing history, and changed
checksums fail rather than attempting repair or downgrade.

Only empty files or Aro-owned SQLite files are accepted. An unrelated file is
rejected before journal changes. The writer lock covers identity revalidation,
history verification, every pending migration, and foreign-key checking.
**The entire pending batch is atomic**, including initial ownership and history:
bad SQL, invalid data, or a malformed statement rolls it all back. Migration SQL
is code-owned single-statement DDL/DML; transaction control and pragmas are
rejected. Trigger bodies are parsed by SQLite, not split by the runner.
`migrateSQLite` is an internal upgrade/test entry point, not a plugin/script API.

## Representation and boundary invariants

All tables are `STRICT`. Primary UUIDs are canonical lowercase, hyphenated TEXT;
defaults generate version-4 UUIDs using SQLite randomness. Explicit UUIDs retain
their value rather than being replaced; `sqliteUuid` canonicalizes input.
Foreign IDs refer to canonical primary IDs. IDs are not rowids.

Timestamps are fixed-width UTC TEXT, `YYYY-MM-DDTHH:mm:ss.ffffffZ`. Calendar and
shape checks reject invalid dates and mixed offsets/precision. SQL defaults use
millisecond clock precision padded to six digits; **not** a monotonic clock or
PostgreSQL's transaction-start `now()`. `sqliteTimestamp` preserves up to six
input fractional digits; Date input pads its three digits. Repositories should
capture one instant per logical write, explicitly set `updated_at`, use UUID
tie-breakers, and preserve all six digits in cursors. Existing wire DTOs use
`new Date(storedInstant).toISOString()` (milliseconds), independently of cursors.
Chat ordering must explicitly advance the assistant timestamp past its user
message; two default timestamps are not an ordering guarantee.
`daily_date` remains a validated calendar TEXT date, not a timestamp.

PostgreSQL booleans become INTEGER 0/1, with CHECK constraints. Exact integer reads
are **bigint**, including count/boolean columns. `readSQLiteBoolean` and
`readSQLiteNumber` convert deliberately; unsafe public numbers throw. Attachment
sizes are constrained to 0..Number.MAX_SAFE_INTEGER, a deliberate narrowing of
PostgreSQL bigint to the public nonnegative `sizeBytes: number` contract. The
application's 25 MiB upload limit remains a service concern.

`tags`/`aliases` are JSON TEXT arrays of strings, preserving order, duplicates,
and Unicode. Insert/update triggers validate each element. JSONB documents
become valid JSON TEXT; SQL NULL remains distinct from JSON `null`. Helpers
serialize/parse JSON but do not validate a service's settings, citation, or
credential shape. Domain adapters must apply those existing schemas. JSONB's
key canonicalization, duplicate-key semantics and operators are not emulated.
`token_hash` is BLOB/Uint8Array. `ip` is TEXT: a future auth adapter must validate
and normalize IP input formerly checked by PostgreSQL inet.

128- and 768-dimensional vector caches are finite, float32-range numeric JSON
arrays, validated for shape and elements on insert/update. Values retain their
JSON numeric precision; unlike pgvector, SQLite does not round them to float32
or provide cosine distance. A future cross-backend vector adapter must explicitly
round if byte/numeric parity is required. Model/hash/ordinal fields are retained,
not a claim that any cache is fresh or any semantic retrieval is available.

## Entity and index mapping

All ordinary PostgreSQL columns retain their names and nullability, except
`notes.search_tsv` is omitted (derived PostgreSQL retrieval state). UUID/time/
array/JSON/vector/inet/boolean/bigint representations differ as above.
No FTS5 table, vector extension, or hidden service state has been added.
Every PostgreSQL primary/unique key and explicit index is accounted for below.
SQLite automatically backs primary/unique keys with indexes; their internal
`sqlite_autoindex_*` names are not an application contract.

| Entity | Keys, relationships, constraints | Index mapping |
| --- | --- | --- |
| `users` | UUID PK; password hash and timestamps | PK retained |
| `sessions` | UUID PK; owner FK CASCADE; BLOB token; expiry/revocation/last-seen, agent, IP | `sessions_token_hash_uidx` retained; new `sessions_user_idx` for FK deletes |
| `auth_login_failures` | Client key and attempted timestamp; no artificial PK | `auth_login_failures_client_time_idx` retained |
| `notes` | UUID PK; body/title/status, tags/aliases, pin/source/daily/trash fields, 128D cache metadata; status stays unrestricted TEXT as in PostgreSQL | `notes_active_updated_idx`, `notes_daily_date_uidx` (active-only UNIQUE), `notes_trash_purge_idx` retained; five search indexes omitted below |
| `links` | UUID PK; both note FKs CASCADE; no self-link; UNIQUE(from,to,relation); relation unrestricted | `links_from_note_idx`, `links_to_note_idx`, composite UNIQUE retained |
| `unresolved_links` | PK(from_note_id,target_title); source FK CASCADE | `unresolved_links_target_idx` retained on SQLite `lower(target_title)`; ASCII-only case folding is **not** PostgreSQL Unicode parity |
| `inbox_items` | UUID PK; promotion FK SET NULL; source unrestricted; JSON suggestions, discard/snooze | `inbox_open_idx`, `inbox_snoozed_idx` retained with original predicates; new `inbox_promoted_note_idx` |
| `attachments` | UUID PK; note and inbox FKs CASCADE; metadata only; allows neither or both owners as current PostgreSQL v2 does; storage_key not UNIQUE | New `attachments_note_idx`, `attachments_inbox_idx`; PK retained |
| `chat_threads` | UUID PK; nullable title/archive and timestamps | PK retained |
| `chat_messages` | UUID PK; thread FK CASCADE; user/assistant/system role CHECK; JSON citations/routing; no mandatory assistant citation | `chat_messages_thread_idx` retained |
| `installation_settings` | singleton PK CHECK=1; owner FK CASCADE; setup flag and version-2 JSON default | Singleton PK retained |
| `ai_connections` | UUID PK; owner FK CASCADE; chat/jev purpose CHECK; name/JSON credential document/timestamps | `ai_connections_owner_idx` retained |
| `ai_auth_attempts` | Explicit UUID PK; all five providers and six statuses CHECK; scope/browser/payload/expiry/poll fields | `ai_auth_attempts_expiry_idx`, `ai_auth_attempts_scope_idx` retained |
| `attachment_cleanup` | storage_key TEXT PK | PK retained; filesystem deletion must follow commit in an adapter |
| `note_revisions` | UUID PK; note FK CASCADE; title/body/tags/aliases snapshot; all five reason values CHECK | `note_revisions_note_created_idx` retained |
| `note_templates` | UUID PK; UNIQUE name; body/timestamps; 0/1 daily default | Name UNIQUE and `note_templates_daily_default_uidx` (at most one true) retained |
| `note_semantic_index` | PK(note_id,model_id); note FK CASCADE; source hash/complete/updated fields | Composite PK retained |
| `note_passages` | PK(note_id,model_id,ordinal); note FK CASCADE; heading/line/content/hash/768D cache; int32 bounds retained | `note_passages_model_idx` and composite PK retained |
| `chat_requests` | Explicit UUID PK; thread FK CASCADE; nullable assistant FK CASCADE; content | `chat_requests_thread_idx` retained; new `chat_requests_assistant_idx` |

The deliberately omitted PostgreSQL indexes are:

| PostgreSQL index | Unsupported capability |
| --- | --- |
| `notes_tags_gin` | GIN array containment; JSON array scans are possible but not equivalent indexed retrieval |
| `notes_search_tsv_gin` | Generated weighted tsvector, `@@`, simple tsquery, `ts_rank_cd` |
| `notes_title_trgm` | pg_trgm title similarity and word similarity |
| `notes_body_trgm` | pg_trgm body similarity and word similarity |
| `notes_search_embed_hnsw` | pgvector cosine distance `<=>` and HNSW on the 128D cache |

No PostgreSQL extensions (`pgcrypto`, `pg_trgm`, `vector`) are loaded.
SQL arrays/unnest/ANY, JSONB operations, ILIKE/regex, locale-aware case folding,
DISTINCT ON, PostgreSQL casts/date arithmetic, advisory locks and row-lock
clauses require native repository implementations. SQLite `lower`/LIKE do not
establish Korean/Unicode search parity. FTS5 tokenization, lexical ranking,
trigram-like behavior, exact/approximate vector retrieval, and learned-model
index freshness remain a separate retrieval design and test task.

## Remaining integration work

Parent-owned integration must supply backend-specific repositories for auth and
bootstrap/settings/AI attempts, notes/links/revisions/tasks/templates/trash,
inbox/promotion, attachment lifecycle and cleanup, home/graph/export/import,
search/indexing, and chat. Existing services accept `pg.PoolClient`, PostgreSQL
SQL and PostgreSQL row representations; none can simply receive this executor.

Revision coalescing/retention and restore rules are service behavior, not triggers.
Attachment ownership repair, durable cleanup enqueueing and post-commit file
deletion are service behavior. Request identity/content binding, same-thread
assistant association, replay, archive, cancellation and per-thread streaming
serialization remain chat behavior; the schema preserves the current PostgreSQL
FKs rather than inventing a cross-thread constraint absent there. Single-owner
creation still needs a secure bootstrap boundary and serialized repository logic.
No database writer may span provider streaming: reserve briefly, release, then
finalize briefly with revalidation. The import and installer tracks are separate.

Do not enable a production/desktop switch until all services have real adapters,
their public contracts pass, and transfer/backup/restore plus local launch have
been verified. The foundation's successful tests do not certify those features.

## Local verification

Run without environment files or external services:

```sh
bun --no-env-file test ./src/server/db/sqlite
./node_modules/.bin/eslint src/server/db/sqlite
./node_modules/.bin/tsc --noEmit --incremental false
```

The tests use real `bun:sqlite` connections and unique temporary directories.
They cover reopen durability, upgrades, migration history drift/downgrade,
malformed SQL and transaction escapes, atomic rollback, bind isolation,
foreign keys, unique/partial indexes, cascades, representations, WAL snapshots,
writer contention, scoped executor expiry, and connection/directory cleanup.
No mocks, sleeps, network requests, provider calls, or shared databases are used.
