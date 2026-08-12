#!/bin/sh
# Start as root only long enough to make the database directory writable, then
# drop to the unprivileged `node` user and exec the app.
#
# Why this exists: hosts mount persistent volumes root-owned (Railway bind-mounts
# them, and so do plenty of others). A container that runs as a non-root user
# from the start cannot create its database in such a mount and dies with
# "unable to open database file". Fixing ownership here keeps the runtime
# unprivileged without depending on how the host happens to mount the volume.
set -e

DB_DIR=$(dirname "${DATABASE_PATH:-/data/bot.sqlite}")

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DB_DIR"
  chown -R node:node "$DB_DIR" || echo "warning: could not chown $DB_DIR" >&2
  # exec so node replaces this shell as PID 1 and receives SIGTERM directly —
  # the graceful shutdown path depends on it.
  exec setpriv --reuid=node --regid=node --init-groups "$@"
fi

# Already unprivileged (a host that pins the user). Nothing to fix; just run.
exec "$@"
