# Native build inputs can be pinned to registry digests by the release job.
ARG BUN_IMAGE=oven/bun:1.4.2-slim@sha256:cb3bbbb08e13a4a2ff400f24c7a2a1d5efa83f6ef8544d52d95a519631e2fc61
ARG NODE_IMAGE=node:22.23.3-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392
FROM ${BUN_IMAGE} AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM ${BUN_IMAGE} AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Collect full dependency notices before Next standalone tracing omits package metadata.
RUN bun scripts/collect-image-licenses.mjs --root /app/node_modules --out /app/app-licenses \
    && bun -e 'const inv=await Bun.file("/app/app-licenses/inventory.json").json(); const names=new Set(inv.packages.map(p=>p.name)); for (const id of ["next","react","react-dom"]) if (!names.has(id)) { console.error("missing "+id); process.exit(1) }'
RUN bun run build

# Official account-login CLIs keep their own authentication flows. The app still
# runs under Bun; Node is present only for the upstream CLI executables.
FROM ${NODE_IMAGE} AS ai-tools
COPY --from=deps /usr/local/bin/bun /usr/local/bin/bun
COPY scripts/collect-image-licenses.mjs /tmp/collect-image-licenses.mjs
ENV BUN_INSTALL=/usr/local
RUN bun add --global @openai/codex@0.158.0 @google/gemini-cli@0.61.0 \
    && codex --version && gemini --version \
    && bun /tmp/collect-image-licenses.mjs --root /usr/local --out /tmp/cli-licenses \
    && bun -e 'const inv=await Bun.file("/tmp/cli-licenses/inventory.json").json(); const names=new Set(inv.packages.map(p=>`${p.name}@${p.version}`)); for (const id of ["@openai/codex@0.158.0","@google/gemini-cli@0.61.0"]) if (!names.has(id)) { console.error("missing "+id); process.exit(1) }'

FROM ai-tools AS filesystem
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    HOME=/home/nextjs \
    CODEX_HOME=/app/.data/auth/codex \
    GEMINI_CLI_HOME=/app/.data/auth/google
# Match the existing deployment's UID/GID for mounted auth and attachment files.
RUN groupadd --system --gid 1001 nodejs && useradd --system --create-home --uid 1001 --gid nodejs nextjs
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs \
    /app/scripts/hash-password.mjs \
    /app/scripts/setup-env.mjs \
    /app/scripts/setup-token.mjs \
    /app/scripts/build-database-url.mjs \
    ./scripts/
# Notices contract uses /app/licenses. The same bytes are also published under
# /usr/share/irang/licenses, with the root LICENSE and third-party notices.
COPY --from=builder /app/app-licenses /app/licenses/app
COPY --from=builder /app/app-licenses /usr/share/irang/licenses/app
COPY --from=ai-tools /tmp/cli-licenses /app/licenses/cli
COPY --from=ai-tools /tmp/cli-licenses /usr/share/irang/licenses/cli
COPY LICENSE THIRD_PARTY_NOTICES.md /app/licenses/
COPY LICENSE THIRD_PARTY_NOTICES.md /usr/share/irang/licenses/
COPY public/fonts/LICENSE-Pretendard.txt /app/licenses/LICENSE-Pretendard.txt
COPY public/fonts/LICENSE-Pretendard.txt /usr/share/irang/licenses/LICENSE-Pretendard.txt
COPY LICENSE /LICENSE
COPY THIRD_PARTY_NOTICES.md /THIRD_PARTY_NOTICES.md
RUN chmod -R a+rX /app/licenses /usr/share/irang /LICENSE /THIRD_PARTY_NOTICES.md \
    && rm -rf /tmp/cli-licenses /tmp/collect-image-licenses.mjs
RUN mkdir -p /app/.data/attachments /app/.data/auth/codex /app/.data/auth/google \
    && chown -R nextjs:nodejs /app/.data && chmod 700 /app/.data/auth
# Source preparation tools live outside this completed target filesystem.
# Nothing from their package installation or download history enters the runner.
FROM ai-tools AS materials
USER root
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates git tar gzip xz-utils patch \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /packaging
COPY distribution/app/native.mjs distribution/app/LGPL-REPLACEMENT.md ./distribution/app/
COPY distribution/runtime ./distribution/runtime/
COPY distribution/release ./distribution/release/
COPY distribution/cli/components.json distribution/cli/grants.json \
    distribution/cli/eastasianwidth-replacement.json distribution/cli/eastasianwidth-REBUILD.md \
    distribution/cli/LINKED-LIBRARIES.txt ./distribution/cli/
COPY distribution/cli/width-inputs ./distribution/cli/width-inputs/
COPY scripts/prepare-release-materials.mjs scripts/prepare-redistribution-runtime.mjs \
    scripts/prepare-redistribution-debian.mjs scripts/prepare-source-assets.mjs \
    scripts/collect-image-licenses.mjs ./scripts/
COPY --from=filesystem / /target/
ARG TARGETARCH
ARG VERSION=2.3.2
ARG REVISION=local
RUN bun --no-env-file scripts/prepare-release-materials.mjs \
    --root /target --out /materials --version "$VERSION" --revision "$REVISION" \
    --platform "linux/$TARGETARCH"

FROM materials AS source-export
RUN bun --no-env-file scripts/prepare-source-assets.mjs \
    --materials /materials --seal "$(sha256sum /target/usr/share/irang/licenses/materials.json | cut -d ' ' -f 1)" \
    --version "$VERSION" --revision "$REVISION" --platform "linux/$TARGETARCH" --out /source-assets

FROM scratch AS source-assets
COPY --from=source-export /source-assets/ /

# Only the completed, repaired filesystem enters any delivered runtime layer.
# Keep this target last so an ordinary docker build produces the application.
FROM scratch AS runner
COPY --from=materials /target/ /
WORKDIR /app
ENV PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    BUN_INSTALL=/usr/local \
    NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    HOME=/home/nextjs \
    CODEX_HOME=/app/.data/auth/codex \
    GEMINI_CLI_HOME=/app/.data/auth/google
USER 1001:1001
ARG VERSION=2.3.2
ARG REVISION=local
LABEL org.opencontainers.image.title="Aro" \
      org.opencontainers.image.description="Aro application image. Third-party notices are in /app/licenses and /usr/share/irang/licenses." \
      org.opencontainers.image.source="https://github.com/madrobotnet/aro" \
      org.opencontainers.image.url="https://github.com/madrobotnet/aro" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.licenses="NOASSERTION"
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --retries=5 CMD bun -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["bun", "server.js"]
