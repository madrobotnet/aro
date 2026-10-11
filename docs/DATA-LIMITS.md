# Data volume and attachment boundaries

Both backends retain the same user-facing note/attachment contract. SQLite
does not store attachments inside the database: database and filesystem data
must travel together in a backup.

## Portable import

The preview and commit enforce the same limits:

- 24 MiB uploaded Markdown/ZIP payload.
- 64 MiB total expanded ZIP data.
- 25 MiB per entry, at most 1,000 entries and 500 Markdown notes.
- 2,000,000 characters per note body.

Archives beyond a limit are rejected, not partially imported or silently
truncated. Invalid paths, duplicate/conflicting identities and unsupported
archive structures are rejected. Missing files and unsupported metadata appear
in the preview; the owner must confirm warnings before commit. Existing notes
are not overwritten.

For a larger vault, use bounded batches and preserve wiki links. References to
files outside a batch cannot be assumed resolved: review each preview and keep
the source vault until links and attachments are verified. Import is note
transfer, not a replacement for full-instance backup.

## Export and local search

Exports use a coherent backend snapshot, paged note bodies and 64 KiB
attachment reads with backpressure. A missing attachment is recorded in the
manifest rather than replaced with a broken exported path. Cancellation releases
the snapshot.

SQLite lexical/index freshness scans use batches of 100 notes; learned retrieval
reads passage batches and retains only the requested best results. These local
fallbacks avoid loading every body/vector into memory at once, but scanning a
large notebook still takes work. No fixed latency guarantee is made for an
arbitrary-size vault.

The inbox, note lists, task views and graph retain their existing paging and
result limits. Full backup/restore remains the recovery path for owner accounts,
inbox state, revisions, chat, settings and files.
