# syntax=docker/dockerfile:1
#
# The Cairn server image (ADR-018): the bundled server, Node's built-in
# SQLite, and Litestream streaming the database to Azure Blob Storage.
# Built for linux/amd64 and linux/arm64 by CI and published to ghcr.io.

FROM node:24-slim AS build
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY examples ./examples
COPY scripts ./scripts
RUN pnpm install --frozen-lockfile
RUN pnpm build:server

FROM debian:bookworm-slim AS litestream
ARG TARGETARCH
# Pinned, and checked against the checksums published with the release.
ARG LITESTREAM_VERSION=0.5.7
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*
RUN set -eu; \
  case "$TARGETARCH" in \
    amd64) file="litestream-${LITESTREAM_VERSION}-linux-x86_64.tar.gz"; \
           sum="e62260ec49343272bea635ea8462d36d00fff0bbef27835dcfabd667ddf184c5" ;; \
    arm64) file="litestream-${LITESTREAM_VERSION}-linux-arm64.tar.gz"; \
           sum="fb53828660808a8a03dfd511b2c6bf498cfc73691ca888cf8beb7b4c435e150d" ;; \
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
    CAIRN_DB=/data/cairn.sqlite
WORKDIR /app
COPY --from=build /src/dist/server/ ./
COPY --from=litestream /usr/local/bin/litestream /usr/local/bin/litestream
COPY docker/start.sh /app/start.sh
RUN mkdir -p /data && chown node:node /data && chmod 0755 /app/start.sh
USER node
EXPOSE 8787
CMD ["/app/start.sh"]
