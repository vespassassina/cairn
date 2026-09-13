#!/bin/sh
# Start Cairn in its container (ADR-018, ADR-020).
#
# Two ways to keep the database:
#
# 1. A mounted volume at /data, on your own server. The database lives on
#    that disk and survives the container. CAIRN_REPLICA_URL is optional.
# 2. CAIRN_REPLICA_URL (abs://ACCOUNT@CONTAINER/PATH on Azure, or s3://...).
#    The database is restored from the replica if there is no local copy,
#    then Cairn runs under Litestream, which streams every change back.
#
# With neither, the database is lost when the container is removed.
set -eu

DB="${CAIRN_DB:-/data/cairn.sqlite}"
DIR="$(dirname "$DB")"

if [ ! -w "$DIR" ]; then
  echo "error: $DIR is not writable by user $(id -u). Give the mounted folder to uid $(id -u), for example: chown $(id -u):$(id -g) /path/on/host" >&2
  exit 1
fi

if [ -z "${CAIRN_REPLICA_URL:-}" ]; then
  if grep -qs " $DIR " /proc/mounts; then
    echo "database: $DB, on a mounted volume, with no replica"
  else
    echo "warning: $DIR is not a mounted volume and CAIRN_REPLICA_URL is not set, so the database is lost when this container is removed" >&2
  fi
  exec node /app/server.mjs
fi

# Access to storage can take a minute to arrive after a first deploy, while
# Azure grants the app's identity its role. Retry rather than give up.
# Litestream retries network errors itself for minutes before it reports
# one, so say what is being tried before each attempt.
attempt=1
echo "restoring $DB from $CAIRN_REPLICA_URL, if it has a copy"
until litestream restore -if-db-not-exists -if-replica-exists -o "$DB" "$CAIRN_REPLICA_URL"; do
  if [ "$attempt" -ge 12 ]; then
    echo "error: could not read the replica at $CAIRN_REPLICA_URL after $attempt attempts" >&2
    exit 1
  fi
  echo "restore attempt $attempt failed; retrying in 10 seconds" >&2
  attempt=$((attempt + 1))
  sleep 10
done

# Flags must come before the paths.
exec litestream replicate -exec "node /app/server.mjs" "$DB" "$CAIRN_REPLICA_URL"
