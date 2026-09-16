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
  exec node "${CAIRN_APP_DIR:-/app}/server.mjs"
fi

say "litestream $(litestream version 2>/dev/null || echo '(version unknown)')"
say "replica: $CAIRN_REPLICA_URL"

# Everything from here is the recovery ladder (ADR-051), and it lives in Node
# rather than in this script because it needs the replica, the backup archive
# and SQLite itself. In order: the local database if it is sound, a plain
# restore, the newest point in the replica that restores and passes its
# integrity check, then the newest backup that does. It exits non-zero when it
# has nothing it can vouch for, and this script stops with it, because ADR-046's
# rule still holds: never serve, and never replicate, a database we cannot
# vouch for.
if ! node "${CAIRN_APP_DIR:-/app}/recover.mjs"; then
  exit 1
fi

# Flags must come before the paths.
exec litestream replicate -exec "node ${CAIRN_APP_DIR:-/app}/server.mjs" "$DB" "$CAIRN_REPLICA_URL"
