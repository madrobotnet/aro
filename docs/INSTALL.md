# Unified installer entry point (development)

Both modes use `scripts/install.mjs`. Bun 1.4.2 is required on the host.
Server mode also requires local Docker and Compose 5.1.0+. Desktop mode does
not use Docker. Current native verification is Linux arm64.

Build a single-file installer:

```sh
bun build scripts/install.mjs --target=bun --outfile dist/install.mjs
```

The bundled file has no relative script dependencies and can be delivered by
curl. No public installer URL or new release is claimed yet. A release operator
must publish the reviewed bundle, the native desktop archive, and trusted
checksums before documenting a public command. Do not use an invented URL.

Given a trusted installer URL and checksum from that release:

```sh
curl --fail --show-error --location "$INSTALLER_URL" --output aro-install.mjs
printf '%s  %s\n' "$INSTALLER_SHA256" aro-install.mjs | sha256sum --check
bun --no-env-file aro-install.mjs desktop \
  --url "$DESKTOP_ARCHIVE_URL" --sha256 "$DESKTOP_ARCHIVE_SHA256" \
  --directory "$HOME/aro-app"
```

For offline/local verification, replace `--url` with `--archive FILE`.
The installer checks the archive checksum, native platform, inventory and build
manifest, then creates a new installation directory. It refuses an existing
target. Follow [DESKTOP.md](DESKTOP.md) using the installed
`scripts/desktop.js` in place of the source `scripts/desktop.ts` to initialize
the owner and start the app. Initialization is local and needs no installation
token. Application files and private data should live in separate directories.

Server mode invokes the same checked bootstrap:

```sh
bun --no-env-file aro-install.mjs server \
  --version "$VERSION" --sha256 "$SERVER_ARCHIVE_SHA256" \
  --directory "$HOME/aro-server" --project aro-server --authenticated
```

See [INSTALL-SERVER.md](INSTALL-SERVER.md) for private GHCR authentication,
password-stdin owner creation, loopback defaults and failed-install recovery.
The installer does not silently install Docker, grant privileges, sign into a
registry, replace data, or upgrade a running installation.

## Producing a coherent native desktop artifact

`bun run build` builds the server and local initializer from one source snapshot.
It fails if application source changes during the build. `package-desktop.mjs`
requires matching build provenance and copies the already-built initializer;
it never combines an old server with a newly compiled initializer.

```sh
bun run build
bun --no-env-file scripts/package-desktop.mjs /absolute/new/aro .next
tar -czf aro-desktop.tar.gz -C /absolute/new aro
sha256sum aro-desktop.tar.gz
```

The package manifest remains marked `development: true` until release
verification/publication is separately authorized. Native dependencies mean an
arm64 artifact is not an amd64 artifact; do not relabel one as the other.
