# Server installer increment verification

Verified in `/home/ubuntu/.dori/work/irang-v2.4.0` on Linux arm64, Bun 1.4.2.
No commit, push, deploy, live registry login/pull, Docker resource creation, or
production service operation was performed.

## Commands and observed results

```sh
bun --no-env-file test scripts/install-server.test.mjs
```

10 passed, 0 failed, 100 assertions, 1.60 seconds. Real child-process tests use a
deterministic Docker executable fixture; the download seam uses real loopback
HTTP. Dry-run verifies no directory entries changed with the runtime cache
disabled, and no Docker calls occurred. Covered failures include missing explicit
authorization, wrong checksum/identity, unsafe paths, old Compose, remote
Docker, existing labeled and unlabeled volumes, denied pull, occupied port and
failed startup. Private terminal token retrieval and rejected captured output
were exercised.

```sh
bun --no-env-file x --no-install eslint scripts/install-server*.mjs scripts/setup-env.mjs --max-warnings=0
bun --no-env-file test src/server/setup/env-script.test.ts src/server/setup/compose.test.ts src/server/setup/compose-upgrade.test.ts
git diff --check -- scripts/setup-env.mjs
```

All exited 0. Adjacent setup tests: 13 passed, 0 failed, 51 assertions,
1.451 seconds. These include actual local Docker Compose parsing without
starting services. Lint emitted no warnings/errors.

## Evidence files and boundaries

- `scripts/install-server.mjs`: implementation and production CLI.
- `scripts/install-server.test.mjs`: reproducible process/HTTP/terminal checks.
- `scripts/install-server-docker-fixture.mjs`: deterministic subprocess seam.
- `scripts/setup-env.mjs`: secret generation no longer prints the setup token.
- `docs/INSTALL-SERVER.md`: usage, recovery, upgrade boundaries and concrete
  future authenticated browser-handoff design.

The first focused run found Bun's own `.bun` runtime cache directory invalidating
the no-write check. The final run disables that cache rather than ignoring its
appearance. No failing assertion was weakened to hide an installation write.

Language-server fresh diagnostics timed out after 3000 ms; they did not establish
a clean LSP result. Scoped lint and executable tests passed. No UI/server auth
code changed. Full application build/tests, actual private GHCR access, native
Docker startup, published release byte verification, browser setup/login, and
backup restoration remain parent integration checks, not claims of this lane.
The installer is fresh-install only; upgrades are intentionally explicit/manual.
The PostgreSQL version pin is inherited from the release; only the app image
has the existing release's immutable digest pin. Browser token automation needs
a new authenticated session contract and was not implemented.
