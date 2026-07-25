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

# KAOIRO_RUNNER_TOKEN and any overrides live in the env file, which is SOURCED
# — so it must be valid shell (plain KEY=VALUE; quote values with spaces).
# `set -a` exports every assignment it makes; nothing is echoed, so the token
# stays out of journald / the launchd log.
#
# The file's 0600 mode is the operator's responsibility and deliberately NOT
# enforced here: portable mode inspection differs per OS (GNU vs BSD `stat`),
# and refusing to start would break hosts that legitimately use ACLs. README
# states the requirement.
if [ -f "$env_file" ]; then
  # Validate before sourcing: `.` on a syntactically broken file aborts this
  # shell with the shell's own status under `set -e`, bypassing die_config —
  # and with it the unit's RestartPreventExitStatus=78, so systemd would treat
  # a typo as a crash and restart-loop. Fail as a config error instead.
  sh -n "$env_file" 2>/dev/null ||
    die_config "env file is not valid shell: $env_file"
  set -a
  # shellcheck source=/dev/null
  . "$env_file"
  set +a
fi

# Resolve our own directory before the config check: it is needed both for the
# entry point and for naming the setup wizard when the config is missing.
# (unset CDPATH so a stray value in the env file cannot redirect the cd)
unset CDPATH
deploy_dir=$(cd -- "$(dirname -- "$0")" && pwd)

# A missing config is the first-run case. Point at the wizard rather than
# launching it: this script also runs from systemd / launchd, where an
# interactive prompt would hang with no terminal (issue #144).
config="${KAOIRO_RUNNER_CONFIG:-$conf_dir/runner.config.json}"
if [ ! -f "$config" ]; then
  printf 'kaoiro-runner: config not found: %s\n' "$config" >&2
  printf 'kaoiro-runner: run %s to create it\n' \
    "$deploy_dir/kaoiro-runner-setup.sh" >&2
  exit 78
fi

# systemd user units and launchd agents start with a minimal PATH, so a
# version-managed node (nvm / fnm / asdf) has to be pinned via KAOIRO_NODE.
node_bin="${KAOIRO_NODE:-node}"
command -v "$node_bin" >/dev/null 2>&1 ||
  die_config "node not found: $node_bin (set KAOIRO_NODE in $env_file)"

# <install>/runner/deploy/<this script> -> <install>/runner/dist/cli.js
entry="$deploy_dir/../dist/cli.js"
[ -f "$entry" ] ||
  die_config "runner not built: $entry (run 'pnpm -C runner build')"

# Single-binary migration (issue #70): replace the line below with
#   exec "$deploy_dir/../bin/kaoiro-runner" "$config"
exec "$node_bin" "$entry" "$config"
