#!/usr/bin/env sh
# Resolves the megaprobe CLI relative to this script, wherever the plugin is installed.
DIR="$(cd "$(dirname "$0")" && pwd)"
exec node "$DIR/../../../../src/cli.ts" "$@"
