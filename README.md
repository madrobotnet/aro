<p align="center">
  <img src="docs/images/aro-mark.svg" width="88" alt="Aro logo: 아 in cream on terracotta">
</p>

<h1 align="center">Aro · 아로</h1>

The mark is a rounded tile with 아 from the Korean name 아로 knocked out.
App icons show the glyph in cream on terracotta.

<p align="center">
  A self-hosted notebook for linked Markdown notes, built for one owner.<br>
  <a href="README.ko.md">한국어</a> · <a href="docs/SETUP.md">Setup guide</a> · <a href="LICENSE">MIT</a>
</p>

This documentation describes Aro 2.4.1, published as the
[v2.4.1 release](https://github.com/madrobotnet/aro/releases/tag/v2.4.1).

Aro runs on your own server for one owner. Save links and quick thoughts in
the inbox, turn them into Markdown notes, and build connections between notes
over time. None of these features needs an AI account.

## What it does

- **Capture and inbox.** Save a URL or a quick note first and sort it out later.
  Turn inbox items into notes when you're ready. Use single-key shortcuts to
  triage them, snooze an item until later or merge it into an existing note.
- **Linked Markdown notes.** Link notes with `[[wiki links]]`, add tags and
  aliases, and see backlinks and unlinked mentions on every note. Type `[[`
  to get title and alias suggestions or create a missing note. Turn an
  unlinked mention into a link with one click.
- **Live Markdown editor.** Headings, emphasis, lists, task checkboxes, links,
  code fences and tables are styled as you type, and the raw syntax shows only
  on the line you are editing. A format bar covers common formatting and docks
  at the top while a phone keyboard is open. Tapping a link offers to open or edit it. A raw
  Markdown mode is one switch away and is remembered.
- **Daily notes and templates.** Open today's note or choose another day from
  a small calendar. Templates, including a default for new daily notes, fill in
  `{{date}}` and `{{title}}`.
- **Tasks.** Every `- [ ]` checkbox in your notes appears on one Tasks page.
  Tick them off there or in a note's preview.
- **Version history and trash.** Notes keep recent versions that you can
  compare and restore. Deleted notes stay in the trash for 30 days, and you
  can undo a delete right away.
- **Graphs.** Browse how your notes connect, either across the whole notebook
  or around one note.
- **Search.** PostgreSQL full-text, trigram and character n-gram matching find
  exact words and tolerate typos without a model. An optional private local
  runtime adds learned passage retrieval and supporting source locations.
  See [local learned search](docs/SEMANTIC-SEARCH.md); weights are not bundled.
- **Attachments.** Files are stored on your server next to the notes that use
  them.
- **Markdown export.** Download every note outside the trash, archived ones
  included, as one zip from Settings. Each note becomes a Markdown file with
  YAML front matter. `[[wiki links]]` stay as written, and attachments get their
  own folder. The exported files also open in tools like Obsidian.
- **Optional cited chat.** Ask questions about your notes. Answers drawn from
  matching notes list those notes as sources. When nothing matches, an answer
  may come without note citations.
- **Optional Jev.** Connected separately from chat, it suggests
  classifications, tags and possible duplicates for inbox items. Suggestions
  stay with the item, and you pick which tags to apply when you turn it into a
  note.

Aro is a web app for one owner, so it has no team features. It also has no
native apps, offline editing, sync, end-to-end encryption or
automatic backups.

The development checkout adds [Markdown/ZIP import](docs/IMPORT.md) with preview,
explicit confirmation, conflict blocking and local attachment preservation.
It also includes an experimental [local SQLite runtime](docs/DESKTOP.md) and
[desktop backup verification](docs/BACKUP-DESKTOP.md), verified on real Windows 11
x64 and Linux arm64 with Bun 1.4.2 for owner initialization, production start,
login, notes/attachments, restart persistence, duplicate-start refusal, stopped
backup verification and Ctrl+C shutdown. The same production checkout workflow
and programmatic SIGINT/SIGTERM shutdown passed on GitHub-hosted `macos-latest`
(Apple Silicon, macOS 26.6.2) and `macos-26-intel` (x64, macOS 26.6.1), not a
physical Mac. Interactive Terminal Ctrl+C, Gatekeeper/quarantine, sleep/wake and
non-default filesystems were not exercised. Windows and macOS model management,
server/Docker tooling, official chat CLI providers and desktop packaging/updates
are unsupported. Desktop/server movement is explicit note
export/import, not simultaneous synchronization or a full-account migration.
The development version also adds [owner-controlled MCP access](docs/AGENT-ACCESS.md):
OAuth connectors for Claude and ChatGPT, separate revocable bearer tokens,
inbox-only captures, and reviewed note-change proposals. Add
`https://<host>/api/mcp` in claude.ai **Settings → Connectors → Add custom
connector**, or ChatGPT **Settings → Connectors / developer mode → add MCP
server**. Set `ARO_MCP_ALLOWED_HOSTS` to the public host, choose permissions on
Aro's consent screen, and revoke access in **Settings → Agent access**.

The development checkout also includes operator-triggered, manifest-checked
[backup and disposable restore verification](docs/BACKUP.md). These management
commands additionally require Node.js 22+ on the operator host. They do not add
scheduled backups or restore into an existing installation.

## Server mode and desktop mode

| | Server mode | Desktop mode (experimental) |
| --- | --- | --- |
| Runs on | A server or always-on machine with Docker | Your own Linux, Windows or Mac computer, with Bun |
| Storage | PostgreSQL in Docker, attachments in a volume | One SQLite file and an attachments folder in a private data directory |
| Reach it from | Any device, including your phone, once you put it behind HTTPS | The same computer only (`127.0.0.1`) |
| Local search models and chat CLI providers | Supported | Linux only |
| Install | [Quick start](#quick-start) below | From a development checkout; see [Local SQLite runtime](docs/DESKTOP.md) |

Server mode is the supported way to run Aro. Desktop mode is for keeping a
notebook on one computer without Docker. The two do not sync; move notes between
them with Markdown export and import.

## Quick start

You need Docker and **Docker Compose 5.1.0 or newer**; check with
`docker compose version`. Older Compose releases have an interpolation bug
that can reject a valid configuration. You don't need Bun or Node on the host.
The supported image platforms are **linux/amd64** and **linux/arm64**. Check the
selected release's workflow receipts for native image, private-pull, and
persistence verification on both platforms; see the [release guide](docs/RELEASING.md).
These server deployment commands use a POSIX shell and are Linux-only.

### Released installation archive

The installation bundle is `aro-2.4.1-install.tar.gz`. It includes
`compose.yml`, its required `docker/postgres/production/01-app-role.sql` mount,
the documentation, notices, and `release.json`. The archived Compose file pins
the image by digest. Keep the bundle's directory structure intact.

**Image access:** the source repository, GitHub release assets and the
`ghcr.io/madrobotnet/aro` image are public, so `docker pull` needs no login.
Use the GitHub CLI to download its assets and `jq` to read the image reference:

```sh
mkdir aro-release-2.4.1
cd aro-release-2.4.1
gh release download v2.4.1 --repo madrobotnet/aro
sha256sum --check SHA256SUMS
tar -xzf aro-2.4.1-install.tar.gz
cd aro

ARO_IMAGE=$(jq -r .image release.json)
export ARO_IMAGE
docker pull "$ARO_IMAGE"
docker run --rm --user "$(id -u):$(id -g)" -v "$PWD":/install \
  "$ARO_IMAGE" bun --no-env-file /app/scripts/setup-env.mjs /install/.env

# Edit .env: set INSECURE_COOKIES=1 for loopback HTTP, or keep 0 for HTTPS.
docker compose up -d --wait --wait-timeout 180
curl -i http://127.0.0.1:3000/api/health
```

If you'd rather not use the published image, build from source instead.

### Build the 2.4.1 source

This path doesn't use GHCR. Compose has no build configuration, so build the
image explicitly from the `v2.4.1` tag:

```sh
git clone --branch v2.4.1 --single-branch https://github.com/madrobotnet/aro.git
cd aro
docker build --build-arg VERSION=2.4.1 \
  --build-arg REVISION="$(git rev-parse HEAD)" -t aro:local .
ARO_IMAGE=aro:local
export ARO_IMAGE
docker run --rm --user "$(id -u):$(id -g)" -v "$PWD":/install \
  aro:local bun --no-env-file /app/scripts/setup-env.mjs /install/.env

# Edit .env: add ARO_IMAGE=aro:local.
# Set INSECURE_COOKIES=1 for loopback HTTP, or keep 0 for HTTPS.
docker compose pull db
docker compose up -d --no-build --pull never --wait --wait-timeout 180
curl -i http://127.0.0.1:3000/api/health
```

Then open `http://127.0.0.1:3000/setup`, enter the installation code, and
choose your owner password (at least 12 characters).

Keep `INSECURE_COOKIES=1` in `.env` for loopback HTTP across container
recreation and upgrades. For HTTPS, set it to `0` before recreating the app.

What happens during setup:

1. `setup-env` runs inside the selected application image. It creates a private
   `.env` (mode 0600) with three random secrets: the app database password, the
   database admin password, and the installation code (`SETUP_TOKEN`). It
   keeps the code only in the private `.env` for local retrieval. It also sets
   `POSTGRES_APP_DB=aro`, `POSTGRES_APP_USER=aro`, and `COMPOSE_PROJECT_NAME=aro`.
   If a `.env` already exists, it stops without changing
   anything. Running `bun install` on your machine won't create this file or
   the code.
2. Compose starts the selected image after the database passes its health check.
   Source Compose defaults to `ghcr.io/madrobotnet/aro:2.4.1`; the release
   archive uses its verified digest, and a source build uses `ARO_IMAGE=aro:local`.
3. The app listens on `127.0.0.1` only. Use `INSECURE_COOKIES=1` only for
   loopback HTTP; HTTPS requires `INSECURE_COOKIES=0`.

The installation code only works for first-time setup. It isn't the one-time
code an AI provider shows you when you connect an account.

### Using a headless server

Because the app is bound to loopback, open an SSH tunnel from your own machine:

```sh
ssh -L 3000:127.0.0.1:3000 you@your-server
```

Then open `http://127.0.0.1:3000/setup` in your local browser.

### Going public

Put a TLS-terminating reverse proxy in front of the loopback port, keep
`INSECURE_COOKIES=0`, forward the `Host` header unchanged, and set
`TRUSTED_PROXY_HOPS` to match your proxy chain. See
[Cookies, HTTPS and reverse-proxy trust](docs/SETUP.md#6-cookies-http-vs-https-and-reverse-proxy-trust).

## Upgrading existing installs

Back up and verify restoration before upgrading. Never run `docker compose down -v`,
which deletes data volumes. Keep the existing project, `.env`, database and physical
volumes. See [UPDATE.md](docs/UPDATE.md) for pre-2.4.0 compatibility requirements,
verified staging and explicit activation, and
[Existing deployments](docs/SETUP.md#10-existing-deployments) for older layouts.

## Your data and the network

Notes, inbox items, chats and settings are stored in your own PostgreSQL
database. The search index lives in the same database, and attachments sit in
the `app-data` volume. Protecting the server, the volumes, `.env` and your
backups is up to you.

Aro doesn't send your notes out on its own. Data leaves the server only
through something you set up or do:

- **Chat**, after you connect a provider and tick its data-transfer consent,
  sends your question, the last 12 messages, and matching note excerpts to that
  provider.
- **Jev**, after you connect and consent, sends the capture's title, the first
  4,000 characters of its body, and recent note titles and IDs.
- **Account login and credential refresh** send requests to the provider's
  sign-in service.
- **Capturing a URL** fetches that page from the server.
- **Remote Markdown resources**, such as images, can load in your browser.
- Your reverse proxy, package installation and container builds can also
  involve outside traffic.

Both AI features are off by default. API keys and account credentials stay
on the server and are never sent back to the browser. Aro still makes the
network requests described above, so it isn't fully offline. AI consent
controls chat and Jev, not every network request.

## AI providers (optional)

Chat supports ChatGPT/OpenAI, Claude, Gemini, GitHub Copilot, OpenRouter,
xAI, and any OpenAI- or Anthropic-compatible endpoint. You can use an API key,
or sign in with an account where the provider allows it. Jev runs through
TypeSafe or OpenRouter. Models, login flows and endpoints are listed in
[AI configuration](docs/SETUP.md#8-ai-configuration-optional-per-provider).

**About Gemini account login.** Aro exchanges the Google authorization code
directly using the official Gemini CLI's public OAuth client, then runs
inference through that CLI. Google hasn't reviewed or endorsed Aro. Google's
[Gemini CLI terms and privacy notice](https://github.com/google-gemini/gemini-cli/blob/main/docs/resources/tos-privacy.md)
restricts direct third-party access to the services the CLI uses. Read it and
decide whether this mode fits your use. API-key mode is always available
instead.

## Development

You'll need Bun 1.4.2 and Docker. Node 22 is needed only for the upstream
account-login CLI subprocess fixtures, not to run the application.

```sh
bun install --frozen-lockfile
cp .env.example .env.local
bun run hash-password    # prints an AUTH_PASSWORD_HASH=... line
```

Paste that double-quoted line into `.env.local` exactly as printed. Keep its
existing `\$` escapes. Don't add escapes or double the dollar signs.
Then start the development database and the app:

```sh
bun run db:up
bun run dev    # http://localhost:3000
```

The development database is a separate `aro-dev` Compose project on
port 55432. Other commands and the safeguards around destructive test-database
operations are in
[Development commands and test databases](docs/SETUP.md#12-development-commands-and-test-databases).

## Docs

- [docs/SETUP.md](docs/SETUP.md): installation, HTTPS, upgrades, backup, recovery
- [docs/RELEASING.md](docs/RELEASING.md): native image releases and asset verification
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): structure and API contracts
- [docs/SEMANTIC-SEARCH.md](docs/SEMANTIC-SEARCH.md): optional private learned runtime, indexing and fallback

## Support the project

If Aro is useful to you, you can support its development on Ko-fi.

[![Support on Ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/madrobot)

## License

Aro's application code is [MIT](LICENSE). Dependencies, runtimes, official
account-login CLIs, fonts, and the container's operating system keep their own
licenses and service terms. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md);
the image retains notices and inventories under `/app/licenses` and
`/usr/share/aro/licenses`. The application license doesn't relicense the
whole image.
