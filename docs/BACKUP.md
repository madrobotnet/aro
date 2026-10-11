# Installer backup and restore check

These management commands require **Node.js 22+ on the operator host**, Docker,
Docker Compose, and access to the local Docker daemon. Node is an additional
prerequisite; the installed application itself does not require host Node/Bun.
Ship `scripts/backup.mjs`, `scripts/restore-check.mjs`, and
`scripts/backup/common.mjs` together. They use Node built-ins only, without
`node_modules` or source-tree imports. Bun is needed only to run the tests.

## Backup

From the installer directory:

```sh
node scripts/backup.mjs \
  --install-dir /srv/irang \
  --project irang \
  --output /private/backups/irang-20261011
```

All three options are required. The output parent must already exist; the
output directory must not exist and must be outside the installation.
`--compose-file FILE` optionally selects one Compose file (relative to
`--install-dir`, or absolute); default: `compose.yml`. There is no implicit
Compose override, host environment interpolation, or project-name inference.
Use `--help` alone to print usage. Unknown/duplicate options and missing
values fail with exit 1. Success prints `BACKUP_OK <directory>` with exit 0.

The installation must have `.env`, installed `release.json`, and exactly the
stock `app` and `db` services. The image reference and running app's OCI
version/revision labels must match `release.json`. The DB must be running
PostgreSQL 18. The app may be running or stopped, but not paused/restarting.
The `/app/.data` mount and PostgreSQL data mount must be named volumes labeled
with the selected Compose project. Extra app mounts, links/devices inside
app-data, and non-stock services are rejected rather than silently omitted.

The app is stopped while `pg_dump --clean --if-exists` and app-data are copied.
Stop independent DB/file writers and avoid changing installation configuration
during the command. The app is restarted only if it was running beforehand,
including after a backup failure or SIGINT/SIGTERM. SIGKILL, host failure, or
Docker-daemon failure cannot guarantee restart; inspect the app state then.
No migrations or app/provider calls are made.

The new directory is 0700; each artifact is 0600:

| File | Contents |
| --- | --- |
| `database.sql` | Whole DB, including notes, trash, settings, sessions, chat |
| `app-data.tar.gz` | Attachment and CLI-auth files, retaining modes/UID/GID |
| `operator.env` | Private operator configuration and secrets |
| `compose.yml` | Selected original Compose file |
| `release.json` | Installed version/revision/image identity |
| `deployment.json` | Project, pinned local image IDs, volume names, image references, resolved Compose configuration |
| `manifest.json` | Schema/version/revision, streamed artifact byte counts/SHA-256 and normalized DB content hash |

The resolved configuration, dump, and file archive can also contain secrets.
Keep the entire directory private. Checksums detect corruption, **not malicious
replacement**; this is not a signed backup. Images are recorded, not exported.
Retain release images separately, including the exact recorded DB image.
Compose bind-mounted init scripts/custom dependencies are not bundled by this
unit; keep the original installer and any operator additions separately.

Failures print `BACKUP_FAILED` and exit 1. Diagnostic command output is withheld
because it may contain secrets. A partial directory is intentionally retained
for diagnosis; it has no completed manifest and must not be restored. Existing
output is never overwritten. Choose a different path for a retry.

## Disposable restore verification

```sh
node scripts/restore-check.mjs \
  --backup /private/backups/irang-20261011 \
  --expected-version 2.4.0
```

Both options are required. First, the command validates the private directory,
regular non-symlink artifacts, exact artifact set, manifest schema, explicit
expected version, release revision, image identity, and streamed checksums.
No Docker resource is created until these checks pass. The exact DB image ID
must still exist locally; nothing is pulled.

The command owns a new random `irang-backup-qa-<UUID>` namespace. It rejects
resource-name collisions and creates two fresh empty volumes and a DB
container with an owner label. There are no published ports, Docker networks,
app process, production credentials, or provider calls. It creates the
`second_brain` role, restores SQL as `postgres` with `ON_ERROR_STOP` in one
transaction, then re-dumps and compares complete schema/data (excluding only
PostgreSQL's randomized restrict tokens). It rejects unsafe archive paths and
links/devices before extracting into the new empty app-data volume, then
re-archives and compares bytes, modes, ownership and timestamps.

Only resources bearing this invocation's owner label are removed, on success
or failure. Success is reported **after cleanup**, with
`RESTORE_CHECK_OK <namespace> (database/files verified; sandbox removed)`.
A restore or cleanup failure prints `RESTORE_CHECK_FAILED` and exits 1.
If cleanup fails, inspect only the printed/owned QA namespace; do not delete
other installations. There is no existing-install target option and no
production restore path.

This verifies stored DB/file recovery, not HTTP behavior, app startup,
provider credentials, a version upgrade, or cross-major PostgreSQL migration.
Follow SETUP's separate-empty-install recovery procedure for actual recovery.
Scheduling, remote storage and imports are outside this command's scope.

## Focused tests

```sh
bun --no-env-file test scripts/backup.test.mjs
IRANG_BACKUP_CONTAINER_QA=1 bun --no-env-file test scripts/backup.test.mjs
```

The second command additionally requires local
`pgvector/pgvector:0.8.6-pg18`, Docker and Compose. It builds a uniquely tagged
synthetic fixture image locally, exercises real DB rows/extensions, binary
attachment/auth files, permissions, previous stopped/running state, failure
restart, no overwrite, and sandbox cleanup. It removes only its own fixture
containers/volumes/image. No real credentials or provider calls are used.
