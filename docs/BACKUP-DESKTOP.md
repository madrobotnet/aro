# Desktop backup and restore verification

These commands require Linux, Bun 1.4.2, and a **stopped desktop application**.
They are separate from the PostgreSQL/server backup commands. Run from the
repository root, as the desktop data directory's owner:

```sh
# Existing directories must be owned, private (for example 0700), and canonical.
# The backup output itself must not exist, even as an empty directory.
bun --no-env-file scripts/backup-desktop.ts \
  --data-dir /absolute/private/desktop \
  --output /absolute/private/backups/desktop-2026-10-11

# temp-parent is an existing private directory, outside the backup.
bun --no-env-file scripts/restore-desktop-check.ts \
  --backup /absolute/private/backups/desktop-2026-10-11 \
  --temp-parent /absolute/private/verification
```

Stop the app yourself. Backup acquires the launcher's same
`runtime.lock.sqlite` `BEGIN IMMEDIATE` lock with `busy_timeout=0`, and holds it
through database snapshot, attachment copying, validation, and manifest writing.
An active launcher causes immediate refusal. The command neither terminates the
app nor unlinks/replaces the lock file. If no lock file exists, it creates one
with exclusive creation and mode 0600. Keep this file in place afterward.
As with the launcher, this lock coordinates cooperating desktop processes:
do not run initialization, other SQLite writers, attachment writers, or another
tool that mutates the data directory during backup.

## Contents and completion

Backup uses native SQLite `VACUUM INTO`, reading committed WAL pages into a
consistent standalone database. It does not copy the raw live main file or WAL
sidecars. This is a logical SQLite snapshot, not a byte-identical database image;
SQLite can compact pages and change implicit rowids in tables without explicit
primary keys. Desktop records use explicit IDs.

The backup contains `aro.sqlite`, the entire `attachments` tree (including
unreferenced files and empty directories), and `manifest.json`. Other runtime
files, per-thread locks, database sidecars, environment files, and application
binaries are excluded. Application/schema metadata and all stored credentials
inside the database remain part of the database snapshot.

Format version 1 records the snapshot method, creation time, source root mode,
relative paths, POSIX permission bits, file sizes, and SHA-256 checksums.
Attachment bytes and DB/file/directory permissions are preserved. Backup root
and manifest are private. Inputs must be owned regular files/directories, without
symlinks anywhere in their paths. Hard-linked files, special permission bits,
unreadable files, and directories without owner read/execute permissions are
refused. The source root, output parent, backup root, and temporary parent must
be private. Paths must be canonical absolute paths; existing output paths and
output inside the data directory are refused.

File copies and hashes use 1 MiB buffers, including for large databases and
attachments. Manifests are limited to 16 MiB and 100,000 entries. The manifest is
written last, after SQLite integrity, foreign keys, and attachment references
have passed checks. Files are synced before completion. A handled failure
removes only the newly created output; an abrupt process or machine failure can
leave an incomplete directory. A manifest alone is not proof of a usable backup:
run restore verification before relying on it. No power-loss atomicity guarantee
is claimed. The CLI reports fixed status/error messages, never database rows,
credentials, source file names, or underlying SQLite/filesystem errors.

## Verification, not live restore

Verification parses the manifest and validates paths, versions, the exact
inventory, checksums, sizes, and modes **before** creating a sandbox. It then
creates a new empty owned temporary directory under `--temp-parent`, restores
the snapshot and all attachment bytes, rechecks hashes and permissions, opens
restored SQLite read-only, runs `PRAGMA integrity_check` and
`PRAGMA foreign_key_check`, and checks every attachment storage key and byte size
against the restored inventory. This proves attachment identity against the
backup's checksums, including unreferenced attachment files.

The sandbox is removed on success and on verification failure. Cleanup must
succeed before the success message is printed. Cleanup makes only sandbox
directories writable when needed, never changes input permissions, and never
touches an existing installation. The temporary parent should be dedicated to
verification, not inside a live data directory. Checksums detect corruption,
not forgery by someone who can rewrite both payload and manifest.

There is intentionally no command to restore over an installation or to publish
a restored installation in this bounded first version. Keep the app stopped
until backup completes; restore verification does not require live installation
access. Parent integration validation should exercise both real CLI commands
end-to-end before shipping.

Focused checks:

```sh
bun test scripts/backup-desktop.test.ts
bun --bun node_modules/eslint/bin/eslint.js scripts/backup-desktop-common.ts scripts/backup-desktop.ts scripts/restore-desktop-check.ts scripts/backup-desktop.test.ts
bun --bun node_modules/typescript/bin/tsc --noEmit --incremental false
```
