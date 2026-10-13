# Bounded operator updates (development)

Run the reviewed checkout's `scripts/update.mjs` with Linux Bun 1.4.2+.
Windows desktop packaging and updates explicitly refuse execution and remain
unverified in this round. Windows checkout launch and stopped v2 backup/restore
verification are documented separately in DESKTOP.md and BACKUP-DESKTOP.md.
Server backup also needs Node 22+, local Docker and Compose 5.1.0+.
No hosted updater URL, new public release or native package is claimed.
Obtain a real archive and trusted SHA-256 independently. Desktop artifacts must
come from the coherent `build.mjs` + `package-desktop.mjs` pipeline.
Checksums authenticate nothing if the checksum source is untrusted.

Both modes use explicit version/checksum/local archive input, keep the old app,
create an absent staging directory, make and restore-verify a fresh backup, and
write `update-activation.json` only after the gates pass. The staged code and
activation record are then sealed read-only. An existing output is never merged
or overwritten. All paths must be canonical absolute paths without symlinks;
app, data, staging, backup and verification directories must be separate.
Input roots and output parents must be owned and private (0700).
Only strictly newer stable versions are supported; downgrade selections fail.
Do not run competing installers, launchers, initializers or independent writers.

## Upgrading an install created before 2.4.0

Keep its existing database, role and physical volume names. The updater records
`POSTGRES_APP_DB`, `POSTGRES_APP_USER` and the original Compose project in the
staged install's `.env`, preserving its volume selection. Compose still reads
`IRANG_IMAGE` when `ARO_IMAGE` is absent, and authentication still reads
`sb_session` when `aro_session` is absent. The updater replaces the old image
key with `ARO_IMAGE`. For a hand upgrade, set `POSTGRES_APP_DB` and
`POSTGRES_APP_USER` in the existing `.env` to the actual database and role
values before starting Compose, or Compose refuses to start. Never substitute
`aro` for existing names or generate replacement passwords.

## Desktop

Stop the launcher before running:

```sh
bun --no-env-file scripts/update.mjs desktop \
  --version "$VERSION" --sha256 "$DESKTOP_SHA256" --archive "$DESKTOP_ARCHIVE" \
  --current-directory /absolute/private/aro-old \
  --directory /absolute/private/aro-new \
  --data-dir /absolute/private/aro-data \
  --backup /absolute/private/backups/pre-upgrade \
  --temp-parent /absolute/private/verification
```

The existing package manifest must match this native platform and the new
manifest must match the explicit target version. Archive corruption, missing
files, unsafe inventory, existing targets and version mismatch fail before
backup or staging. Backup uses the existing SQLite snapshot/attachment workflow.
The launcher lock remains held from snapshot through restore verification and
staging. A busy lock refuses immediately, without deleting/replacing the lock.
Private data remains at **exactly the original data path**, including its IDs,
credentials and attachments. No new owner or fresh data directory is created.

## Server

Stop independent DB/file writers. Acknowledge an already-authorized private GHCR
login; this command never logs in or falls back to anonymous access:

```sh
bun --no-env-file scripts/update.mjs server \
  --version "$VERSION" --sha256 "$SERVER_SHA256" --archive "$SERVER_ARCHIVE" \
  --current-directory /absolute/private/server-old \
  --directory /absolute/private/server-new \
  --project original-project --authenticated yes \
  --backup /absolute/private/backups/pre-upgrade
```

Unset `DOCKER_HOST`/`DOCKER_CONTEXT`; remote daemons are refused. Release,
checksum, digest and pulled OCI version/revision are checked. The new archive is
staged with a copy of `.env` that pins `ARO_IMAGE` to the target image and records
`POSTGRES_APP_DB`, `POSTGRES_APP_USER` and `COMPOSE_PROJECT_NAME` from the
existing deployment. Secrets and other settings are preserved; the old
directory remains untouched.
No separate image overlay is needed for future backup/update commands.
Resolved old/new configurations must preserve project, named volumes, DB image,
ports, mounts and settings. The image and equivalent database-name declarations,
healthcheck spelling and upgrade checks may differ.
Relative bind mounts resolve against the **old installation directory**, which
must remain available. Changed Compose contracts are refused, not guessed at.

The selected project's app is stopped **before** the final backup. The existing
backup tool therefore sees an already-stopped app and does not restart it.
The full DB/files restore check must succeed, including sandbox cleanup, before
an activation record is written. The app is checked still stopped afterward.
There is no automatic restart on failure, volume deletion or image rollback.
Keep the exact old DB image locally for restore verification.

## Verified activation boundary

Exit 0 means `verified-staged-not-started`, **not an upgraded/running app**.
The code deliberately does not start a migrating application or claim migration
compatibility from a backup round trip. Inspect the private
`NEW_DIRECTORY/update-activation.json`. Its `activation` field is the exact argv
for the operator's final activation: desktop starts the new immutable package
with the original data directory; server runs Compose `up` for **app only** with
`--no-deps --pull never --wait`, the original project and project directory,
the staged environment with its new image pin.

After inspecting that record, execute its argv without a shell or interpolation:

```sh
bun --no-env-file -e '
const p = await Bun.file(process.argv[1]).json();
if (p.schemaVersion !== 1 || p.state !== "verified-staged-not-started")
  throw new Error("Not a verified activation record");
const child = Bun.spawn(p.activation, {
  env: Object.fromEntries(["PATH","HOME","DOCKER_CONFIG","XDG_RUNTIME_DIR"]
    .filter(k => process.env[k] !== undefined).map(k => [k,process.env[k]])),
  stdin: "inherit", stdout: "inherit", stderr: "inherit"
});
process.exit(await child.exited);
' /absolute/private/aro-new/update-activation.json
```

This is an explicit operator selection, not an automatic pointer switch.
Do not use a record from a failed/interrupted run, edit sealed artifacts, change
old configuration, resume the old app, or admit writes between staging and
activation. If any of those happened, take a **new final backup** and re-stage
into a different absent directory. Server `managementPrefix` records the exact
Compose selection for subsequent management; do not revert to an implicit
project/directory. After activation, use the staged directory as the current
installation for future backup/update commands, with the same project name.

Activation timeout, missing health, process exit, lost response or interrupted
startup is incomplete/uncertain, never successful merely because staging passed.
Parent integration must verify login, persisted IDs/configuration, attachments,
HTTP behavior, migrations, native runtime permissions and startup at the target
version. Desktop's launcher holds its own lock while running. Read-only artifacts
may expose an application cache-write requirement; this lane does not relax
permissions or add runtime files to work around one.

## Failure and recovery matrix

| Failure | State / required action |
| --- | --- |
| Invalid arguments, unsafe paths, corrupt archive or version | No backup/staging/activation; input left intact |
| Desktop runtime lock busy | No backup/staging; stop launcher; never remove its lock |
| Pull/auth/provenance failure | No downtime or activation; local image cache may remain |
| Changed server Compose contract | Stage may remain; app not stopped; do not activate |
| Backup failure | Desktop partial snapshot cleaned by backup; server may retain partial backup and remains stopped |
| Restore/integrity/cleanup failure | No activation record; valid/partial backup and staging retained; inspect only owned sandbox resources |
| Stage/seal failure or host/process crash | No confirmed completion; keep previous app/data/backup; inspect artifacts and app state |
| Operator activation fails or migrations start then fail | No automatic rollback; preserve DB/files and diagnose locally |

Never run the old code against a DB changed by new migrations as a recovery
shortcut. Recovery means restoring a **validated pre-upgrade backup into a new,
isolated empty environment**, with the matching old app and DB image. Do not
overwrite current data, remove volumes, or claim backward migrations are safe.
Desktop restore verification currently proves recovery contents in a disposable
directory only; production publication of a restored directory remains an
explicit parent/operator procedure. Server restore verification likewise creates
only its owned disposable namespace. See BACKUP.md and BACKUP-DESKTOP.md.

## Focused verification

```sh
bun --no-env-file test scripts/update.test.mjs
bun --no-env-file test scripts/backup-desktop.test.ts scripts/install-desktop.test.mjs scripts/install-server.test.mjs
bun --bun node_modules/eslint/bin/eslint.js scripts/update*.mjs --max-warnings=0
```

Tests use real temporary SQLite/files and deterministic Docker child processes
with persisted fixture state. They do not invoke a real registry, live Docker
resources or a production app. Real Docker/native/app integration belongs to the
parent; staged completion alone is intentionally not application acceptance.
