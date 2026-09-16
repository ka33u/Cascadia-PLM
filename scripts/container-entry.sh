#!/bin/sh
set -eu
node dist/migrate.mjs
node dist/setup.mjs
exec node dist/server.mjs
