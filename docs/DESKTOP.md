# Local SQLite runtime (development)

The local runtime uses SQLite and filesystem attachments, not Docker or a
PostgreSQL server. This development launcher is currently verified on Linux
arm64 with Bun 1.4.2. Native macOS/Windows packages and a published curl
installation endpoint are not available yet.

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
The data directory must be owned by the operator, mode 0700, and contain no
symlink path components. The launcher does not relax permissions on an existing
directory.

For development:

```sh
bun --no-env-file scripts/desktop.ts start \
  --data-dir "$HOME/.local/share/aro" --port 3000 --dev
```

For an already-built application, omit `--dev`. Production mode requires the
checkout's `.next/BUILD_ID`; this command does not install dependencies or build
silently. Open `http://127.0.0.1:3000` and use the password just created.

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
