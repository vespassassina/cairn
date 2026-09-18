# syntax=docker/dockerfile:1
#
# The Cairn server image (ADR-018, ADR-020, ADR-022): the bundled server,
# Node's built-in SQLite with the sqlite-vec extension, a small English
# embedding model, and Litestream. The database is in /data: a mounted local
# volume on your own server, or restored from and streamed to a replica.
# Built for linux/amd64 and linux/arm64 by CI and published to ghcr.io.

FROM node:24-slim AS build
WORKDIR /src
# On linux/x64, onnxruntime-node's install script downloads NVIDIA CUDA and
# TensorRT libraries. Cairn runs the model on the CPU, and they made the amd64
# image 342 MB against 137 MB for arm64, which Azure pulls on every cold start.
ENV ONNXRUNTIME_NODE_INSTALL=skip
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY examples ./examples
COPY scripts ./scripts
RUN pnpm install --frozen-lockfile
RUN pnpm build:server

# The two dependencies with native code, for this platform only, and the
# model, so the image never downloads anything at runtime (ADR-022).
# transformers.js has the web runtime bundled in, so onnxruntime-web is not
# needed, and ONNX Runtime ships binaries for every platform: keep this one.
WORKDIR /src/dist/server
RUN npm install --omit=dev --no-audit --no-fund \
  && rm -rf node_modules/onnxruntime-web \
  && arch="$(node -p process.arch)" \
  && find node_modules/onnxruntime-node/bin -mindepth 3 -maxdepth 3 -type d ! -path "*/linux/${arch}" -exec rm -rf {} + \
  && node fetch-model.mjs /src/dist/server/models

# Built from source at a pinned commit on an open, unmerged upstream PR
# (ADR-062), not from a release: issue #1515 is a confirmed bug in every
# released 0.5.x build (0.5.14 through 0.5.17, the version this image ran
# before) where the follower's gap-bridging logic never consults the L9
# snapshot, so a stall it cannot bridge is silent and survives a restart.
# PR #1514 (darkgnotic/litestream, branch snapshot_compaction_coordination)
# adds fillFollowGapFromSnapshot, which lets it consult L9; the bug's own
# reporter confirmed it resolves #1515. No release carries this fix yet.
# Revert to the pinned-release-tarball model (see git history) once
# benbjohnson/litestream ships a tagged version with the fix.
FROM golang:1-bookworm AS litestream-build
ARG LITESTREAM_FORK=darkgnotic/litestream
ARG LITESTREAM_COMMIT=9dad482c64a0d156fea1ff8c07b56cd288b07035
RUN git clone --no-checkout "https://github.com/${LITESTREAM_FORK}.git" /src \
  && cd /src \
  && git checkout "$LITESTREAM_COMMIT" \
  && CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.Version=${LITESTREAM_COMMIT}" \
       -o /usr/local/bin/litestream ./cmd/litestream

FROM debian:bookworm-slim AS litestream
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY --from=litestream-build /usr/local/bin/litestream /usr/local/bin/litestream

FROM node:24-slim
ENV NODE_ENV=production \
    CAIRN_HOST=0.0.0.0 \
    CAIRN_PORT=8787 \
    CAIRN_DB=/data/cairn.sqlite \
    CAIRN_EMBEDDINGS=local \
    CAIRN_MODELS=/app/models \
    CAIRN_MODEL_DOWNLOAD=false
WORKDIR /app
COPY --from=build /src/dist/server/ ./
COPY --from=litestream /usr/local/bin/litestream /usr/local/bin/litestream
# Litestream is a Go program and verifies TLS against the system's CA
# certificates, which node:24-slim does not have (Node carries its own). Without
# them every replica request fails with "certificate signed by unknown
# authority" (docs/LESSONS.md).
COPY --from=litestream /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY docker/start.sh /app/start.sh
RUN mkdir -p /data && chown node:node /data && chmod 0755 /app/start.sh
USER node
EXPOSE 8787
CMD ["/app/start.sh"]
