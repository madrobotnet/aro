# Desktop backup and restore verification

These commands are verified with Bun 1.4.2 on Linux arm64, real Windows 11 x64,
and GitHub-hosted macOS runners: `macos-latest` (Apple Silicon, macOS 26.6.2/25G83,
image 20260907.0351.1) and `macos-26-intel` (x64, macOS 26.6.1/25G76,
image 20260824.0517.1). They require a **stopped desktop application**.
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

On Windows, backups use **format version 2**, with `platform: "win32"` and
`permissionModel: "windows-acl"`. No POSIX mode fields are recorded or synthesized.
Content inventory, bounded copying, SQLite checks, sizes, and checksums remain
the same. Source/output roots, output parents, backup roots, and restored sandboxes
must pass the SID-based privacy check in [DESKTOP.md](DESKTOP.md). Paths must be
canonical and free of symlinks/reparse-point redirection. Windows verification
checks content identity and root/sandbox privacy instead of POSIX mode equality;
it does not preserve or restore individual NTFS ACLs or certify effective access
for every possible Windows principal.

Linux and macOS readers accept v1 only; Windows readers accept v2 only. The other platform
family is refused before creating a restore sandbox, and a v2 manifest containing
POSIX mode fields is malformed. Linux and macOS use the identical POSIX v1
format and unchanged ownership/mode/no-symlink checks. A Linux-made v1 backup
verified on both Mac images; a backup made by each Mac image verified on Linux.
This verifies snapshot contents, checksums, modes, SQLite integrity and attachment
references in both directions, not live restore over an installation. Destination
paths must be representable on its filesystem; these runs do not certify every
Linux filename on case-insensitive APFS or non-default filesystems. Moving notes
between the POSIX and Windows families uses Markdown/ZIP export and import.

macOS temporary parents must be canonical too: use `/private/tmp`, not the
`/tmp` alias, and resolve an existing `/var/folders/...` parent to its
`/private/var/folders/...` path before creating a verification directory. Neither
CLI follows symlink ancestors or relaxes POSIX permissions.

In PowerShell, use absolute paths and private parent directories:

```powershell
bun --no-env-file scripts/backup-desktop.ts `
  --data-dir "$env:USERPROFILE\aro-data" `
  --output "$env:USERPROFILE\aro-backups\stopped-snapshot"
bun --no-env-file scripts/restore-desktop-check.ts `
  --backup "$env:USERPROFILE\aro-backups\stopped-snapshot" `
  --temp-parent "$env:USERPROFILE\aro-verification"
```

Create `aro-backups` and `aro-verification` first. No ACL is relaxed automatically.
Local model management, server/Docker tooling, official chat CLI providers, and
desktop packaging/updates are not Windows-supported workflows.

The same workflows remain unsupported on macOS. Verification used GitHub-hosted
runners, not a physical Mac; interactive Terminal Ctrl+C, Gatekeeper/quarantine
behavior of downloaded files, sleep/wake and non-default filesystems were not
exercised. See [DESKTOP.md](DESKTOP.md) for signal and abrupt-launcher-death results.

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
