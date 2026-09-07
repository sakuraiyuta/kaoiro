#!/usr/bin/env bash
# `mix test` for server/, with the whole run preserved whenever it fails.
#
# ExUnit prints the seed only in its HEADER line (`Running ExUnit with
# seed: <N>, max_cases: <M>`) and prints neither the seed nor a
# reproduction command at the end of a failing run (measured on Elixir
# 1.20.1), so keeping only the tail of the output discards the one value
# a flake needs to be replayed. The run is teed in full, the path is
# announced before the run starts (an interrupted run stays recoverable),
# and the file survives exactly when the run did not pass.
#
# Arguments are passed through: scripts/mix-test.sh test/foo_test.exs:42
set -euo pipefail

root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
log_dir="$root/server/tmp/mix-test"
mkdir -p "$log_dir"
log="$log_dir/$(date '+%Y%m%d-%H%M%S')-$$.log"
printf 'full output: %s\n' "$log" >&2

# `|| status=$?` is required, not defensive: `set -e` would abort the
# script on the failing pipeline before the status could be read. With
# `pipefail` the pipeline reports mix's own non-zero status, tee having
# succeeded.
status=0
(cd "$root/server" && mix test "$@") 2>&1 | tee "$log" || status=$?

if [ "$status" -eq 0 ]; then
  rm -f "$log"
else
  printf 'kept, run did not pass (exit %s): %s\n' "$status" "$log" >&2
fi

exit "$status"
