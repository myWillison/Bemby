#!/bin/sh
# Fix ownership of the (possibly bind-mounted) data dir as root, then drop to the
# non-root `node` user so the app never runs with root privileges.
set -e

if [ "$(id -u)" = "0" ]; then
  mkdir -p /app/data
  chown -R node:node /app/data
  exec su-exec node "$@"
fi

exec "$@"
