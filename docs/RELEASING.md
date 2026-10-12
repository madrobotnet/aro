# Aro 2.4.0 release contract

This guide describes the maintainer procedure for Aro 2.4.0. It does not claim
that the tag, image or release assets have been published.

This guide describes the native-image release for **2.4.0** from the public source
repository, with the existing GHCR package kept private. The tag is
`v2.4.0`, the image is `ghcr.io/madrobotnet/aro:2.4.0`, and the installation
archive is `aro-2.4.0-install.tar.gz`. Installation and data recovery are in
[SETUP.md](SETUP.md).

**Verification boundary:** accept a release only after checking its exact tag,
source revision, image digests, assets, and successful native workflow receipts
for both platforms. Ordinary exact-SHA CI and synthetic two-platform metadata
are not native-release proof. Documentation, separate prose polishing, licensing,
and security checks must also pass. Public source and GitHub release assets do
not grant anonymous access to the private image package. Repository and package
visibility are separate settings; this release changes neither.

The commands below describe the maintainer procedure; they aren't evidence
that the remote actions have occurred. Tagging, pushing, and running the release
workflow write to GitHub and GHCR and require the owner's release authorization.
The workflow doesn't deploy production or change visibility.

## 1. Release identity and toolchain

Before tagging, set `package.json` to version `2.4.0` and keep `private: true`. This is an image
distribution, not an npm package. Source `compose.yml` must remain image-only:

Select the app image with `ARO_IMAGE`; its source default is
`ghcr.io/madrobotnet/aro:2.4.0`. The previous environment key remains an upgrade
fallback, described in [UPDATE.md](UPDATE.md).

The stable tag, package version, and Compose default version must agree.
The real tag must resolve to the workflow's checked-out commit and be reachable from
`origin/main`. Stable tags accept only `vMAJOR.MINOR.PATCH`, with no prerelease
suffix or leading zeroes. Dispatch on a branch fails validation.

| Component | Contract |
| --- | --- |
| App/runtime and maintainer scripts | Bun 1.4.2 |
| Upstream account-login CLI runtime and test fixtures | Node 22; the app still runs on Bun |
| Official CLIs bundled in the image | `@openai/codex@0.158.0`, `@google/gemini-cli@0.61.0` |
| PostgreSQL | `pgvector/pgvector:0.8.6-pg18` |
| Docker Compose | Minimum 5.1.0; CI/release jobs pin 5.5.1 |
| Native image targets | `linux/amd64` on `ubuntu-24.04`; `linux/arm64` on `ubuntu-24.04-arm` |
| Build method | Native Buildx `docker-container` builders, no QEMU |

Docker builds include version and full source revision in OCI labels.
The image's license label is `NOASSERTION`: Aro's code is MIT, but that
doesn't relicense the whole image. Never pass secrets as build arguments.

The Dockerfile pins both native base indexes. Each build also exports its
`source-assets` target. A fresh native pull must hash the image's embedded
`/usr/share/aro/licenses/materials.json` and verify that architecture's source
index against the seal, version, revision and platform. The native receipt
records the index hash and material seal alongside the runnable digest.
See the tagged [source reconstruction contract](https://github.com/madrobotnet/aro/blob/v2.4.0/distribution/release/README.md).
Publish both architecture-qualified indexes, all numbered source pieces,
checksum sidecars and reconstruction helpers with the installation assets.
`verify-release.mjs sources` checks their native bindings; `checksums` streams
validated source pieces while retaining the installer's text/privacy screen.

Only `:2.4.0` and `:sha-<full-source-SHA>` are final image tags. There are no
`latest`, `2`, or `2.2` aliases. A published version must never point to new
bytes. Rebuilding from the same source can produce different bytes because
base images and upstream materials can change; source equality isn't digest
equality.

## 2. Finish the checks before tagging

Prepare the final source revision, not an earlier packaging-only revision.
All English and Korean documents, community files, and third-party notices
need their own complete review and a distinct prose-polishing pass.

| Gate | Required evidence |
| --- | --- |
| Documentation | All 13 English/Korean setup sections, matching commands/tables, valid links, complete desktop/mobile document inspection, and separate polishing |
| Application checks | Exact-source typecheck, zero-warning lint, full tests against an isolated test database, and production Docker build |
| Runtime | Actual current and synthetic legacy smoke, API responses, note/file persistence after recreation, and owned-resource cleanup |
| First-run UI | Empty-instance setup/login on desktop and mobile, AI off, no leaked tokens in screenshots, and owner persistence |
| Secrets | Redacted full-ref scan, tracked assets, screenshots, and historical Actions logs/artifacts checked before exposure |
| Dependencies and image licensing | Dependency audit, app/CLI/OS inventories, full notices, and resolved applicable attribution/source/redistribution obligations |
| Release capability | Before tagging: runner availability and package access/settings reviewed. Before accepting the release: both real native registry-pull receipts |

Run the repository checks with Bun 1.4.2. Node 22 is needed for upstream CLI
fixtures. Before starting the development database, check that you won't take
ownership of another stack or its port. These commands use the repository's
separate `aro-dev` project on port 55432:

```sh
bun install --frozen-lockfile
bun run typecheck
bun run lint -- --max-warnings=0
bun test src/server/setup/compose.test.ts src/server/setup/compose-upgrade.test.ts src/server/setup/env-script.test.ts
bun run db:up
TEST_DATABASE_URL=postgres://aro:aro@127.0.0.1:55432/aro_test bun test
docker build --build-arg VERSION=2.4.0 \
  --build-arg REVISION="$(git rev-parse HEAD)" -t aro:package-qa .
```

Never point tests at production. `bun run db:down` deletes the development
volume; use it only if you created and own that disposable database.

The packaged smoke tool needs a free port, an unused QA project name, and a new
evidence directory. It rejects pre-existing resources for that project:

```sh
bun --no-env-file scripts/smoke-image.mjs \
  --image aro:package-qa --project aro-package-qa --port 3316 \
  --evidence-dir .omo/evidence/packaging-public-ready/local
```

The tool owns its synthetic current/legacy resources and cleans them up.
Its success does not prove a historical 1.x binary upgrade, old attachment
migration, or PostgreSQL major-version migration. No live provider login or
AI request is needed. Preserve every supported API/Auth mode, including
Claude's API-key mode.

Using the verified gitleaks 8.30.1 binary, scan all fetched history, not just
the worktree:

```sh
gitleaks git --log-opts="--all" --config .gitleaks.toml --redact \
  --report-format json \
  --report-path .omo/evidence/packaging-public-ready/security/gitleaks.json .
bun audit --json
bun pm licenses
git diff --check
```

Create the private report directory before running the scan. Check which refs
were fetched and whether LFS/submodules need separate inspection. Resolve
findings rather than suppressing them or rewriting history without approval.
Don't publish raw scan reports, credentials, private notes, or complete logs.
Report suspected vulnerabilities privately to
[hello@madrobot.net](mailto:hello@madrobot.net); this guide doesn't promise an
unverified private-vulnerability feature or a response-time SLA.

Inspect `/app/licenses/app`, `/app/licenses/cli`, `/usr/share/aro/licenses`,
the Pretendard OFL, upstream runtime notices, and Debian copyright records
in each native image. Match collected file hashes to actual retained bytes
and resolve applicable entries in `unresolved.json` before release.
An SBOM or successful collector exit isn't redistribution approval.
See [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).

## 3. Tag the verified revision

From a clean, reviewed checkout, refresh remote refs and inspect existing
tags/releases. Don't overwrite a version another maintainer has published:

```sh
git fetch origin main --tags
git status --short
git tag --list v2.4.0
git ls-remote --tags origin refs/tags/v2.4.0
gh release list --repo madrobotnet/aro
gh repo view madrobotnet/aro --json isPrivate

VERSION=2.4.0
SOURCE_SHA=$(git rev-parse HEAD)
git merge-base --is-ancestor "$SOURCE_SHA" origin/main
bun --no-env-file scripts/verify-release.mjs validate \
  --root . --version "$VERSION" --ref "refs/tags/v$VERSION" \
  --revision "$SOURCE_SHA"
```

Proceed only when the source repository is public and the existing image package
remains private, the final revision's checks are
clean, the worktree is clean, and `v2.4.0` is absent locally and remotely.
The validator checks identity and image-only Compose; it doesn't prove all
readiness gates or tag absence.

With the owner's authorization, create and push the annotated tag:

```sh
git tag -a v2.4.0 "$SOURCE_SHA" -m "Aro 2.4.0"
git push origin refs/tags/v2.4.0
```

The tag push triggers `.github/workflows/release.yml`, named
**Native package release**. If the tag already exists and a dispatch is needed,
dispatch on that tag, not on `main`:

```sh
gh workflow run release.yml --repo madrobotnet/aro --ref v2.4.0
```

Don't dispatch a second run while a healthy tag-triggered run is active.
The workflow serializes each ref with `cancel-in-progress: false`.

## 4. What the workflow actually does

The dependency order is:

```text
validate -> reusable ci -> native build[amd64,arm64]
         -> fresh verify-pull[amd64,arm64]
         -> merge-candidate -> publish-release
```

| Job | Permissions | Required result |
| --- | --- | --- |
| `validate` | `contents: read` | Expected public source repository, strict real tag, peeled checkout SHA, `origin/main` ancestry, package/Compose/tag identity |
| `ci` | `contents: read` | Existing reusable CI: secret scan, typecheck, lint, full tests, production build, and isolated DB cleanup |
| `build` | `contents: read`, `packages: write` | Two native builds pushed by digest with source/version/revision labels, minimum-mode provenance, and SBOM |
| `verify-pull` | `contents: read`, `packages: read` | Fresh native runners pull each build-output digest, inspect platform/labels, run full smoke, and record cleanup |
| `merge-candidate` | `contents: read`, `packages: write` | Merge tested descriptors, verify registry bytes, attestation subjects, source-linked provenance, and nonempty SPDX SBOM |
| `publish-release` | `contents: write`, `packages: write` | Assemble archive, smoke its extracted files on native AMD64, promote exact bytes, verify uploaded assets, and publish a stable GitHub release while retaining private package access |

Global permissions are empty. New release actions are pinned to full commit
SHAs. Registry logins use each job's `GITHUB_TOKEN`, not a broad maintainer PAT.
Never copy an ephemeral job token onto the host or into artifacts. Existing
repository OAuth access may download release assets without granting private
GHCR access.

Builds export `build-amd64` and `build-arm64` artifacts with digest, build
metadata, and toolchain records. Fresh readers export `tested-amd64` and
`tested-arm64`, including native receipts, image inspection, raw build index,
and smoke receipts. Merge exports `merged`, including raw final index and
verification metadata. These Actions artifacts have seven-day retention;
download the needed evidence promptly.

The candidate tag is
`candidate-<revision>-<run-id>-<run-attempt>`. A build-output digest can name
an index containing a runnable image and attestations. The verifier distinguishes
that index from the runnable manifest digest. The merged index must contain
exactly `linux/amd64` and `linux/arm64` runnable descriptors, each equal to its
tested native receipt. Associated `unknown/unknown` attestation descriptors
aren't extra CPU platforms.

Before assigning final tags, the publication job extracts the assembled archive,
pulls the merged index, and smoke-tests that installation on native AMD64 using `--install-dir`.
The ARM64 descriptor must still match the separately tested ARM64 receipt.
The workflow then checks both final tags before writing either one. An identical
digest is a no-op; a different digest is a hard failure. Authentication and
network failures aren't treated as tag absence. Promotion writes the checked
index bytes without rebuilding.

The final job creates or resumes a **draft** release for the existing tag,
uploads assets, downloads them again, checks hashes and byte equality, then
sets `draft=false` and `prerelease=false`. It checks the expected public source
repository again
before release creation. It refuses to overwrite an already published release.

The workflow supplies BuildKit provenance/SBOM statements, not a signed GitHub
artifact attestation. Its release receipt records version, revision, index
digest, and two native receipts. Run URL/ID, toolchain, and base-material details
must be retained separately from the Actions run and provenance. They aren't
fields in the release receipt.

## 5. Installation archive and release assets

The archive has one `aro/` directory containing:

- `compose.yml` and `docker/postgres/production/01-app-role.sql`;
- both READMEs, both complete setup guides, the release/architecture/optional
  learned-search guides, changelog and `docs/images/aro-mark.svg`;
- both backup guides and `scripts/backup.mjs`, `scripts/restore-check.mjs`,
  and `scripts/backup/common.mjs`;
- `LICENSE`, `THIRD_PARTY_NOTICES.md`, `SECURITY.md`, `CONTRIBUTING.md`,
  and `SUPPORT.md`;
- generated `release.json`.

It excludes `.env`, `.env.local`, `.git`, `.omo`, `.data`, credentials,
`node_modules`, and the full source/build context. Build-from-source users
need a repository checkout, not this installation archive.
The assembler uses an explicit file list, not a recursive documentation walk.
Historical HTTP/QA receipts, research and engineering plans are not installation
assets. New documentation requires an intentional selection and link/privacy
review before it can enter the bundle.

`release.json` records the version, tag ref, full source revision, immutable
image reference, final index digest, both runnable platform digests, and source
and archived Compose SHA-256 values. The assembler changes exactly one parsed
Compose value, the default `app.image`, to
`ghcr.io/madrobotnet/aro:2.4.0@sha256:...`. It retains `ARO_IMAGE` overrides,
the SQL mount, secrets, project-scoped volume keys, and every other parsed field.
Bootstrap must select `release.json`'s image too.

| Release asset | Contents |
| --- | --- |
| `aro-2.4.0-install.tar.gz` | Digest-pinned installation bundle |
| `aro-2.4.0-sources-linux-<arch>-index.json` | Architecture-qualified source index |
| `aro-2.4.0-sources-linux-<arch>-0001.tar` (and later numbers) | Numbered source pieces |
| `aro-2.4.0-sources-linux-<arch>-index.json.sha256` | Source index checksum sidecar |
| `assets.mjs`, `restore.mjs`, `release-names.mjs` | Source reconstruction helpers |
| `archive-manifest.json` | Each archive member's path, size, and SHA-256 |
| `image-manifest.json` | Exact merged OCI index bytes |
| `attestations-amd64.json`, `attestations-arm64.json` | Per-platform provenance and SPDX SBOM statements |
| `smoke-amd64.json`, `smoke-arm64.json` | Native smoke and cleanup receipts |
| `smoke-archive.json` | Extracted-archive smoke receipt |
| `release-receipt.json` | Version, full source revision, final index digest, and native receipts |
| `SHA256SUMS` | Every other release asset's SHA-256; no self-hash |

The verifier's command interfaces are:

```sh
bun --no-env-file scripts/verify-release.mjs verify \
  --metadata merged/metadata.json --version "$VERSION" \
  --ref "refs/tags/v$VERSION" --revision "$SOURCE_SHA"
bun --no-env-file scripts/verify-release.mjs assemble \
  --root . --out assets --metadata merged/metadata.json --version "$VERSION" \
  --ref "refs/tags/v$VERSION" --revision "$SOURCE_SHA"
bun --no-env-file scripts/verify-release.mjs checksums --root assets
```

These commands use the workflow's paths. Local use requires real downloaded
metadata for that version and revision, and a **new** output directory. Synthetic metadata
can test the parser and assembler, but can't establish a real native release.
Publication adds supplementary assets and regenerates `SHA256SUMS` before
upload. Archive contents are screened for unsafe paths, symlinks, and selected
secret patterns; this bounded screen doesn't replace the full security audit.

## 6. Watch and verify the release and private package

List runs for the exact tagged commit. Set `RUN_ID` to the matching release run
ID from this output, not to an ordinary CI run:

```sh
gh run list --repo madrobotnet/aro --workflow release.yml \
  --commit "$SOURCE_SHA" --json databaseId,headSha,status,conclusion,url
gh run watch "$RUN_ID" --repo madrobotnet/aro --exit-status
gh run view "$RUN_ID" --repo madrobotnet/aro \
  --json headSha,status,conclusion,jobs,url
```

Require completed/success, exact `headSha`, both native build/read jobs, and
archive smoke. Inspect actual pull and cleanup logs, not only green badges.
For a failed run, fix the cause and rerun failed jobs when their successful
upstream artifacts remain valid:

```sh
gh run rerun "$RUN_ID" --repo madrobotnet/aro --failed
```

Don't replace an immutable version with a rebuilt digest. A conflict needs
investigation; changed release content needs a new version. A rerun can resume
its draft, but won't overwrite a published release. Partial remote writes
can remain after a failure; inspect candidate/final tags and release state
before deciding what to retry.

Download evidence and release assets into new private directories:

```sh
umask 077
gh run download "$RUN_ID" --repo madrobotnet/aro --dir release-actions
mkdir release-download
gh release download v2.4.0 --repo madrobotnet/aro --dir release-download
gh release view v2.4.0 --repo madrobotnet/aro \
  --json tagName,targetCommitish,isDraft,isPrerelease,assets,url
gh repo view madrobotnet/aro --json isPrivate
bun --no-env-file scripts/verify-release.mjs checksums --root release-download
(
  cd release-download
  sha256sum --check SHA256SUMS
)
```

Require a non-draft, non-prerelease `v2.4.0`, every expected asset, passing
checksums, public source `isPrivate=false`, and unchanged private package
visibility confirmed by an operator with package access. Independently compare all archive members
against `archive-manifest.json`. Extract into an empty directory:

```sh
mkdir release-extracted
tar -xzf release-download/aro-2.4.0-install.tar.gz -C release-extracted
TAGGED_SHA=$(git rev-parse 'refs/tags/v2.4.0^{commit}')
test "$TAGGED_SHA" = "$SOURCE_SHA"
test "$(jq -r .revision release-download/release-receipt.json)" = "$SOURCE_SHA"
test "$(jq -r .revision release-extracted/aro/release.json)" = "$SOURCE_SHA"
INDEX_DIGEST=$(jq -r .indexDigest release-download/release-receipt.json)
test "$(jq -r .indexDigest release-extracted/aro/release.json)" = "$INDEX_DIGEST"
```

Don't use release `targetCommitish` alone as source proof; peel the actual tag.
Hash `image-manifest.json` and require `sha256:<hash>` to equal `INDEX_DIGEST`.
Check both runnable descriptors against native receipts, their OCI labels,
attestation subjects, revision-linked provenance, and nonempty SBOMs.
Verify the archived Compose image matches `release.json` and all other parsed
fields match the tagged source.

Private registry inspection requires package read access. When that access is
available, use exact digest references:

```sh
docker buildx imagetools inspect "ghcr.io/madrobotnet/aro@$INDEX_DIGEST" --raw
docker buildx imagetools inspect "ghcr.io/madrobotnet/aro@$INDEX_DIGEST" --format '{{json .Provenance}}'
docker buildx imagetools inspect "ghcr.io/madrobotnet/aro@$INDEX_DIGEST" --format '{{json .SBOM}}'
```

A local maintainer without package scopes can examine the downloaded native
job logs, raw registry bytes, and receipts instead. Don't claim a local
private pull that wasn't run, or anonymous access from an authenticated pull.
Only the release's real native reader jobs establish private registry download
and execution on each architecture.

## 7. Preserve the source and package access boundaries

The `madrobotnet/aro` source repository is public. Its release assets and
source can be downloaded without private-package permission. The existing
`ghcr.io/madrobotnet/aro` package remains private; repository visibility and
access inheritance do not make private image pulls anonymous.

Before tagging and after publication, an operator with package access must
confirm the package remains private, the old version's digest is unchanged,
and the new version matches the native receipts. The workflow never changes
either visibility setting, and native reader jobs use scoped job credentials.
Do not publish tokens or copy them into installation bundles.

Anonymous image access is not a release acceptance criterion for this package.
Any future package visibility change requires a separate owner decision and
privacy/source-obligation review. This release's handoff is a verified public
GitHub release with an access-controlled image package, not anonymous
prebuilt-image distribution.

GitHub references:
[container registry authentication](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry),
[package access and visibility](https://docs.github.com/en/packages/learn-github-packages/configuring-a-packages-access-control-and-visibility),
and [repository visibility](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/managing-repository-settings/setting-repository-visibility).
