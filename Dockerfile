# ── Stage 1: Build ─────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

# Native build tools required for better-sqlite3
RUN apk add --no-cache python3 make g++

WORKDIR /build

# Copy workspace manifests first — maximises layer cache on dep changes
COPY package.json package-lock.json ./
COPY packages/protocol/package.json ./packages/protocol/
COPY packages/server/package.json   ./packages/server/
COPY packages/plugin/package.json   ./packages/plugin/

RUN npm ci

# Copy source
COPY tsconfig.base.json ./
COPY packages/protocol/  ./packages/protocol/
COPY packages/server/    ./packages/server/
COPY packages/plugin/    ./packages/plugin/

# Compile protocol, then server, then the plugin bundle. The plugin build's
# post-build step copies main.js/styles.css/manifest.json/build_info.json into
# packages/server/client/ — that is what powers device auto-update, so the
# plugin MUST be built here rather than relying on artifacts from the host
# working tree (which .dockerignore excludes).
ARG IONSYNC_SIGN_KEY=""
RUN npm run build -w packages/protocol
RUN npm run build -w packages/server
RUN IONSYNC_SIGN_KEY="$IONSYNC_SIGN_KEY" npm run build -w packages/plugin

# Drop dev dependencies before we copy node_modules to the runtime stage
RUN npm prune --omit=dev

# ── Stage 2: Runtime ───────────────────────────────────────────────────────
FROM node:20-alpine

WORKDIR /app

# Production node_modules (native binaries already compiled for Alpine)
COPY --from=builder /build/node_modules ./node_modules

# Replace the npm workspace symlink for @ionsync/protocol with the actual
# compiled package so the runtime stage doesn't need the full monorepo tree.
RUN rm -rf node_modules/@ionsync
COPY --from=builder /build/packages/protocol/dist        ./node_modules/@ionsync/protocol/dist
COPY --from=builder /build/packages/protocol/package.json ./node_modules/@ionsync/protocol/package.json

# Server artefacts
COPY --from=builder /build/packages/server/dist  ./dist
COPY --from=builder /build/packages/server/client ./client

# Entrypoint — generates /app/config.js from env vars when no file is mounted
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 3000

# /data holds the SQLite database and versioned file storage
VOLUME ["/data"]

ENTRYPOINT ["docker-entrypoint.sh"]
