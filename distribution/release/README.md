# Portable corresponding-source assets

The Dockerfile keeps the normal native application build. Its `source-assets`
target exports the selected sources separately from the final scratch runner.
Use the same clean checkout, native platform, version, revision, base inputs
and BuildKit cache for both targets. Exporting twice does not prove equality:
compare the export's seal with the freshly pulled runner.

The runner embeds `/usr/share/aro/licenses/materials.json` and
`/usr/share/aro/licenses/materials.sha256`. The first file is the exact
selected-material manifest; the second contains its SHA-256. Manifest schema 1
has kind `aro-selected-materials` (restore also accepts `irang-selected-materials`), version, revision, platform, measured target
associations and an explicit file allowlist. No producer filesystem locators
are needed to restore sources.

For version 2.4.0, each native output contains:

- `aro-2.4.0-sources-linux-ARCH-index.json` and its `.sha256`;
- `aro-2.4.0-sources-linux-ARCH-0001.tar` and subsequent numbered pieces;
- `assets.mjs`, `restore.mjs` and `release-names.mjs`, the standalone Node reconstruction helpers.

Versions below 2.4.0 retain the `irang-` asset prefix and registry; published
2.3.x downloads and sealed manifests remain valid inputs.

`ARCH` is `amd64` or `arm64`. Index schema 2 records `version`, `revision`,
`platform`, `materialManifestSha256`, `assets`, `blobs` and `associations`.
Each asset has `name`, `bytes` and `sha256`; each blob has ordered, hashed
pieces with byte offsets. Associations retain owner, relative path, mode,
size and hash even when several owners share identical content. The archive
writer streams large files, splits oversized files and fixes tar metadata.
Each piece is strictly below 1.9 GB by default.

The preparer can also be run explicitly:

```sh
bun scripts/prepare-source-assets.mjs \
  --materials /materials --seal MATERIAL_MANIFEST_SHA256 \
  --version 2.4.0 --revision FULL_GIT_REVISION \
  --platform linux/amd64 --out /new/source-assets
```

All selected file hashes and the manifest seal are checked before output
creation. This command does not approve compiler provenance, native library
replacement, image publication or source publication.

## Recipient reconstruction

Get the index hash from authenticated release metadata. Download every named
piece and all three helpers, then reconstruct into a new directory:

```sh
node restore.mjs /downloads \
  aro-2.4.0-sources-linux-amd64-index.json INDEX_SHA256 /new/source-tree
```

Reconstruction verifies the pinned index, every archive and every piece before
creating output, then checks each restored file. Paths, modes, duplicate
destinations and archive bounds are validated. Keep the restored manifests
and notices with their sources.

For Debian, enter `debian/sources/PACKAGE_VERSION` and use
`dpkg-source -x PACKAGE_VERSION.dsc`, install the declared build dependencies,
then run `dpkg-buildpackage`. The manifest maps exact installed binary versions
to matching `.dsc`, upstream and Debian change files. It records source-index
hash checks, not an invented OpenPGP verification.

Use `runtime/sources/REBUILD.md`, `app/notices/LGPL-REPLACEMENT.md` and
`cli/notices/LINKED-LIBRARIES.txt` for native source and replacement rights.
No original width implementation or raw containing Node/npm archive is selected.

## Distributor integration

Bind each index hash and material seal to its tested runnable image manifest
digest, not merely the multi-platform index or a source revision. Compare
`materialManifestSha256` to the embedded manifest's actual hash after a fresh
native pull. Require exact version, revision and platform equality.

Verify source pieces with streaming hashes, independently of the installer
archive's text/privacy screen. Add every source piece, index, checksum sidecar
and reconstruction helper to release checksums and uploaded-byte verification.
Provide equivalent recipient access without an additional restriction or
charge. Publication and native receipts remain separate release gates.
