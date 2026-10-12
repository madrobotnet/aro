# Changelog

## Unreleased — recovery and portable data

- Rename the product and new-install identifiers to Aro / 아로. Releases from
  2.4.0 use the `ghcr.io/madrobotnet/aro` image, `aro-<version>-*` archives,
  `ARO_IMAGE`, the `aro_session` cookie and `aro` database names. Installations
  created earlier keep their database, role and volume names, which must be set
  as `POSTGRES_APP_DB` and `POSTGRES_APP_USER`; `IRANG_IMAGE` and the previous
  session cookie are still accepted. See `docs/UPDATE.md`.
- Give chat sends a retained request ID, persist the committed response atomically,
  and reconcile interrupted streams before offering a retry. Reusing an ID for
  different content or another thread is rejected.
- Export metadata and note bodies from one repeatable-read snapshot. Include
  `export-manifest.json` with note/attachment paths and explicit attachment
  omissions; retain original API URLs for omitted attachment files.
- Offer opt-in portable wiki links resolved to the actual exported filenames,
  while preserving wiki links by default and leaving code examples untouched.
- Add private, checksum-bound installer backups and restore verification in a
  newly owned disposable sandbox. The management tools require Node.js 22+;
  they do not schedule backups or overwrite an existing installation.

## 2.3.2 - 2026-10-10

### Fixed

- Release checksum discovery now finds source indexes independently of the
  version. The old regex, pinned to escaped `2.3.0`, skipped newer indexes and
  sent reviewed source archives through ordinary document screening. Discovery
  now validates source structure and streams source-archive checksums while
  preserving ordinary asset privacy checks.

## 2.3.1 - 2026-10-10

### Fixed

- Maintainer smoke isolation preserves lookup of the pinned Docker Compose
  5.5.1 CLI plugin without copying registry credentials. The isolated `HOME`
  and `DOCKER_CONFIG` hid the user-installed plugin and selected system Compose
  2.38.2, causing a false legacy-volume interpolation failure in the modern fixture.

## 2.3.0 - 2026-10-07

### Added

- Optional local learned passage retrieval with EmbeddingGemma 2. Exact names,
  aliases, metadata and lexical search remain usable without the model.
- Bounded, resumable indexing with model identity and source freshness checks.
  Note saves do not wait for learned inference.
- Supporting passage locations in search and related notes, version-checked
  navigation and honest indexing/unavailable status.

### Changed

- Release identity and installation examples target 2.3.0. Public source and
  release assets are distinct from the access-controlled GHCR package.
- The app image does not bundle embedding weights or a learned-model runtime;
  operators configure the optional private endpoint separately.

## 2.2.0 - 2026-09-28

### Added

- Multiple named AI connections with independent chat and Jev selection. First
  setup creates initial profiles; settings can add, edit, select, disable or
  delete them. Disabling usage preserves saved connections.
- OpenAI-compatible Chat Completions/Responses and Anthropic-compatible Messages
  endpoints, including manual model IDs, keyless local servers, extra headers
  and output-token limits.
- GitHub Copilot, OpenRouter and xAI API credentials and browser account login.
  Copilot and xAI use device authorization; OpenRouter uses PKCE and returns an
  API key. ChatGPT and Gemini retain their official CLI login; Claude remains
  API-only.
- Optional Jev connections through TypeSafe API or OpenRouter API/account login,
  independently switchable and editable after setup.
- Owner/installer-scoped, browser-bound login attempts, one-time transactional
  credential consumption and serialized token refresh. Credentials and extra
  header values are never returned in settings responses.

### Changed

- Migration `0003_ai_connections` preserves existing AI credentials and selected
  models in owner-scoped connection profiles. Per-purpose environment selections
  preserve legacy installations without silently enabling inactive connections.
- Changing a custom endpoint requires a fresh key or explicit keyless choice
  and never forwards the previous endpoint's extra headers.

## 2.1.0 - 2026-09-28

Protected first-run setup, persistent AI connection settings, and first-party AI
transports. Capture, inbox, Markdown notes with `[[wiki links]]`, typo-tolerant
Korean search, the note graph, attachments, and the home dashboard keep their
2.0 behavior.

### Added

- **Protected first-run setup.** An empty server (no users, notes, inbox items,
  threads, or attachments) serves `/setup`, where the operator enters the
  installation code (`SETUP_TOKEN`, printed by `bun run setup-env` or
  `bun run setup-token`) and chooses the owner password (12 characters or
  more). The owner account and AI settings are written in a single database
  transaction. Servers with `AUTH_PASSWORD_HASH` or existing data never expose
  first-run account creation; the environment hash stays authoritative for
  login and the setup-created owner password is the fallback.
- **Persistent AI configuration.** Chat and Jev connections are stored
  server-side (`installation_settings`) and editable in the setup wizard and
  the authenticated settings view; saved changes apply without a restart. The
  API only ever returns redacted metadata (provider, connection mode, model,
  and whether a key is present), never credentials.
- **Chat AI transports.** Direct API transports for OpenAI, Claude, and Gemini
  with explicit provider, connection mode, and model choice. Answer streams
  cite the notes they used and may say when the notes contain no answer.
  Claude is API-key only; OpenAI and Gemini additionally work through their
  official account login (the Docker image bundles the Codex and Gemini CLI
  tools, and their auth files live in the persistent app-data volume).
- **Explicit data-sharing controls.** Saving a connection requires explicit
  consent to what is sent: chat sends the question, recent conversation
  history, and related note excerpts; Jev sends the capture title and body
  (up to 4000 characters) and recent note titles. A saved opt-out wins over
  legacy environment credentials. Model permissions and billing stay with the
  provider.
- **Optional Jev classifier.** TypeSafe official (`api.typesafe.ai`) or
  OpenRouter (`openrouter.ai/api`) with model IDs such as `jev-latest`.
  Capture, notes, search, and the graph never require Jev.
- **Docker bootstrap.** `docker compose up -d --build` builds the image from
  source: Bun 1.4.2 install and build stages, a Node 22 stage for the official
  CLI tools, a non-root runtime user, and an `/api/health` healthcheck.
  `scripts/setup-env.mjs` generates a `0600` `.env` with three distinct random
  secrets (installer token, application-database password, admin-database
  password) and refuses an existing file. The database starts as the `postgres`
  admin account; the application itself connects only through a precreated
  least-privilege role (`NOSUPERUSER NOCREATEDB NOCREATEROLE`, with pgcrypto,
  pgvector, and pg_trgm preinstalled) using its own password.
  `docker compose down` preserves named volumes.
- **CI.** A GitHub Actions workflow for pull requests and pushes to main and
  feature branches: frozen-lockfile install, typecheck, lint with zero
  warnings, the full Bun test suite against an isolated Postgres started from
  `docker-compose.dev.yml`, a production Docker build, a redacted gitleaks
  secret scan, and teardown of the runner's test database.
- **Docs.** Rewritten README quickstart, a new installation guide
  (`docs/SETUP.md`), and updated `docs/ARCHITECTURE.md`.
- **License.** Released under the [MIT license](LICENSE).

## 2.0.0 - 2026-09-28

Rebuild on Next.js with a Bun runtime and PostgreSQL storage: URL and memo
capture into an inbox, Markdown notes with wiki links, typo-tolerant Korean
search (PostgreSQL full-text, trigram, and character n-gram), an interactive
note graph, attachments, a timezone-aware home dashboard with daily notes, and
optional AI chat with cited sources.
