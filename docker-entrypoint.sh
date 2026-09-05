#!/bin/sh
# Runs as root under tini, then drops to the unprivileged `node` user for the
# server and everything it spawns (the ob sync daemon, git, git-lfs). See
# SECURITY.md, "Running as non-root". Root is kept only long enough to make
# the data directory writable by that user, which a Railway volume mounted
# for the first time — or one written by a version of this image that ran as
# root — is not. Ownership is changed only when it has to be: on a healthy
# volume the check is one stat, and a vault of thousands of files is not
# walked on every boot.
set -eu
DATA_DIR="${DATA_DIR:-/data}"
mkdir -p "$DATA_DIR"
if ! setpriv --reuid=node --regid=node --init-groups test -w "$DATA_DIR"; then
  echo "[entrypoint] making $DATA_DIR writable by node" >&2
  chown -R node:node "$DATA_DIR"
fi
exec setpriv --reuid=node --regid=node --init-groups "$@"
