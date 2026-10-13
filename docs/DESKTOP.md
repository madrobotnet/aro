# Local SQLite runtime (development)

The local runtime uses SQLite and filesystem attachments, not Docker or a
PostgreSQL server. The checkout workflow is verified on Linux arm64 and real
Windows 11 x64 with Bun 1.4.2: owner initialization through stdin, production
start, HTTP login, notes, binary attachments, restart persistence, duplicate-start
refusal, stopped backup/restore verification, and Ctrl+C shutdown.
macOS is unverified. Native Windows packages, Windows desktop updates, and a
published curl installation endpoint are not available.

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
On Linux the data directory must be owned by the operator, mode 0700, and contain
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
