# Contributing to Aro

Start with a reproducible bug or a concrete feature proposal. Search existing
issues before opening a new one. Before building a large patch, discuss changes
to data formats, auth, provider behavior, or deployment. Use
[Support](SUPPORT.md) for deployment questions and [Security](SECURITY.md) for
private vulnerability reports.

Keep discussions respectful and focused on the work. A report, documentation
correction, translation, or regression test can be as useful as a new feature.

## Toolchain

Use the same tools as CI:

| Tool | Version and purpose |
| --- | --- |
| Bun | **1.4.2**, dependency installation, app runtime, scripts, and tests |
| Node.js | **22**, required on `PATH` for the upstream CLI subprocess fixtures |
| Docker | A working Engine with ordinary `docker build` support |
| Docker Compose | **5.5.1**, matching CI and its interpolation behavior |

Node isn't a replacement for the Bun app runtime. The production image also
keeps Node for the upstream Codex and Gemini CLI executables.

```sh
bun --version
node --version
docker version
docker compose version
git clone https://github.com/madrobotnet/aro.git
cd aro
bun install --frozen-lockfile
```

While the repository is private, cloning requires repository access. Don't
change its visibility or publish an image to make a contribution.
Read `AGENTS.md` and the relevant guide in `node_modules/next/dist/docs/`
before changing Next.js behavior; this repository uses the installed version's
APIs and conventions.

## Use a disposable local database

Never develop or run tests against a deployed notebook: integration tests
truncate data. A test database name alone doesn't make its data safe to erase.

The development Compose file starts pgvector PostgreSQL 18 on
`127.0.0.1:55432`. Its initializer creates both `aro` for invented
development notes and the separate `aro_test` database for tests.
The `aro` username and password in the commands below are public
fixture values, not deployment credentials.

Use a fresh checkout and an unused Compose project. Before starting, check
for existing resources and a listener on the fixed port:

```sh
docker ps -a --filter label=com.docker.compose.project=aro-contrib
docker network ls --filter label=com.docker.compose.project=aro-contrib
docker volume ls --filter label=com.docker.compose.project=aro-contrib
# Linux: the output should show no listening socket.
ss -ltn 'sport = :55432'
```

If that project already exists or port 55432 is occupied, stop. Don't take over
or tear down someone else's stack. Use a separate disposable machine, or an
explicit local Compose port override and matching loopback test URL. A new
project name alone doesn't change the port.

For a fresh, free project and port:

```sh
docker compose -p aro-contrib -f docker-compose.dev.yml \
  up -d --wait --wait-timeout 180
```

Use this same `-p` and `-f` on every lifecycle command. The `-p` option overrides
the development file's default project name.

## Run the app without live AI

Work from a clean local environment, not a production shell or a checkout
containing production `.env` files. Use a dedicated local user or disposable
development container with no existing provider logins. Don't mount your
regular Codex, Gemini, or other credential directories into it.

```sh
cp .env.example .env.local
bun run setup-token
mkdir -p .data/dev/auth/codex .data/dev/auth/google
```

Edit `.env.local` locally:

- Keep `DATABASE_URL` pointed at the disposable `aro` development
  database on port 55432, not `aro_test` or a real notebook.
- Copy the dev-only `SETUP_TOKEN=...` assignment printed by `setup-token`.
  Leave `AUTH_PASSWORD_HASH` empty so the first-run wizard can create the owner.
- Set `INSECURE_COOKIES=1` for this loopback HTTP session.
- Leave AI API keys empty. Clear inherited AI keys and provider endpoint
  overrides from the shell before starting.

```sh
CODEX_HOME="$PWD/.data/dev/auth/codex" \
GEMINI_CLI_HOME="$PWD/.data/dev/auth/google" \
bun run dev --hostname 127.0.0.1
```

Open `http://127.0.0.1:3000/setup`, enter the dev installation code, and choose
a dev-only owner password of at least 12 characters. Leave both chat and Jev
off and use invented notes and attachments. Don't authorize a provider account
or send real data to an AI service for ordinary development or tests.

`.env.local` is the development file; Compose `.env` is a separate installation
file. If you need an environment password hash, `bun run hash-password` prints
a double-quoted Argon2 assignment with `\$` escapes. Copy that line exactly as
printed, without dollar doubling. Compose's rendered config can escape `$` as
`$$` when writing YAML for reuse. Don't copy that rendering into a dotenv hash.
Keep generated codes, passwords, and hashes out of patches and reports.

## Required checks

Run these from the repository root in the clean fixture environment above.
The full test suite must pass in one run:

```sh
bun run typecheck
bun run lint -- --max-warnings=0
TEST_DATABASE_URL=postgres://aro:aro@127.0.0.1:55432/aro_test \
  bun test
docker build --build-arg VERSION=2.4.0 \
  --build-arg REVISION="$(git rev-parse HEAD)" -t aro:local .
git diff --check
```

The test database guard accepts only loopback URLs without query overrides,
with the database name `aro_test` or `sb_test_<lane>` using lowercase
letters, numbers, and underscores. Supply an explicit `TEST_DATABASE_URL`.
Don't bypass the guard or run concurrent suites against the same database.

Existing provider tests inject synthetic HTTP responses and disposable auth
files. Gemini fixtures run a real local Node subprocess, not an authenticated
CLI or a network model. Extend those patterns instead of introducing live AI
calls, paid keys, account logins, or private notes. For async tests, subscribe
to the event before triggering it and use a bounded timeout, not fixed sleeps.
Don't skip or weaken a failing test to get a green run.

The Docker build compiles the production app and downloads dependencies and
upstream CLI packages. It needs network access, but no provider credentials.
It proves a local build for your host architecture, not a native two-platform
release or a successful GHCR pull.

The production `compose.yml` is image-only. It doesn't build the app. To try
the local image as an installation, follow the full [setup guide](docs/SETUP.md)
in a separate disposable directory and project, with `ARO_IMAGE=aro:local`
explicitly saved in its env file. Don't run it over an existing installation.

Stop the dev server before removing fixtures. Only if you created the
`aro-contrib` project above and all of its data is disposable:

```sh
docker compose -p aro-contrib -f docker-compose.dev.yml \
  down -v --remove-orphans
```

Here `-v` is only for owned, disposable test resources. Never use it for an
installation or upgrade. Preserve an installation's env file, directory,
project name, and volumes. Don't run a global Docker prune.

## Prepare a pull request

Keep the patch focused and explain the user-visible result. Add a regression
test beside the existing tests when behavior changes. Preserve API and Auth
modes, consent, credential isolation, saved model IDs, and AI-off use.
Claude API support remains part of the software; a network-free test doesn't
need a Claude account.

Update affected documentation and both language versions where applicable.
Documentation changes need a separate prose-polishing pass after drafting.
Don't add a test that pins prose. Update dependencies only when needed, and
include the corresponding `bun.lock` changes.

Fill in the pull request template with the commands you actually ran and their
results. Explain which checks you couldn't run and why. For UI changes, include
desktop and mobile evidence using synthetic data, with no secrets or private notes.
Don't attach full logs, env files, auth files, or database exports.

The [MIT license](LICENSE) covers contributions to Aro; preserve relevant
upstream notices. Review and merging are separate from release publication,
production deployment, and repository or package visibility changes, which
remain owner-controlled.
