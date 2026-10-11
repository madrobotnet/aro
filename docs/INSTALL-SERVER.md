# Fresh server bootstrap (development checkout)

This additive installer consumes the existing public GitHub release archive format.
It does not publish itself, rename release assets, or make the private GHCR image
public. There is **no published hosted curl installer URL claimed here**. Run the
reviewed script from this checkout with Bun 1.4.2 or newer. Docker and Compose
5.1.0 or newer must already be installed; the installer never installs them or
uses sudo. Native Linux amd64 and arm64, with a local Unix-socket Docker context,
are supported. Other hosts and remote Docker contexts are rejected.

## Verify and install

Choose a stable published version and obtain the archive SHA-256 from that
release's trusted `SHA256SUMS`. A checksum supplied by an untrusted party does
not authenticate a release. Do not substitute a version from the checkout's
directory name. GitHub source and release assets are now at `madrobotnet/aro`; published
2.3.2 archives and GHCR images keep their original identifiers.

```sh
# Set VERSION and ARCHIVE_SHA256 to the reviewed release and its real checksum.
# Select an existing parent directory; the installation directory MUST NOT exist.
BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun --no-env-file scripts/install-server.mjs \
  --version "$VERSION" --sha256 "$ARCHIVE_SHA256" \
  --directory "$HOME/aro-server" --project aro-server --dry-run
```

Dry-run downloads and validates the archive in memory but does not write files,
invoke Docker, pull images, or start services. The environment variable above
also disables Bun's own runtime transpiler cache writes. To also avoid network reads, add
`--archive /path/to/irang-VERSION-install.tar.gz` to either command.

The GitHub source/assets are public; the GHCR package is private. Separately run
`docker login ghcr.io` using an account authorized for the package, preferably
with `--password-stdin` and a credential helper. Do not put a token in command
arguments. Then acknowledge that authentication explicitly:

```sh
bun --no-env-file scripts/install-server.mjs \
  --version "$VERSION" --sha256 "$ARCHIVE_SHA256" \
  --directory "$HOME/aro-server" --project aro-server --authenticated
```

The installer verifies archive/version/ref/revision, Compose's checksum, immutable
app image and loopback binding, database initialization asset, local Docker
architecture, Compose version, unused project resources/volume names and port.
It pulls the digest-pinned app before creating installation files. No anonymous
fallback is attempted on pull failure. It generates distinct random secrets,
reserves a new mode-0700 directory, and exclusively creates a mode-0600 `.env`.
Public archive files/directories use 0644/0755 so PostgreSQL can read its
bind-mounted initialization script under its container UID.
Inherited image, Compose and setup-secret overrides are not passed to Docker.
Docker diagnostics are not forwarded because resolved environments may contain
secrets. The PostgreSQL image retains the existing release's version pin, not a
newly claimed digest pin. No embedding model is installed.

The app defaults to `127.0.0.1:3000`, HTTP cookies, and zero trusted proxy hops.
`--port` selects a port from 1024 through 65535. Startup waits for Compose's
health/readiness gate; it is not a full browser/application acceptance check.
For another machine, use SSH forwarding to this loopback port. Before putting
a TLS proxy in front, set `INSECURE_COOKIES=0` and the appropriate proxy hops
in the private `.env`, recreate the app, and follow [SETUP.md](SETUP.md).
Do not publish the HTTP port directly.

## Installation code without log output

To create the owner during installation without copying an installation code,
add `--password-stdin` to the authenticated install command and pipe a password
of 12–512 characters from a private prompt. The installer sends the generated
authorization code and chosen password in the body of the existing protected
loopback `/api/setup` POST, with AI disabled. It refuses redirects and never
puts either secret in a URL or command argument. Do not combine this option
with dry-run. If the response is lost, it reports an unconfirmed outcome without
retrying; try the chosen login password before manual recovery.

The installer and `setup-env.mjs` do not print the code in ordinary output.
On the installation host, as the owner of the private `.env`, run:

```sh
bun --no-env-file scripts/install-server.mjs --token \
  --directory "$HOME/aro-server"
```

This explicit retrieval refuses captured/non-terminal stdout, symlinks, files
not owned by the operator, and group/world-readable environments. Use a private
terminal without session recording, then paste the code into `/setup`. The code
never enters a URL, generated webpage, telemetry, or unauthenticated API.
Ownership authorization on the existing setup POST remains mandatory.

Automatic browser prefilling is not implemented; `--password-stdin` performs
owner creation directly instead. A possible future browser-only
design is an operator-invoked, short-lived loopback broker that verifies the
private environment owner, requires a separate one-use capability POST plus
exact Origin/Host checks, and exchanges it for a browser-bound, expiring setup
session. The server must verify that session at the existing first-owner boundary,
invalidate it on owner creation, and prohibit token/session logging. Delivering
the capability must itself use an owner-controlled local channel, not a public
query parameter or an unauthenticated loopback GET. This requires server auth
and lifecycle contracts beyond this installer lane; merely binding a token
endpoint to loopback does not authorize arbitrary webpages to read it.

## Failure, recovery, and upgrades

This command is **fresh-install only**. It rejects even an empty existing target
directory and any existing project resources or conventional volume names.
It does not resume, upgrade, rewrite `.env`, attach existing data, or delete
anything. A port/resource preflight is not an interprocess lock: run only one
installer for a given project/port and do not create competing resources.

A failure before directory creation leaves installation files and volumes
untouched (a successful image pull may remain in the local cache). After creation,
files and any started resources remain intentionally available for diagnosis.
Do not rerun against that directory or choose a new project to hide a failure.
Inspect the private files and local Docker state; fix the cause, then use explicit
Compose commands with the original project:

```sh
cd "$HOME/aro-server"
docker compose --project-name aro-server --env-file .env -f compose.yml \
  up -d --wait --wait-timeout 180
```

Diagnostics such as `docker compose config` or container logs can reveal secrets;
inspect locally and redact before sharing. Stop with `docker compose ... stop`,
not `down -v`. Never remove volumes as a retry shortcut.

For upgrades, back up and verify restoration first, preserve the exact original
Compose project, volume identities and `.env`, verify the new release's checksum
and image digest in a separate staging directory, and follow the existing
[upgrade/recovery procedure](SETUP.md#9-data-backup-and-upgrades).
Database migrations can make an old image incompatible with changed data:
rollback means restoring the verified pre-upgrade backup into an isolated
environment, not just changing an image tag. This installer performs none of
those operations. [BACKUP.md](BACKUP.md) describes the checkout's backup tools;
their availability in a published archive depends on that actual release.

## Focused verification

```sh
bun --no-env-file test scripts/install-server.test.mjs
bun --no-env-file x --no-install eslint scripts/install-server*.mjs scripts/setup-env.mjs --max-warnings=0
```

Tests use real child processes with a deterministic Docker executable fixture
and a loopback HTTP server. They exercise no live registry credentials, registry
writes, Docker resources, or production services. Parent integration remains
responsible for native Docker/browser and full application validation.
