#!/bin/sh
# Runs the interactive runner setup wizard (issue #144), which writes
# runner.config.json and runner.env into the OS user config dir.
#
# Companion to kaoiro-runner-launch.sh: same node resolution, but it does NOT
# source the env file — this is what creates it.
#
# Exit 78 (EX_CONFIG) means the wizard could not start (no node, not built, no
# terminal). The wizard itself refuses to run without a TTY, since a prompt
# under systemd / launchd would hang forever.
set -eu

die_config() {
  printf 'kaoiro-runner-setup: %s\n' "$1" >&2
  exit 78
}

node_bin="${KAOIRO_NODE:-node}"
command -v "$node_bin" >/dev/null 2>&1 ||
  die_config "node not found: $node_bin (set KAOIRO_NODE)"

# <install>/runner/deploy/<this script> -> <install>/runner/dist/setup-cli.js
unset CDPATH
deploy_dir=$(cd -- "$(dirname -- "$0")" && pwd)
entry="$deploy_dir/../dist/setup-cli.js"
[ -f "$entry" ] ||
  die_config "wizard not built: $entry (run 'pnpm -C runner build')"

exec "$node_bin" "$entry" "$@"
