#!/bin/sh
# Start Cairn in its container (ADR-018, ADR-020, ADR-046).
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
#
# One rule governs the replica path (ADR-046): never serve, and never
# replicate, a database that did not pass its integrity check. Starting empty
# or half-read would stream that state straight back over the only good copy,
# so a database we cannot vouch for stops the container instead.
set -eu

DB="${CAIRN_DB:-/data/cairn.sqlite}"
DIR="$(dirname "$DB")"

say() { echo "cairn: $*"; }
oops() { echo "cairn: $*" >&2; }

# What SQLite makes of the database at $DB. Prints its size and page count,
# and fails when the file is truncated, malformed or unreadable. Node's
# built-in sqlite, so the image gains nothing by this.
check_db() {
  node -e '
const fs = require("fs");
const { DatabaseSync } = require("node:sqlite");
const file = process.argv[1];
let db;
try {
  const bytes = fs.statSync(file).size;
  db = new DatabaseSync(file, { readOnly: true });
  const row = db.prepare("pragma integrity_check").get();
  const verdict = row && row.integrity_check;
  const pages = db.prepare("pragma page_count").get().page_count;
  if (verdict !== "ok") {
    console.error("cairn: integrity_check on " + file + " said: " + verdict);
    process.exit(1);
  }
  console.log("cairn: " + file + " is sound, " + bytes + " bytes in " + pages + " pages");
} catch (error) {
  console.error("cairn: cannot read " + file + ": " + error.message);
  process.exit(1);
} finally {
  if (db) { try { db.close(); } catch (ignored) {} }
}
' "$DB"
}

say "starting, database $DB"

if [ ! -w "$DIR" ]; then
  oops "error: $DIR is not writable by user $(id -u). Give the mounted folder to uid $(id -u), for example: chown $(id -u):$(id -g) /path/on/host"
  exit 1
fi

if [ -z "${CAIRN_REPLICA_URL:-}" ]; then
  if grep -qs " $DIR " /proc/mounts; then
    say "database: $DB, on a mounted volume, with no replica"
  else
    oops "warning: $DIR is not a mounted volume and CAIRN_REPLICA_URL is not set, so the database is lost when this container is removed"
  fi
  if [ -f "$DB" ] && ! check_db; then
    oops "error: $DB did not pass its integrity check, so Cairn will not open it."
    oops "Stop this container, then either restore $DIR from a backup, or move $DB aside and import an export with: cairn import <folder>"
    exit 1
  fi
  exec node /app/server.mjs
fi

say "litestream $(litestream version 2>/dev/null || echo '(version unknown)')"
say "replica: $CAIRN_REPLICA_URL"

# Access to storage can take a minute to arrive after a first deploy, while
# Azure grants the app's identity its role, and a network error is worth
# another try. A replica that cannot be decoded is neither of those: retrying
# it only burns the restart and hides the reason, so stop at the first one and
# say what is wrong (ADR-046).
attempt=1
limit=12
restore_log="$(mktemp)"

say "restoring $DB from the replica, if it has a copy"
while :; do
  if litestream restore -if-db-not-exists -if-replica-exists -o "$DB" "$CAIRN_REPLICA_URL" >"$restore_log" 2>&1; then
    if [ -s "$restore_log" ]; then cat "$restore_log"; fi
    break
  fi
  cat "$restore_log" >&2
  if grep -qiE 'decode|corrupt|malformed|checksum|EOF' "$restore_log"; then
    oops "error: the replica at $CAIRN_REPLICA_URL cannot be read back: its copy of the database is damaged."
    oops "No number of restarts will change that, so Cairn stops here rather than start on data it cannot vouch for."
    oops "What is in the replica, for the record:"
    litestream ltx -level all "$CAIRN_REPLICA_URL" >&2 || oops "(litestream ltx could not list it either)"
    oops "Next steps, in the order worth trying:"
    oops "1. Restore an earlier point in time deliberately, picking a timestamp from the list above:"
    oops "     litestream restore -timestamp <RFC3339> -o $DB $CAIRN_REPLICA_URL"
    oops "2. If another Cairn holds this workspace, take it from there instead:"
    oops "     cairn export <folder>   on the Cairn that has the data"
    oops "     cairn import <folder>   into this one, once it is running"
    oops "3. Redeploy with an empty database only once you are certain nothing else"
    oops "   holds a newer copy, because the first write overwrites the replica."
    exit 1
  fi
  if [ "$attempt" -ge "$limit" ]; then
    oops "error: could not reach the replica at $CAIRN_REPLICA_URL after $attempt attempts over $((limit * 10)) seconds. This reads as a network or permission problem rather than damaged data. Check that the app's managed identity still holds Storage Blob Data Contributor on that account, and that the storage account allows this container's network."
    exit 1
  fi
  say "restore attempt $attempt failed, and looks temporary; retrying in 10 seconds"
  attempt=$((attempt + 1))
  sleep 10
done

if [ -f "$DB" ]; then
  if ! check_db; then
    oops "error: the database restored from $CAIRN_REPLICA_URL did not pass its integrity check."
    oops "Cairn stops rather than replicate it, because streaming a damaged database back would overwrite the replica's own history."
    oops "What is in the replica, for the record:"
    litestream ltx -level all "$CAIRN_REPLICA_URL" >&2 || oops "(litestream ltx could not list it either)"
    oops "Restore an earlier point in time deliberately with: litestream restore -timestamp <RFC3339> -o $DB $CAIRN_REPLICA_URL"
    exit 1
  fi
else
  say "the replica holds no database yet, so this Cairn starts empty and becomes its first copy"
fi

# Flags must come before the paths.
exec litestream replicate -exec "node /app/server.mjs" "$DB" "$CAIRN_REPLICA_URL"
