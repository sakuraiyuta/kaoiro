#!/bin/sh
# Launch shim for the kaoiro runner service (systemd user unit / launchd
# LaunchAgent — see runner/README.md「常駐化」). It exists so that:
#
#   1. the auth token never appears in a unit / plist file: it is read from a
#      0600 env file at service start instead,
#   2. env / config resolution lives in ONE place for both OSes,
#   3. the single-binary migration (issue #70, ADR-0018) is a one-line change
#      here (the final `exec`), leaving both service definitions untouched.
#
# Exit 78 (EX_CONFIG) marks a misconfiguration a restart cannot fix; the
# systemd unit maps it to RestartPreventExitStatus so the service stays failed
# instead of looping.
set -eu

die_config() {
  printf 'kaoiro-runner: %s\n' "$1" >&2
  exit 78
}

# Per-OS user config dir (ADR-0018). KAOIRO_RUNNER_DIR overrides it, but must
# come from the service definition's environment rather than the env file
# below — that file's own location depends on it.
if [ "$(uname -s)" = "Darwin" ]; then
  default_dir="$HOME/Library/Application Support/kaoiro"
else
  default_dir="${XDG_CONFIG_HOME:-$HOME/.config}/kaoiro"
fi
conf_dir="${KAOIRO_RUNNER_DIR:-$default_dir}"
env_file="${KAOIRO_RUNNER_ENV:-$conf_dir/runner.env}"

# KAOIRO_RUNNER_TOKEN and any overrides live in the 0600 env file. `set -a`
# exports every assignment it makes; nothing is echoed, so the token stays out
# of journald / the launchd log.
if [ -f "$env_file" ]; then
  set -a
  # shellcheck source=/dev/null
  . "$env_file"
  set +a
fi

config="${KAOIRO_RUNNER_CONFIG:-$conf_dir/runner.config.json}"
[ -f "$config" ] || die_config "config not found: $config"

# systemd user units and launchd agents start with a minimal PATH, so a
# version-managed node (nvm / fnm / asdf) has to be pinned via KAOIRO_NODE.
node_bin="${KAOIRO_NODE:-node}"
command -v "$node_bin" >/dev/null 2>&1 ||
  die_config "node not found: $node_bin (set KAOIRO_NODE in $env_file)"

# <install>/runner/deploy/<this script> -> <install>/runner/dist/cli.js
# (unset CDPATH so a stray value in the env file cannot redirect the cd)
unset CDPATH
deploy_dir=$(cd -- "$(dirname -- "$0")" && pwd)
entry="$deploy_dir/../dist/cli.js"
[ -f "$entry" ] ||
  die_config "runner not built: $entry (run 'pnpm -C runner build')"

# Single-binary migration (issue #70): replace the line below with
#   exec "$deploy_dir/../bin/kaoiro-runner" "$config"
exec "$node_bin" "$entry" "$config"
