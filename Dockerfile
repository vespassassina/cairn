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

FROM debian:bookworm-slim AS litestream
ARG TARGETARCH
# Pinned, and checked against the checksums published with the release.
# Keep this current: 0.5 is a rewrite, and the corruption and restore fixes
# land in patch releases (ADR-046).
ARG LITESTREAM_VERSION=0.5.17
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*
RUN set -eu; \
  case "$TARGETARCH" in \
    amd64) file="litestream-${LITESTREAM_VERSION}-linux-x86_64.tar.gz"; \
           sum="cfb371176d164437ae869f8351cfde49bd1804ae71c61923f75c9cba9c9c006d" ;; \
    arm64) file="litestream-${LITESTREAM_VERSION}-linux-arm64.tar.gz"; \
           sum="f8ca4a050095c1efbda2c4365172e61bf9d955ea0d9ac42f448b52e51819baa5" ;; \
    *) echo "no Litestream build for $TARGETARCH" >&2; exit 1 ;; \
  esac; \
  curl -fsSL -o /tmp/litestream.tar.gz \
    "https://github.com/benbjohnson/litestream/releases/download/v${LITESTREAM_VERSION}/${file}"; \
  echo "${sum}  /tmp/litestream.tar.gz" | sha256sum -c -; \
  mkdir -p /tmp/litestream && tar -xzf /tmp/litestream.tar.gz -C /tmp/litestream; \
  install -m 0755 "$(find /tmp/litestream -type f -name litestream | head -n 1)" /usr/local/bin/litestream

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
