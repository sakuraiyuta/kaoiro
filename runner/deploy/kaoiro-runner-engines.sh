#!/bin/sh
set -eu
unset CDPATH
deploy_dir=$(cd -P -- "$(dirname -- "$0")" && pwd -P)
# shellcheck disable=SC2034 # Used by kaoiro_die in the sourced helper.
prog=kaoiro-runner-engines
# shellcheck source=kaoiro-runner-common.sh
. "$deploy_dir/kaoiro-runner-common.sh"
conf_dir=$(kaoiro_config_dir)
env_file=${KAOIRO_RUNNER_ENV:-$conf_dir/runner.env}
if [ -f "$env_file" ]; then
  sh -n "$env_file" 2>/dev/null || kaoiro_die "invalid env file: $env_file" 78
  set -a
  # shellcheck source=/dev/null
  . "$env_file"
  set +a
fi
KAOIRO_RUNNER_CONFIG=${KAOIRO_RUNNER_CONFIG:-$conf_dir/runner.config.json}
export KAOIRO_RUNNER_CONFIG
node_bin=$(kaoiro_node)
exec "$node_bin" "$deploy_dir/../dist/kaoiro.js" engines "$@"
