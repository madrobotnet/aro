<p align="center">
  <img src="docs/images/irang-mark.svg" width="88" alt="Aro logo: two interlocking shapes joined at a seam">
</p>

<h1 align="center">Aro · 아로</h1>

<p align="center">
  A self-hosted notebook for linked Markdown notes, built for one owner.<br>
  <a href="README.ko.md">한국어</a> · <a href="docs/SETUP.md">Setup guide</a> · <a href="LICENSE">MIT</a>
</p>

Previously Irang (이랑). This unshipped development checkout is now Aro; the
repository has been renamed to `madrobotnet/aro`. Published 2.3.2 images and release archives keep their Irang
identifiers, as do existing configuration keys, databases, cookies and volumes.
The release installation commands below install Irang 2.3.2, not the new Aro
development checkout.

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
[desktop backup verification](docs/BACKUP-DESKTOP.md). These are not features of
the already published 2.3.2 image. Desktop/server movement is explicit note
export/import, not simultaneous synchronization or a full-account migration.
The development version also adds [owner-controlled MCP access](docs/AGENT-ACCESS.md):
separate revocable tokens, inbox-only captures, and reviewed note-change proposals.

The development checkout also includes operator-triggered, manifest-checked
[backup and disposable restore verification](docs/BACKUP.md). These management
commands additionally require Node.js 22+ on the operator host. They do not add
scheduled backups or restore into an existing installation. They are not part of
the already published 2.3.2 installation archive.

## Quick start

You need Docker and **Docker Compose 5.1.0 or newer**; check with
`docker compose version`. Older Compose releases have an interpolation bug
that can reject a valid configuration. You don't need Bun or Node on the host.
The supported image platforms are **linux/amd64** and **linux/arm64**. Check the
selected release's workflow receipts for native image, private-pull, and
persistence verification on both platforms; see the [release guide](docs/RELEASING.md).
The commands use a POSIX shell; macOS and Windows haven't been tested.

### Released installation archive

The installation bundle is `irang-2.3.2-install.tar.gz`. It includes
`compose.yml`, its required `docker/postgres/production/01-app-role.sql` mount,
the documentation, notices, and `release.json`. The archived Compose file pins
the image by digest. Keep the bundle's directory structure intact.

**Image access:** the source repository and GitHub release assets are public;
the GHCR package remains private and image pulls require package permission.
The commands below require a
completed `v2.3.2` release with the checks in the [release guide](docs/RELEASING.md).
Use the GitHub CLI to download its assets and `jq` to read the image reference:

```sh
mkdir irang-release-2.3.2
cd irang-release-2.3.2
gh release download v2.3.2 --repo madrobotnet/aro
sha256sum --check SHA256SUMS
tar -xzf irang-2.3.2-install.tar.gz
cd irang

IRANG_IMAGE=$(jq -r .image release.json)
export IRANG_IMAGE
docker pull "$IRANG_IMAGE"
docker run --rm --user "$(id -u):$(id -g)" -v "$PWD":/install \
  "$IRANG_IMAGE" bun --no-env-file /app/scripts/setup-env.mjs /install/.env

# Edit .env: set INSECURE_COOKIES=1 for loopback HTTP, or keep 0 for HTTPS.
docker compose up -d --wait --wait-timeout 180
curl -i http://127.0.0.1:3000/api/health
```

Private GHCR pulls require separate package read access. GitHub CLI repository
authentication alone isn't a Docker registry credential. Public release asset
downloads do not grant private image access. If you don't have registry access, build from
source instead.

### Build the published 2.3.2 source

The source repository is public; this path doesn't require GHCR access.
Compose has no build configuration, so
build the image explicitly:

```sh
git clone --branch v2.3.2 --single-branch https://github.com/madrobotnet/aro.git
cd aro
docker build --build-arg VERSION=2.3.2 \
  --build-arg REVISION="$(git rev-parse HEAD)" -t irang:local .
IRANG_IMAGE=irang:local
export IRANG_IMAGE
docker run --rm --user "$(id -u):$(id -g)" -v "$PWD":/install \
  irang:local bun --no-env-file /app/scripts/setup-env.mjs /install/.env

# Edit .env: add IRANG_IMAGE=irang:local.
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
   prints the code once in the published 2.3.2 image; the development version
   keeps it only in the private `.env` for local retrieval. If a `.env` already exists, it stops without changing
   anything. Running `bun install` on your machine won't create this file or
   the code.
2. Compose starts the selected image after the database passes its health check.
   Source Compose defaults to `ghcr.io/madrobotnet/irang:2.3.2`; the release
   archive uses its verified digest, and a source build uses `IRANG_IMAGE=irang:local`.
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

> [!WARNING]
> **Back up before every upgrade**, and never run `docker compose down -v`,
> because that deletes your data volumes.
>
> **1.x installs** used a different volume key (`second_brain_pg18`) and
> password names. Before upgrading, follow
> [Existing deployments](docs/SETUP.md#10-existing-deployments): set
> `POSTGRES_DATA_VOLUME`, keep your original `DATABASE_URL` and passwords, and
> copy attachments out of the old container **before** recreating it. The old
> Compose file didn't persist attachments.

For installs on 2.1 or later, back up first. Keep the existing installation
directory, Compose project name, `.env`, and physical data volumes. Replace only
the distribution files from the next archive, select its `release.json` image,
pull it, and run `docker compose up -d --wait --wait-timeout 180`. Source
installs rebuild with `docker build`, keep `IRANG_IMAGE=irang:local`, and
recreate with `--no-build --pull never`. Don't move an existing `second-brain`
project into a new `irang` directory and accidentally select empty volumes.
Keep `INSECURE_COOKIES=1` for loopback HTTP or `0` for HTTPS in `.env`.
The full upgrade, backup, and restore procedures are in
[Data, backup and upgrades](docs/SETUP.md#9-data-backup-and-upgrades).

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

The development database is a separate `second-brain-dev` Compose project on
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
`/usr/share/irang/licenses`. The application license doesn't relicense the
whole image.
