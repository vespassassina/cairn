#!/bin/sh
# Start Cairn in its container (ADR-018).
#
# With CAIRN_REPLICA_URL set (abs://ACCOUNT@CONTAINER/PATH on Azure), the
# database is restored from Blob Storage if a copy exists, then Cairn runs
# under Litestream, which streams every change back. Without it, the
# database lives only in the container and is lost when it stops.
set -eu

DB="${CAIRN_DB:-/data/cairn.sqlite}"

if [ -z "${CAIRN_REPLICA_URL:-}" ]; then
  echo "warning: CAIRN_REPLICA_URL is not set, so the database is not backed up anywhere" >&2
  exec node /app/server.mjs
fi

# Access to storage can take a minute to arrive after a first deploy, while
# Azure grants the app's identity its role. Retry rather than give up.
attempt=1
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
