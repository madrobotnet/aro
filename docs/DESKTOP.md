# Local SQLite runtime (development)

The local runtime uses SQLite and filesystem attachments, not Docker or a
PostgreSQL server. The checkout workflow is verified on Linux arm64 and real
Windows 11 x64 with Bun 1.4.2: owner initialization through stdin, production
start, HTTP login, notes, binary attachments, restart persistence, duplicate-start
refusal, stopped backup/restore verification, and Ctrl+C shutdown.
The production checkout workflow is also verified on GitHub-hosted macOS
runners with Bun 1.4.2 and Node 22, not on a physical Mac:
`macos-latest` (Apple Silicon, macOS 26.6.2/25G83, image 20260907.0351.1) and
`macos-26-intel` (x64, macOS 26.6.1/25G76, image 20260824.0517.1).
Native macOS/Windows packages, macOS/Windows desktop updates, and a published curl
installation endpoint are not available.

From this checkout, initialize a private data directory. The password is sent
over standard input, not as a command argument. In Bash:

```bash
read -r -s -p 'New Aro password (at least 12 characters): ' ARO_PASSWORD
printf '\n'
printf '%s\n' "$ARO_PASSWORD" |
  bun --no-env-file scripts/desktop.ts init \
    --data-dir "$HOME/.local/share/aro" --password-stdin
unset ARO_PASSWORD
```

Initialization creates the single owner locally with AI disabled. It does not
open a network listener, ask for an installation token, or overwrite an existing
owner. Use a private terminal; do not enable shell tracing or record the session.
On Linux and macOS the data directory must be owned by the operator, mode 0700, and contain
no symlink path components. The launcher does not relax permissions on an existing
directory. Windows uses the ACL check described below instead of POSIX mode bits.

For development:

```sh
bun --no-env-file scripts/desktop.ts start \
  --data-dir "$HOME/.local/share/aro" --port 3000 --dev
```

For an already-built application, omit `--dev`. Production mode requires the
checkout's `.next/BUILD_ID`; this command does not install dependencies or build
silently. Open `http://127.0.0.1:3000` and use the password just created.

## macOS checkout verification

The two runner images passed typecheck and production build, stdin owner
initialization, private-directory acceptance and shared/symlink-directory refusal,
loopback-only listening, duplicate-start refusal, real HTTP login, note creation
and reading, binary attachment upload/download, session/note/byte persistence
after restart, and stopped backup/restore verification. Native argon2 hashing and
password verification worked on both arm64 and x64. Case-distinct attachment
metadata did not collide on the runners' case-insensitive APFS; portable export's
case-collision and Unicode filename tests also ran.

POSIX ownership, private modes and no-symlink checks are identical to Linux.
Use canonical paths: macOS `/tmp` redirects to `/private/tmp`, and `os.tmpdir()`
can return `/var/folders/...` instead of `/private/var/folders/...`. A redirected
path is still refused. Resolve an existing temporary parent before creating test
directories; the launcher never silently resolves away an operator's symlink.

Programmatically delivered SIGINT and SIGTERM left no live recorded descendants
or listener and allowed reacquisition of the runtime lock. SIGKILL of the launcher
left two app descendants and the loopback listener alive on both images, although
the launcher's SQLite lock was released. Recovery killed the recorded owned app
descendants, checked that the listener was gone, then allowed reuse of the data
directory. Do not treat an available lock as proof that the app stopped, and do
not delete lock files or SQLite sidecars.

Local model management remains Linux-only and is not invoked on macOS. Server/
Docker tooling, official chat CLI providers, desktop packaging and desktop
updates are unsupported on macOS. Package/update calls refuse before writes.
Portable source/archive fixture checks do not certify distribution tooling.
Development `--dev` and live optional external providers were not verified.

Verification used GitHub-hosted runners, not a physical Mac. Interactive Terminal
Ctrl+C, Gatekeeper/quarantine behavior of downloaded files, sleep/wake, and
non-default filesystems were not exercised.

## Windows 11 x64

Use an installed Bun 1.4.2 and this checkout with its dependencies installed.
In PowerShell, from the repository root:

```powershell
$data = Join-Path $env:USERPROFILE "aro-data"
$OutputEncoding = [Text.UTF8Encoding]::new($false)
$secret = Read-Host "New Aro password (at least 12 characters)" -AsSecureString
(New-Object System.Net.NetworkCredential("", $secret)).Password |
  bun --no-env-file scripts/desktop.ts init --data-dir $data --password-stdin
Remove-Variable secret
bun run build
bun --no-env-file scripts/desktop.ts start --data-dir $data --port 3000
```

Windows `--dev` is explicitly refused. Local model management, server/Docker
deployment tooling, official chat CLI providers, desktop packaging and desktop
updates remain unsupported on Windows. The API-based optional providers are not
certified by this desktop workflow.

### Windows privacy boundary

A bounded PowerShell call reads ACLs as numeric SIDs, not localized account names.
The data directory must be canonical and not a reparse point. Its owner must be
the current user or Administrators (`S-1-5-32-544`). Every Allow rule must belong
to the current user, SYSTEM (`S-1-5-18`), or Administrators. An Allow rule for
Users, Everyone, Authenticated Users, CREATOR OWNER, or any unknown account is
refused, including inherited rules. Errors, invalid output, and the 10-second
inspection timeout fail closed. A newly created directory is checked in exactly
the same way; the launcher never rewrites its ACL.

This is a conservative allowlist, not an effective-access evaluator: a denied
foreign Allow rule is still refused. Administrators and SYSTEM remain trusted.
It does not defend against the owner or an administrator changing ACLs or paths
after inspection, and it does not make a transaction spanning filesystem checks
and SQLite opens. The real-machine test granted Users Modify and verified refusal,
then removed that test directory.

### Windows shutdown and abrupt termination

Use Ctrl+C in the launcher's console. The launcher attempts graceful process-tree
termination, follows it with bounded `taskkill /PID APP_PID /T /F`, awaits the app,
and then releases the SQLite runtime lock. SIGINT/SIGBREAK handlers use the same
path where Bun delivers those events. The real-machine verification checks the
recorded descendant PIDs, the loopback listener, and reacquisition of the lock.

Task Manager end-task or forced termination of the launcher cannot run its
cleanup. On the verified Bun 1.4.2 production run, forced launcher termination
left no surviving app descendant or listener, and the OS-released runtime lock
was reacquired. This observation is not an abrupt-termination cleanup guarantee.
Before restarting, check the recorded descendant PIDs and the loopback port.
If a recorded app child remains, stop its tree with `taskkill /PID APP_PID /T /F`;
once the descendants and listener are gone, start with the original data directory.
Do not delete lock files or sidecars; lock availability alone does not prove shutdown.

The launcher binds only to loopback and supplies its own SQLite, attachment and
cookie settings. It does not inherit PostgreSQL URLs, model keys or setup
secrets. A separate SQLite runtime lock prevents a second launcher from using
the same data directory. Do not remove `runtime.lock.sqlite` or SQLite sidecars
to bypass a busy error. Stop the running app first.

This is one primary environment, not desktop/server live synchronization.
Markdown import/export moves notes and local attachments, not the entire owner
account, chat history, settings, trash or revision history. Keep the original
environment until transferred data is verified.

The runtime adapter work is still in progress. A successful startup alone does
not certify every optional provider, model, backup, update or transfer workflow.
