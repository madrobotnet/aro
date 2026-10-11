# Markdown and ZIP import

Settings offers an additive import of a Markdown file (`.md` or `.markdown`) or
a ZIP containing Markdown notes and local attachments, including an Obsidian
vault or this application's Markdown export.

1. Select a file up to 24 MiB.
2. Preview the notes, attachment count, conflicts, and warnings.
3. Review missing attachments and unsupported metadata. Confirm explicitly.
4. Import and retain the success receipt. A failed request is not a success receipt.

Existing notes are never overwritten. A title or alias collision, including a
note in trash or a duplicate within the upload, blocks the entire import. Rename
conflicting source notes and update their links, then preview again. Repeating a
successful upload therefore does not silently replace or duplicate existing notes.
If the network disconnects during confirmation, preview again before retrying:
the server may already have committed.

Only notes and local attachments are imported. This is **not** a restore of
inbox, chat, settings, trash, revisions, identities, timestamps, or an entire
installation. Unsupported frontmatter is reported rather than applied as
application state. No remote attachments are downloaded and no AI is called.

The importer preserves Markdown content and code, supported aliases and tags,
and rewrites resolvable local note and attachment links. Missing attachment
references appear in the preview; accepting the warning does not recover the
missing bytes. Ambiguous links cannot be guessed safely.

## Limits and validation

The server independently validates both preview and commit. Uploads are limited
to 24 MiB to fit beneath the existing proxy body limit. Expanded archives are
limited to 64 MiB, 1,000 entries, 500 notes, and 25 MiB per entry. The archive
parser rejects unsafe paths, symbolic links, unsupported archive encodings and
compression kinds, and invalid or excessive decompression. No archive path is
used as a destination filesystem path: attachments receive new UUID storage keys.

Commit is all-or-nothing for database writes. The transaction locks against
concurrent note writers while validating conflicts, creates notes through the
existing note service, indexes links, and inserts attachment metadata. If a
handled write or SQL failure occurs, the database rolls back and newly created
attachment files are removed. A cleanup failure is explicitly reported as
requiring attention, not as a successful import.

Filesystem and database operations cannot share a crash-atomic transaction.
A process or host crash before SQL commit can leave unreferenced UUID files;
this increment does not add a persistent import recovery journal. Keep normal
backups; import is not a substitute for backup and restore.

## HTTP interface

Both endpoints require the existing owner session and same-origin checks:

- `POST /api/import/preview`
- `POST /api/import/commit`

Send the file bytes as `application/octet-stream` with
`x-import-filename: <encodeURIComponent(filename)>`. Preview returns a digest,
note list, attachment count, warnings, conflicts, and `canCommit`.

Commit resends the same bytes and filename with `x-import-digest` from the
preview and `x-import-confirm: true`. It reparses the upload and rechecks current
database conflicts. Stale previews return HTTP 409 with no import. A successful
HTTP 201 receipt includes the new note IDs, paths, titles, attachment count,
and accepted warnings.

## Focused verification

Use only an owned disposable PostgreSQL database whose name matches the test
safety contract (`sb_test_<lane>`). Never point these commands at user data.

```sh
bun test src/lib/import-format.test.ts src/server/import/request.test.ts
TEST_DATABASE_URL=<owned-loopback-test-url> bun test src/server/import/service.integration.test.ts
TEST_DATABASE_URL=<owned-loopback-test-url> IMPORT_QA_URL=http://127.0.0.1:31871 \
  bun src/server/import/http-qa.ts
```

The last command drives a separately started real application server configured
with the same owned database and an owned attachment directory. It captures HTTP
status, headers, and response bodies for authentication, preview, confirmation,
attachment retrieval, repeated import, unsafe ZIP rejection, and missing files.
It resets that disposable database. Browser layout and interaction QA remain a
separate check.
