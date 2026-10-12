# Aro: Installation & Configuration

This guide describes Aro 2.4.0. Release commands require a verified release and
tag; they do not establish that 2.4.0 is published.

This guide covers a self-hosted Aro instance for one owner. The deployment
has two Docker Compose services (the Next.js app and a Postgres database) and
two active named data volumes. You **don't need** Bun or Node on the host:
the operator scripts run inside the selected application image.

Architecture overview: [ARCHITECTURE.md](ARCHITECTURE.md). Maintainer release
process and publication status: [RELEASING.md](RELEASING.md).

## 1. What you deploy

`compose.yml` defines:

| Service | Image | Notes |
| --- | --- | --- |
| `app` | `ARO_IMAGE` (default `ghcr.io/madrobotnet/aro:2.4.0`) | Image-only Compose service, running the Bun standalone Next.js server as `nextjs` (UID/GID 1001). Publishes `127.0.0.1:${APP_PORT:-3000}:3000`, loopback only. Docker healthcheck uses `/api/health`. |
| `db` | `pgvector/pgvector:0.8.6-pg18` | Internal only (no host port). Healthcheck `pg_isready -U postgres -d "$POSTGRES_DB"`; the app waits for it. On a **fresh** data volume the Postgres entrypoint runs `docker/postgres/production/01-app-role.sql`. It precreates the `pgcrypto`, `vector`, and `pg_trgm` extensions and the restricted application role (section 4). |

Compose prefixes named volumes with the project name, which defaults to the
directory name unless configured explicitly. Generated `.env` sets
`COMPOSE_PROJECT_NAME=aro`, so a fresh install uses `aro_app-data`. Keep the
original project name and physical volumes when upgrading:

| Volume | Mounted at | Contents |
| --- | --- | --- |
| `app-data` | `/app/.data` (app container) | Attachments (`.data/attachments`) and the account-login CLI credential stores (`auth/codex`, `auth/google`), owned by UID 1001, `auth` mode 0700 |
| `postgres-data` | `/var/lib/postgresql` (db container) | All application data: notes, inbox, chat threads, attachment metadata, sessions, and saved AI settings |

Compose selects the database volume through `POSTGRES_DATA_VOLUME`; only that
volume is mounted. These are project-scoped logical keys, not fixed
global volume names. Section 10 explains how to keep an existing physical volume.

The release archive pins `app.image` to
`ghcr.io/madrobotnet/aro:2.4.0@sha256:...`, recorded in `release.json`.
Its other parsed Compose fields match source. Keep the relative
`docker/postgres/production` directory beside Compose; downloading only
`compose.yml` omits the required database initialization script.

## 2. Prerequisites

- Docker Engine + Docker Compose **5.1.0 or newer**. CI pins Compose 5.5.1;
  this guide was verified with Docker 29 / Compose 5.5.1 on Linux arm64.
- Image targets are **linux/amd64** and **linux/arm64**. Check the selected
  release's workflow receipts for native image, private-pull, API, persistence,
  and cleanup verification on both platforms (see [RELEASING.md](RELEASING.md)).
- The POSIX shell commands were verified on Linux. macOS and Windows are
  untested. For access beyond `127.0.0.1`, you need a TLS-terminating reverse
  proxy that you control (section 6).
- The archive path uses `tar`, `sha256sum`, and `jq`; the examples use
  `gh release download` for public release assets. Private image pulls need
  separate registry authorization.
- No host Node or Bun: operator scripts are bundled under `/app/scripts`
  in the application image (section 3). Bun 1.4.2 is required for development;
  Node 22 is only for upstream CLI subprocess fixtures.

Check `docker compose version` before installing or upgrading. Older Compose
clients, including 2.38.2, eagerly evaluate required variables inside unused
conditional defaults and can reject a valid current or legacy configuration.
Compose 5.1.0 includes the
[upstream interpolation fix](https://github.com/compose-spec/compose-go/commit/ddb94f10f3a0751c628e24afd3cc436ad8d1c55a).
Update the Compose plugin before proceeding; do not work around those errors
by regenerating existing passwords or selecting a different data volume.

## 3. Step 1: select the image and generate the operator `.env`

### Installation archive

These archive commands require a completed `v2.4.0` release with the checks
described in [RELEASING.md](RELEASING.md). Source and release assets are public;
the GHCR package remains private and image pulls require authorization. Download
all release assets into an empty directory, verify their checksums, then extract:

```sh
mkdir aro-release-2.4.0
cd aro-release-2.4.0
gh release download v2.4.0 --repo madrobotnet/aro
sha256sum --check SHA256SUMS
tar -xzf aro-2.4.0-install.tar.gz
cd aro
ARO_IMAGE=$(jq -r .image release.json)
export ARO_IMAGE
docker pull "$ARO_IMAGE"
```

Use this same digest reference for bootstrap and the app. Archived Compose
already uses it by default; remove or update any old `ARO_IMAGE` override in
`.env`. Source Compose uses the readable version tag
`ghcr.io/madrobotnet/aro:2.4.0`, which release policy treats as immutable.

Private pulls need a Docker registry credential with package read access.
GitHub CLI access to the repository doesn't itself provide that
credential. Native release jobs prove private pulls with their own job tokens;
don't export those tokens to your host. Public source and release assets do not
grant anonymous private-package access.

### Explicit source build

If GHCR access isn't available, build the public source locally. Select the
verified release tag before building; Compose has no build configuration:

```sh
git clone --branch v2.4.0 --single-branch https://github.com/madrobotnet/aro.git
cd aro
docker build --build-arg VERSION=2.4.0 \
  --build-arg REVISION="$(git rev-parse HEAD)" -t aro:local .
ARO_IMAGE=aro:local
export ARO_IMAGE
```

### Generate the installation file

From the extracted `aro/` directory or source checkout, run the selected image.
The script creates the file Compose reads (`./.env`) with fresh random secrets
and mode `0600`. The installation code is kept only in that private file:

```sh
docker run --rm --user "$(id -u):$(id -g)" -v "$PWD":/install \
  "$ARO_IMAGE" bun --no-env-file /app/scripts/setup-env.mjs /install/.env
```

Output:

```
Created /install/.env
Installation code is stored only in the private environment file.
Read SETUP_TOKEN locally in a private terminal and enter it on /setup.
```

Open the generated private
`.env` locally and copy its `SETUP_TOKEN` value into `/setup`; do not share the
file or terminal recording. The [server installer](INSTALL-SERVER.md)
also offers terminal-only `--token` retrieval. Do not generate a replacement
token merely because the existing token was not printed.

For a source build, add `ARO_IMAGE=aro:local` to the generated `.env`;
the shell export above won't survive a new session. For loopback HTTP, change
the existing `INSECURE_COOKIES=0` line to `INSECURE_COOKIES=1` in `.env`.
For HTTPS, keep `0`. Set these before starting the app, not just for one command.

Before the first Compose command for a new installation, check for inherited
development overrides as described in section 7.

The generated file contains:

| Variable | Value | Purpose |
| --- | --- | --- |
| `POSTGRES_PASSWORD` | 64 random hex chars, distinct | Application DB role password; Compose interpolates it into `DATABASE_URL`, and the db init script uses it to create the role |
| `POSTGRES_ADMIN_PASSWORD` | 64 random hex chars, distinct | Password of the db container's `postgres` superuser account; operator maintenance only, never given to the app |
| `POSTGRES_APP_DB` | `aro` | Application database name |
| `POSTGRES_APP_USER` | `aro` | Restricted application role name |
| `COMPOSE_PROJECT_NAME` | `aro` | Fresh installation project name |
| `SETUP_TOKEN` | 64 random hex chars, distinct | The "installation code" that guards the first-run wizard |
| `APP_PORT` | `3000` | Loopback port published by the app service |
| `INSECURE_COOKIES` | `0` | Session cookie `Secure` flag (see section 6) |
| `TRUSTED_PROXY_HOPS` | `1` | Reverse-proxy trust depth for client IPs (see section 6) |

The script uses an exclusive-create write: if `.env` already exists, it stops
without changing the file.

If you maintain your own env file instead, generate only the code and paste it in:

```sh
docker run --rm "$ARO_IMAGE" bun --no-env-file /app/scripts/setup-token.mjs
# prints: SETUP_TOKEN=<64 hex chars>
```

New installations require `POSTGRES_PASSWORD`, `POSTGRES_ADMIN_PASSWORD`,
`POSTGRES_APP_DB`, `POSTGRES_APP_USER` and `SETUP_TOKEN`. Existing 1.x credential names are supported without changing the
stored passwords, but require an explicit data-volume choice (section 10).
Do not run `setup-env` over an existing installation or generate replacement
database passwords during an upgrade.

**Windows note (untested):** after extracting the archive, the metadata and
bootstrap commands translate to PowerShell as follows:

```powershell
$env:ARO_IMAGE = (Get-Content ./release.json -Raw | ConvertFrom-Json).image
docker pull $env:ARO_IMAGE
docker run --rm -v "${PWD}:/install" $env:ARO_IMAGE bun --no-env-file /app/scripts/setup-env.mjs /install/.env
```

The POSIX `--user "$(id -u):$(id -g)"` mapping has no direct PowerShell
equivalent and is omitted. Check Docker Desktop's file sharing and the resulting
file permissions. These commands haven't been executed on Windows; they are a
translation, not a tested installation path.

## 4. Step 2: start the selected image

For the pulled release image:

```sh
docker compose up -d --wait --wait-timeout 180
```

For the source-built `aro:local` image, generate `.env` in section 3 and add
`ARO_IMAGE=aro:local` before running:

```sh
docker compose pull db
docker compose up -d --no-build --pull never --wait --wait-timeout 180
```

Compose only selects an image; it doesn't build one. Keep
`INSECURE_COOKIES=1` in `.env` for loopback HTTP, or `0` for HTTPS (section 6).
The db service becomes healthy first, then the app starts. Verify:

```sh
curl -i http://127.0.0.1:3000/api/health     # expect 200 {"ok":true}
```

On the **first** start with an empty `postgres-data` volume, the db entrypoint runs
`docker/postgres/production/01-app-role.sql` before accepting connections: it
precreates the `pgcrypto`, `vector`, and `pg_trgm` extensions and creates the
application role named by `POSTGRES_APP_USER` (`aro` on new installs),
login authorized with `POSTGRES_APP_PASSWORD` or the generated `POSTGRES_PASSWORD`,
`NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`, allowed to use and create in
the `public` schema but nothing beyond. Entrypoint init scripts run only when the
data volume is empty; they never re-run on an existing volume.

Keep the generated `POSTGRES_PASSWORD` (64 hex chars) if you edit `.env` by hand.
An explicit `DATABASE_URL` takes precedence; use a percent-encoded URL for
passwords with URL-special characters. Without one, Compose constructs the URL
from `POSTGRES_APP_PASSWORD` when present, otherwise `POSTGRES_PASSWORD`.

Credential boundary: the application connection uses the `POSTGRES_APP_USER`
role (`aro` on new installs). An operator-supplied `DATABASE_URL` must also use an application role, not
the database administrator. The `postgres`
superuser account and `POSTGRES_ADMIN_PASSWORD` exist for operator maintenance
inside the db container (for example an interactive `psql` session). Never put
`POSTGRES_ADMIN_PASSWORD` into `DATABASE_URL`, the app environment, or any
application configuration.

## 5. Step 3: first-run wizard at `/setup`

Open `http://127.0.0.1:<APP_PORT>/setup`. The wizard asks for:

1. **Installation code**: the `SETUP_TOKEN` value from the operator `.env`.
   It is compared server-side (constant-time digest compare) and is never sent
   back by the server or stored in the browser. Do not put it in links or URLs.
2. **Login password**: 12-512 characters, entered twice. This becomes the
   application password used on every device.
3. **AI connections (optional)**: both chat AI and Jev default to *off*; you can
   configure or change them later in Settings (section 8).

Server behavior worth knowing:

- The wizard is public only while the installation is genuinely empty. It is
  disabled, and `/setup` redirects to `/login`, if `AUTH_PASSWORD_HASH` is set
  in the environment, or if any users, installation settings, notes, inbox items,
  chat threads, or attachments already exist.
- The first owner account and the AI settings are written in a single database
  transaction guarded by an advisory lock, and the empty-state check is repeated
  inside that transaction: two simultaneous submissions cannot both claim the
  server, and a server that gained data in the meantime is rejected with HTTP 409.
- A wrong installation code is rejected with HTTP 403 and writes nothing.
- After success you land on `/login`. Logins from one client IP lock out for the
  remainder of a 15-minute window after 5 failed attempts (HTTP 429 with a
  `retry-after`).

## 6. Cookies, HTTP vs HTTPS, and reverse-proxy trust

The session cookie (`aro_session`) and provider-login browser cookie (`sb_ai_auth`)
are `HttpOnly` and `SameSite=Lax`. Their `Secure`
flag is enabled in production builds unless `INSECURE_COOKIES=1`:

- **Local loopback HTTP test:** set `INSECURE_COOKIES=1` in the operator `.env`,
  then `docker compose up -d` to recreate the app container. Use this only for a
  loopback HTTP check: the cookie is sent over plain HTTP and the app is bound to
  `127.0.0.1`, so it is not reachable from other machines.
- **Public HTTPS:** leave `INSECURE_COOKIES=0` (the default). Put a TLS-terminating
  reverse proxy in front of the loopback-bound app on the same host. The proxy must
  forward the `Host` header unchanged: mutating API requests are checked against
  the request `Origin`, and a rewritten `Host` makes that check fail.

`TRUSTED_PROXY_HOPS` (default `1`) controls which entry of the inbound
`X-Forwarded-For` chain is treated as the real client IP. Blank entries are removed
before selection: with hops = 1 the *last* remaining entry is used, with hops = 2
the second-to-last, and so on. If the chain is shorter than the configured hops,
the first entry is used; only an empty chain falls back to `X-Real-IP`. If the
selected value is not an IP address, no client IP is returned; the app does not
try another entry or header. The deployment must restrict app ingress to the
proxies it configures here.

**Cloudflare topology warning:** with Cloudflare in front of your own reverse
proxy, the chain reaching the app is typically `visitor, cloudflare-edge` (your
proxy appends the Cloudflare edge address). The default `TRUSTED_PROXY_HOPS=1`
then yields the edge address rather than the real visitor IP, so login rate limiting
buckets all visitors together. Set `TRUSTED_PROXY_HOPS` to the number of proxies
that append to `X-Forwarded-For` between the visitor and the app (typically `2`
for Cloudflare + your proxy), and make sure your proxy appends (e.g. nginx
`proxy_add_x_forwarded_for`) rather than overwrites the header.

## 7. Environment files: what goes where

There are two environment files. In `--env` mode, the hash tool prints a
double-quoted Argon2 assignment with each `$` escaped as `\$`.
Copy it into either dotenv file exactly as printed:

| File | Created by | Used by | Dollar escaping |
| --- | --- | --- | --- |
| `.env` (installation directory) | image's `/app/scripts/setup-env.mjs` | Docker Compose (variable interpolation + app environment) | Keep the output's double quotes and `\$` escapes; no dollar doubling |
| `.env.local` | you: `cp .env.example .env.local` | local development (`bun run dev`, loaded by Next) | Keep the output's double quotes and `\$` escapes; no added escapes or dollar doubling |

`.env.example` is the template for the **local development** `.env.local`; it is
not the Docker deployment file. The Docker `setup-env` flow creates a different
`.env` and never overwrites it.

**Exported shell variables override the operator file.** Compose uses exported
values before `.env` or an explicitly selected `--env-file`. Selecting a file
doesn't isolate its configuration from the invoking shell. In particular, an
inherited development `DATABASE_URL` pointing to `127.0.0.1:55432` makes the app
connect to its own container's loopback instead of `db:5432`, which can cause
health HTTP 503 and `ECONNREFUSED`. An inherited `AUTH_PASSWORD_HASH` overrides
the owner password and disables first-run setup.

For a **new installation**, use a shell without development exports. If these
two variables are inherited development overrides rather than intentional
installation settings, clear only those exports before running Compose:

```sh
unset DATABASE_URL AUTH_PASSWORD_HASH
```

This changes only the invoking shell; it doesn't delete or edit `.env`.
Keep the selected `ARO_IMAGE` and the generated database credentials.
For an existing or legacy installation, preserve its intentional
`DATABASE_URL`, `AUTH_PASSWORD_HASH`, original database passwords, and volume
selection. Don't clear credentials or regenerate the operator file to solve
a shell-precedence problem.

Password hashes for `AUTH_PASSWORD_HASH` (recovery and pre-wizard deployments,
see sections 10 and 11):

| Target | Command | Put into file |
| --- | --- | --- |
| Local dev `.env.local` | `bun run hash-password` | Double-quoted `AUTH_PASSWORD_HASH="..."` line, including its `\$` escapes |
| Compose `.env` | `docker compose exec app bun --no-env-file /app/scripts/hash-password.mjs --env` | Double-quoted `AUTH_PASSWORD_HASH="..."` line, including its `\$` escapes |

Keep the surrounding double quotes and the generated `\$` escapes. Next and
Bun expand unescaped dollars even in single quotes; Compose also reads this
double-quoted escaped form correctly. Don't remove or add escapes or turn
the dollar signs into `$$`. `docker compose config` may render the same literal
dollars as `$$` so Compose can read its YAML output again. That rendering isn't
an instruction to change your copied dotenv value.
The hash script's prompt shows the entered password; use a private terminal.

Without `--env`, the script prints the raw PHC hash alone. For a file passed to
`docker run --env-file` outside Compose, use that raw value without dotenv
quotes or escapes. Docker reads the value literally.

To change any variable in `.env`, edit the file and run `docker compose up -d`.
Environment changes reach the app only when the container is recreated.
Settings changed in the app UI take effect immediately without a restart.
Compose explicitly forwards the supported app variables below; it doesn't load
the entire operator `.env` into the app, so the database admin password stays
DB-only. Custom attachment or credential directories must remain under the
mounted `/app/.data` directory, or use an additional persistent volume.

Local development and legacy upgrade env reference:
`DATABASE_URL` with a password containing special characters can be produced with
`bun run database-url` during development. On an installation, use the selected
image and let Bun read the operator file:

```sh
docker run --rm -v "$PWD/.env":/install/.env:ro "$ARO_IMAGE" \
  bun --env-file=/install/.env -e \
  'process.env.POSTGRES_APP_PASSWORD ??= process.env.POSTGRES_PASSWORD; await import("/app/scripts/build-database-url.mjs");'
```

Both commands require `POSTGRES_APP_USER`, `POSTGRES_APP_DB` and
`POSTGRES_APP_PASSWORD`, percent-encode the credentials and database name, and
print the URL. Host and port default to `db` and `5432`; optional host/port/database
arguments override those targets. The image command supplies the generated
`POSTGRES_PASSWORD` to the helper only when `POSTGRES_APP_PASSWORD` is absent;
it doesn't change `.env` or Compose's credential mode. The output contains a
password; keep it out of shared logs. `bun run seed` adds demo notes to the dev database.

### Runtime environment reference

| Variable | Read by | Default | Meaning |
| --- | --- | --- | --- |
| `DATABASE_URL` | app (db layer) | Constructed from the app password | Explicit percent-encoded Postgres URL takes precedence over the constructed URL |
| `SETUP_TOKEN` | first-run wizard | Required by `compose.yml` | Guards `/setup`; 32-256 chars accepted, generated value is 64 hex chars |
| `AUTH_PASSWORD_HASH` | login + setup state | empty | Argon2id PHC hash; when set it wins over any wizard-created owner password and permanently disables the wizard |
| `INSECURE_COOKIES` | login and provider Auth | `0` | `1` disables the cookie `Secure` flag (loopback HTTP only) |
| `TRUSTED_PROXY_HOPS` | client-IP resolution | `1` | Trusted `X-Forwarded-For` depth (section 6) |
| `SESSION_TTL_DAYS` | sessions | `30` | Session lifetime in days |
| `ATTACHMENTS_DIR` | attachment storage | `.data/attachments` (relative to the app's working directory) | Attachment file location; in Docker this is inside the `app-data` volume |
| `APP_PORT` | `compose.yml` | `3000` | Loopback host port |
| `ARO_IMAGE` | `compose.yml` only | `ghcr.io/madrobotnet/aro:2.4.0` in source; verified digest in archive | Explicit app image selection; set `aro:local` for source builds; not forwarded to the app |
| `POSTGRES_APP_DB` | Compose / URL helper | Required | App database name; generated fresh value `aro`; preserve existing value on upgrade |
| `POSTGRES_APP_USER` | Compose / URL helper | Required | App role name; generated fresh value `aro`; preserve existing value on upgrade |
| `COMPOSE_PROJECT_NAME` | Compose | Generated value `aro` | Project name; preserve the original value on upgrade |
| `POSTGRES_PASSWORD` | `compose.yml` | Required | Current installs: application role password. Legacy installs with `POSTGRES_APP_PASSWORD`: original administrator password |
| `POSTGRES_ADMIN_PASSWORD` | `compose.yml` db service | Required for current installs | Explicit administrator password; legacy installs fall back to their original `POSTGRES_PASSWORD` |
| `POSTGRES_APP_PASSWORD` | `compose.yml` db service | `POSTGRES_PASSWORD` | Legacy application password; requires an explicit volume choice and is never forwarded as a separate app environment variable |
| `POSTGRES_DATA_VOLUME` | `compose.yml` db volume mount | `postgres-data` | Existing volume key: `postgres-data` for 2.1+, `second_brain_pg18` for 1.x; keep the original Compose project name |
| `TYPESAFE_API_KEY` | Jev (legacy fallback) | empty | Jev API key used while no settings exist, or while Jev explicitly keeps the environment-managed selection |
| `TYPESAFE_JEV_MODEL` | Jev (legacy fallback) | `jev-latest` | Jev model for the env-key fallback |
| `TYPESAFE_BASE_URL` | Jev (legacy fallback) | `https://api.typesafe.ai` | Legacy SDK endpoint; the UI can retain keys only for `https://api.typesafe.ai` or `https://openrouter.ai/api` |
| `CODEX_HOME` | Codex ChatGPT auth | `~/.codex` locally; `/app/.data/auth/codex` in Docker | Directory holding Codex `auth.json` |
| `CODEX_MODEL` | chat (env fallback / default) | `gpt-6.1-sol` | Chat model when using the Codex ChatGPT login |
| `CODEX_CHATGPT_BASE_URL` | Codex ChatGPT transport | `https://chatgpt.com/backend-api/codex` | Operator-controlled Codex backend endpoint |
| `GEMINI_CLI_HOME` | Gemini CLI auth | unset locally (Google CLI login unavailable); `/app/.data/auth/google` in Docker | Directory the Gemini CLI keeps its OAuth credentials in; must be an absolute path |
| `EMBEDDING_BASE_URL` | Optional learned search | empty (disabled) | Private local embedding endpoint, forwarded by Compose; separate from chat/Jev consent |

## 8. AI configuration (optional, per provider)

Learned passage search is a separate optional service, not a chat or Jev
connection. See [SEMANTIC-SEARCH.md](SEMANTIC-SEARCH.md) for pinned materials,
private networking, resource bounds and indexing/recovery. The app image contains
neither its runtime nor model weights; an unset endpoint keeps search model-free.

Everything below is optional. Capture, notes, editing, search, and the graph
work without an AI connection. Use the setup wizard or **Settings → AI** in the
app to configure AI; both write the same stored configuration.
Give each connection a name. Settings can store multiple connections and select
one for chat and another for Jev. Adding a connection does not activate it.
Switching usage off preserves the saved connections; deleting one removes its
stored credentials and disables it if it was active.

### Chat AI

| Provider | API-key mode | Account-login mode | Recommended new model |
| --- | --- | --- | --- |
| ChatGPT / OpenAI | yes | in-app ChatGPT device authorization | `gpt-6.1-sol` |
| Claude (Anthropic) | yes | **no**, API key only | `claude-sonnet-5-5` |
| Gemini | yes | in-app Google browser authorization code | API: `gemini-3.8-flash`; Auth: `gemini-3.5-flash` |
| GitHub Copilot | Copilot API token | GitHub device authorization | `gpt-6-luna` |
| OpenRouter | yes | browser PKCE authorization | `openai/gpt-6.1-sol` |
| xAI / Grok | yes | xAI device authorization | `grok-4.7` |
| OpenAI Compatible | custom key or explicitly keyless | no | enter the endpoint's model ID |
| Anthropic Compatible | custom key or explicitly keyless | no | enter the endpoint's model ID |

Auth mode uses a provider-specific model dropdown, ordered newest first.
API mode keeps an editable model ID with recommendations. Existing saved model
IDs remain unchanged, including IDs outside the current recommendations.
The catalog was checked against official sources on 2026-09-29; account, plan
and administrator policies still control availability.

ChatGPT device authorization follows the official Codex flow. Gemini browser
authorization follows the official Gemini CLI's manual PKCE flow; it is not
Google Device Flow, which does not support the required `cloud-platform` scope.
The app image retains the official CLIs (`@openai/codex@0.158.0`,
`@google/gemini-cli@0.61.0`). Gemini chat still executes through its CLI.
The app exchanges the Google authorization code using the Gemini CLI's public
OAuth client; this is not a Google-endorsed integration. Review the
[Gemini CLI terms and privacy notice](https://github.com/google-gemini/gemini-cli/blob/main/docs/resources/tos-privacy.md),
including its restriction on third-party direct access to the services powering
the CLI, before choosing account login.

Existing server-wide CLI logins remain compatible. For those legacy connections,
operators can still run these commands from the host shell:

```sh
docker compose exec app codex login --device-auth
docker compose exec -e NO_BROWSER=true app gemini
```

The CLIs keep their credential files in the persistent `app-data` volume
(`CODEX_HOME=/app/.data/auth/codex`, `GEMINI_CLI_HOME=/app/.data/auth/google`),
owned by UID 1001, so they survive upgrades and container recreation.

For a legacy CLI connection, the app's connection status shows "ready" when the CLI
exists and a readable, non-empty official credential file is present. That file
readiness does **not** prove the account is valid, entitled, or authorized for a
model. Validity and model permissions are only proven by the first real request,
and they remain under the provider's control (account state, plan, billing).

### Browser account login

For ChatGPT, Gemini, Copilot, OpenRouter or xAI, select Auth and start the
connection in the form. During first-run setup, enter the installation code
before starting the connection. Open the provider's login
page; enter the displayed device code when requested. Return to the original
Aro tab and save once it reports the authorization is ready.

- ChatGPT displays a one-time code and a link to OpenAI's device verification
  page. Enter that code on the OpenAI page, not in Aro. Device code
  login must be enabled in ChatGPT security settings or workspace permissions.
- Gemini opens Google sign-in. Copy the authorization code Google gives you
  back into the original Aro form and submit it there. No server
  terminal is needed. The Auth default `gemini-3.5-flash` follows Gemini CLI's
  base tier and can map to 3.8 Flash when the account has access; selecting a
  newer model does not grant that access.

- Copilot requires a usable Copilot entitlement. API mode expects a Copilot API
  token, not an arbitrary GitHub personal access token. An optional Enterprise
  domain and Responses, Chat Completions or Messages protocol can be selected.
- OpenRouter authorization issues a durable API key through PKCE. It does not
  transfer a ChatGPT, Claude or other subscription into OpenRouter.
- xAI account authorization uses the provider's device flow and refresh tokens.
  Account entitlement and model access are determined by xAI.
- Login attempts are scoped to the authenticated owner or installer and bound
  to the browser that started them. A ready attempt is consumed once in the same
  transaction that saves the connection; a failed save rolls consumption back.
  Attempts expire after at most 15 minutes. Expired records are removed when a
  new login starts; polling an expired attempt clears its private payload.
- Stored account credentials are refreshed on the server. Google credentials
  are refreshed by the official Gemini CLI during chat; other supported account
  credentials refresh through their provider adapters when needed.
  Revoked access or unsuccessful refresh requires reconnecting in settings.
  The app does not automatically enable Copilot model policies.

### Custom compatible endpoints

Choose **OpenAI Compatible** or **Anthropic Compatible**, then enter a name,
HTTP(S) base URL, model ID and API key, or explicitly choose a keyless endpoint.
Examples:

| Input | Request destination |
| --- | --- |
| `https://gateway.example` with Chat Completions | `https://gateway.example/v1/chat/completions` |
| `https://gateway.example/custom/v1` with Responses | `https://gateway.example/custom/v1/responses` |
| `https://gateway.example/v1/messages` with Messages | the same URL, not a duplicated suffix |

OpenAI Compatible supports Chat Completions or Responses. Anthropic Compatible
uses Messages. Optional extra headers support gateway-specific authentication;
header names are case-insensitive and transport headers such as `Host`, `Cookie`
and `Content-Length` cannot be overridden. A supplied authorization header
overrides the default key header. Output-token limits are optional.

URLs cannot contain embedded credentials, query strings or fragments. Put
gateway credentials in the API-key field or extra headers. Redirects are not
followed with credentials. Changing provider or normalized endpoint never
reuses the previous endpoint's key or extra headers; enter a new key or explicitly
choose keyless, and re-enter any headers needed by the new destination.

In Docker, `localhost` refers to the app container. Use a reachable Compose
service name, a LAN address, or `host.docker.internal` when the Docker host
provides it. On Linux Engine, that hostname may require an operator-added
`extra_hosts: ["host.docker.internal:host-gateway"]` mapping in the app service.
The upstream server must listen on an interface reachable from the container.

### Jev (inbox triage suggestions)

Jev is an independent, optional connection. It only powers capture classification,
tag suggestions, and duplicate candidates on inbox items; it neither requires nor
affects chat AI. Two providers are supported, reached via the TypeSafe SystemOne
endpoint:

| Provider | Endpoint | Default model | Alternative model ID |
| --- | --- | --- | --- |
| TypeSafe (official) | `https://api.typesafe.ai/v1/systemone` | `jev-latest` | `jev-1.13.0` |
| OpenRouter | `https://openrouter.ai/api/v1/systemone` | `~typesafe/jev-latest` | router-managed; no pinned alternative recommended |

Use a model that returns structured judgment and the model IDs above. OpenRouter's
separate "Jev Router" product isn't the service this app calls.
TypeSafe uses an API key. OpenRouter accepts either an API key or the browser
account connection described above. Jev profiles, models and usage can be changed
without changing the active chat connection.

### Storage, consent, and change semantics

- Connection profiles, API keys, extra header values and browser Auth credentials
  are stored in Postgres (`ai_connections`). `installation_settings.ai` contains
  only the per-purpose selection IDs.
  This is private server-side storage, **not** end-to-end encrypted. Protect the
  database backups accordingly (section 9).
- Keys and the setup token are never returned to the browser: the settings API
  exposes only redacted metadata such as credential-presence flags and header
  names. Saved keys and headers are retained only for the same profile, provider,
  API mode and normalized endpoint. Header values cannot be read back; omitting
  unchanged headers retains them, while an empty header object clears them.
- Each provider connection requires an explicit data-transfer consent checkbox;
  enabling either AI sends your question plus related note excerpts (chat) or
  capture content plus recent note titles (Jev) to that provider.
- Saved settings take effect immediately, without an app restart.
- Chat and Jev independently choose a saved profile, explicit off, or the legacy
  environment configuration. Off wins over ambient credentials. Adding an
  inactive profile does not change either selection or disable legacy behavior.

## 9. Data, backup, and upgrades

Aro provides [manifest-checked backup and disposable restore
verification commands](BACKUP.md), requiring host Node.js 22+.
The manual procedure below remains available.

Permanent note deletion records attachment cleanup in the same database
transaction. Physical files are removed only after that transaction commits.
If storage is temporarily unavailable, the note remains deleted successfully
and the file keys stay in a private retry queue instead of becoming unreachable.
The app retries queued work on server startup and after subsequent permanent
deletions. Restore the storage directory's access permissions and restart the
app to retry immediately; deferred-cleanup logs contain counts/error codes,
never attachment names or paths. Moving a note to trash does not remove files.

**Back up before every upgrade.** The two named volumes (section 1) hold
everything: `postgres-data` (database) and `app-data` (attachment files + CLI
credentials).

```sh
# Run from the existing installation directory. The backup stays outside it.
(
  set -eu
  umask 077
  mkdir -p "$HOME/aro-backups"
  BACKUP_DIR=$(mktemp -d "$HOME/aro-backups/backup.XXXXXX")
  cp .env "$BACKUP_DIR/operator.env"
  chmod 600 "$BACKUP_DIR/operator.env"
  APP_DATA_VOLUME=$(docker inspect --format \
    '{{range .Mounts}}{{if eq .Destination "/app/.data"}}{{.Name}}{{end}}{{end}}' \
    "$(docker compose ps -aq app)")
  trap 'docker compose start app' EXIT
  docker compose stop app
  docker compose exec -T db sh -ec \
    'exec pg_dump --clean --if-exists -U postgres "$POSTGRES_DB"' > "$BACKUP_DIR/database.sql"
  docker run --rm -v "$APP_DATA_VOLUME:/data:ro" -v "$BACKUP_DIR:/backup" \
    alpine:3.23 sh -ec \
    'umask 077; tar czf /backup/app-data.tar.gz -C /data .; chown "$1:$2" /backup/app-data.tar.gz' \
    sh "$(id -u)" "$(id -g)"
  printf 'Backup directory: %s\n' "$BACKUP_DIR"
)
```

All three files are private (0600), and the app is stopped while the database and
attachment/auth files are copied together. The app is restarted even if the
backup command fails. `operator.env` preserves the installation secrets;
`app-data.tar.gz` includes CLI credentials. Protect both like passwords.
Also retain the installed `release.json`/Compose files, image reference, and
project name so you can reproduce the deployment. Record any operator-added
mounts separately; the commands above back up the stock `/app/.data` mount.
Settings > Export produces a Markdown zip of active and archived notes plus
attachments. It isn't a backup: settings, sessions, chat and trash aren't included.

Restore into a **separate, empty installation**, not a running server with data
you want to keep. Prepare its pulled image or explicit source build and generate
its `.env` as in section 3, without starting the app. Set a different
`APP_PORT`/Compose project name if the original is still running, and set
`BACKUP_DIR` to the printed backup directory. Before starting the database, set
`POSTGRES_APP_DB` and `POSTGRES_APP_USER` to the database and role names recorded
in the backup. Keep the appropriate cookie mode
in its `.env`. The SQL contains cleanup statements and replaces matching
objects. Pull the database image and start only the database until restoration
is complete:

```sh
docker compose pull db
docker compose up -d --no-build --pull never --wait --wait-timeout 180 db
docker compose exec -T db sh -ec \
  'exec psql -v ON_ERROR_STOP=1 --single-transaction -U postgres "$POSTGRES_DB"' < "$BACKUP_DIR/database.sql"
docker compose create --no-build --pull never app
APP_DATA_VOLUME=$(docker inspect --format \
  '{{range .Mounts}}{{if eq .Destination "/app/.data"}}{{.Name}}{{end}}{{end}}' \
  "$(docker compose ps -aq app)")
docker run --rm -v "$APP_DATA_VOLUME:/data" -v "$BACKUP_DIR:/backup:ro" \
  alpine:3.23 tar xzf /backup/app-data.tar.gz -C /data
docker compose up -d --no-build --pull never --wait --wait-timeout 180
```

Restore as the database administrator, because extension metadata belongs to
`postgres`. Restore with the database and role names recorded in the backup,
not new names. The dump restores the original application-table ownership;
the archive preserves UID/GID 1001. Verify a note and attachment before using the
new installation. The dump also contains sessions; use Settings to revoke them
if they should not remain valid after recovery.

**Upgrading without losing data:**

For installations already using the 2.1+ `postgres-data`/`app-data` volumes,
keep the same installation directory, project name, environment file, and
physical volumes. If you used `-p`, `COMPOSE_PROJECT_NAME`, or
`--project-directory`, use those same values on every upgrade command. For an
archive install, verify the next archive's checksums in a separate download
directory. Copy its distribution files into the existing installation directory,
including the SQL directory and `release.json`, without replacing `.env`.
Don't start a new nested `aro/` directory as a different Compose project.

Before replacing Compose or starting it, follow the
[pre-2.4.0 compatibility requirements](UPDATE.md#upgrading-an-install-created-before-240).
Record `POSTGRES_APP_DB` and `POSTGRES_APP_USER` in the existing `.env`;
keep its original project name and volume selection.
Then, from the existing installation directory:

```sh
ARO_IMAGE=$(jq -r .image release.json)
export ARO_IMAGE
# Remove or update any old ARO_IMAGE override in .env to this same reference.
# Keep INSECURE_COOKIES=1 for loopback HTTP, or 0 for HTTPS.
docker pull "$ARO_IMAGE"
docker compose up -d --wait --wait-timeout 180
```

For a source installation, update the existing checkout to the intended version
without replacing `.env` or changing its project. Use that checkout's package
version for `VERSION`; this release is 2.4.0:

```sh
docker build --build-arg VERSION=2.4.0 \
  --build-arg REVISION="$(git rev-parse HEAD)" -t aro:local .
ARO_IMAGE=aro:local
export ARO_IMAGE
# Keep ARO_IMAGE=aro:local and the correct cookie mode in .env.
docker compose pull db
docker compose up -d --no-build --pull never --wait --wait-timeout 180
```

`docker compose up -d` recreates changed containers and **keeps named volumes**.
So does `docker compose down`. **Never** run `docker compose down -v` (or
`--volumes`) on a server whose data you want to keep: that deletes both data
volumes. Schema migrations run automatically on the first database use after an
upgrade and are recorded in `schema_migrations`; if you keep production data,
verify the upgrade on a restored copy first.

## 10. Existing deployments

For installs created before 2.4.0, follow the
[upgrade compatibility section](UPDATE.md#upgrading-an-install-created-before-240)
before replacing Compose or starting the selected image.

### Upgrading from 1.x

The old `docker-compose.yml` used an earlier volume key and a
different password naming scheme. Previously, switching to `compose.yml` alone
could select a new empty `postgres-data` volume. The old volume wasn't erased, but
the application could appear empty. The compatibility path now requires an
explicit choice when `POSTGRES_APP_PASSWORD` is present and fails before
creating resources if that choice is missing.

1. **Before pulling the new version**, back up the database and attachment
   directory. Record the existing Compose project name and DB mount:
   `docker inspect --format '{{json .Mounts}}' "$(docker compose ps -q db)"`.
   Preserve the recorded physical volume and the
   project name, including any `-p` argument or `COMPOSE_PROJECT_NAME` value.
2. Keep the original `DATABASE_URL`, `POSTGRES_APP_PASSWORD`, `POSTGRES_PASSWORD`
   and `AUTH_PASSWORD_HASH`. `DATABASE_URL` is used verbatim, including its
   percent-encoded password. Do not swap or regenerate these secrets.
3. Add `POSTGRES_DATA_VOLUME=second_brain_pg18` to that same `.env`. If this is
   actually a 2.1+ installation that also defines the legacy app-password name,
   explicitly choose `postgres-data` instead. Confirm the chosen physical
   volume already exists with `docker volume inspect <recorded-volume-name>`.
4. Select and pull the target release image, or build `aro:local` as in section 3.
   If `SETUP_TOKEN` is absent, run
   `docker run --rm "$ARO_IMAGE" bun --no-env-file /app/scripts/setup-token.mjs`
   and copy the printed line into the existing `.env`. It remains unused when the
   existing login hash or owner is present.
   A new `POSTGRES_ADMIN_PASSWORD` is not required for a legacy installation:
   the original `POSTGRES_PASSWORD` remains the administrator password.
5. Stop the old app before starting the new one; do not run both versions
   against the same database. Preserve any custom attachment/auth mounts.
   The old stock Compose did not persist attachments: copy that directory
   out of the old app container **before** removing or recreating it.
   Restore it under the new `app-data` volume with UID/GID 1001, following
   section 9. Do not assume preserving the DB also preserves those files.
6. Start the selected image using the section 9 release or source procedure,
   with the same project name and the existing volume.
   Verify login, an existing note and an existing attachment before removing
   the backup. Never run `down -v` as part of the upgrade.

Compose keeps current installs on `postgres-data` by default; changing that
default to the earlier volume key would detach already-created 2.1+ databases.
Entrypoint password settings do not change passwords in an initialized volume.
The compatibility path preserves both names and role semantics; it does not
reset credentials or copy data into a different cluster.

This path is for the PostgreSQL 18 layout. Older PostgreSQL 16 installations
need a logical dump/restore, not mounting a PostgreSQL 16 data directory in 18.
Verification covered current and synthetic legacy PostgreSQL 18 configurations,
including persistence across recreation. It didn't execute an upgrade from a
historical 1.x binary, an old attachment migration, or a PostgreSQL major-version
migration.

### Existing authentication and AI settings

Deployments that predate the first-run wizard retain these application rules:

- If `AUTH_PASSWORD_HASH` is set, the wizard is permanently disabled (`/setup`
  redirects to `/login`) and the env hash remains authoritative for login.
- If any users or protected data already exist (notes, inbox items, chat threads,
  attachments, installation settings), public account adoption is disabled the
  same way: the wizard cannot be claimed on an occupied server.
- `SETUP_TOKEN` is still required by Compose even for env-auth deployments;
  it is unused after setup is complete. Database secrets follow the current
  or legacy scheme above.
- Postgres entrypoint variables apply only when the data volume is first
  initialized. A deployment created with the earlier single-secret topology
  therefore keeps its original database role and privileges unchanged. The new
  restricted-role init never retrofits onto an existing volume, and no action is
  required. Never wipe the data volume just to adopt the new role layout; on a
  **fresh** volume, `POSTGRES_PASSWORD` creates the restricted application role
  and `POSTGRES_ADMIN_PASSWORD` protects the `postgres` account (section 4).
- While **no** settings have been saved in the UI, legacy environment credentials
  keep working: `TYPESAFE_API_KEY` (optionally `TYPESAFE_BASE_URL` and
  `TYPESAFE_JEV_MODEL`) drives Jev,
  and a ChatGPT-login Codex `auth.json` drives chat.
- After you save AI settings in the UI (Settings → AI), the stored configuration
  takes over for each purpose, including explicit opt-outs. The environment
  selection preserves that purpose's legacy behavior (section 8).
- Upgrading from 2.1 migrates existing inline chat/Jev credentials into named
  profiles without changing their models or activation state. Owner passwords
  and CLI credential files are not changed by this migration.

## 11. Recovery

**Lost installation code (before first-run).** The code lives in the operator
`.env`:

```sh
grep '^SETUP_TOKEN=' .env                  # on the host
docker compose exec app printenv SETUP_TOKEN   # from the running container
```

If the whole `.env` is lost, restore it from your private backup. For an
installation that has never started and has no database volume, rerun
the image's `/app/scripts/setup-env.mjs` command from section 3 to create all
three secrets. Once PostgreSQL has been initialized,
changing passwords in `.env` does not change the database roles' passwords.
Recover the original values before recreating containers.

**Forgotten password.** There is no public password reset by design (single-owner
application). Recovery uses the existing hash tool:

1. Run
   `docker compose exec app bun --no-env-file /app/scripts/hash-password.mjs --env`
   to generate a new hash without installing Bun on the host. Its terminal prompt
   displays the entered password. Copy the double-quoted
   `AUTH_PASSWORD_HASH="..."` line, including its `\$` escapes, exactly into
   the operator `.env` (section 7). Don't add escapes or double the dollar signs.
2. Recreate the app: `docker compose up -d`.
3. Log in with the new password. An `AUTH_PASSWORD_HASH` set in the environment
   wins over the wizard-created owner's stored password; on this login the owner
   row in the database is also rewritten to the new hash.
4. For a wizard-created owner, optionally remove `AUTH_PASSWORD_HASH` and recreate
   the app again: login falls back to the updated stored owner password.
   Pre-wizard installations must keep the environment hash.

For local development the same recovery uses `.env.local` and the double-quoted
`bun run hash-password` output; restart `bun run dev` afterwards. If the stored
owner password is unknown *and* you prefer to keep the env hash permanently, step 4
is simply skipped.

## 12. Development commands and test databases

Use Bun 1.4.2 and Docker. Node 22 is required only for upstream account-login CLI
subprocess fixtures; the application runs with Bun. The development database
is a separate `aro-dev` Compose project on `127.0.0.1:55432`.
Copy `.env.example` to `.env.local`, then copy the double-quoted output of
`bun run hash-password` for `AUTH_PASSWORD_HASH` exactly as printed.

| Command | Purpose |
| --- | --- |
| `bun run db:up` | Start the development database |
| `bun run db:down` | Delete the development database container and volume; unrelated to production |
| `bun run seed` | Add linked Korean demo notes and captures, preserving existing data |
| `bun run hash-password` | Print a double-quoted dotenv-ready `AUTH_PASSWORD_HASH="..."` line with `\$` escapes |
| `bun scripts/hash-password.mjs` | Print a raw PHC hash for Docker `--env-file` |
| `bun run setup-env` / `bun run setup-token` | Source-checkout tools: create `.env` without overwriting / print a fresh `SETUP_TOKEN`; installed-image equivalents are in section 3 |
| `bun run database-url` | Percent-encode a database password into a connection URL |
| `bun run typecheck` / `bun run lint` / `bun test` / `bun run build` | Check types, lint, test and build |

The development initializer creates a separate `aro_test` database.
Tests delete data only there, not in your development notebook.
`TEST_DATABASE_URL` may select a loopback database named `aro_test`
or `sb_test_<lane>`; connection-override query parameters are rejected.
The test helper checks initialization, the cached connection and the actual
database name before clearing data. Never point tests at production.

`bun run db:down` destroys local development data. To stop a production
Compose project while preserving its named volumes, use `docker compose down`
without `-v`.

## 13. License

Aro's application code is licensed under [MIT](../LICENSE). That doesn't
relicense dependencies, fonts, runtimes, official account-login CLIs, the
operating-system image, or provider services.
See [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md). Images retain full
collected license texts and inventories under `/app/licenses` and
`/usr/share/aro/licenses`, plus upstream runtime and operating-system notices.
A successful inventory or SBOM check doesn't replace review of redistribution
obligations.
