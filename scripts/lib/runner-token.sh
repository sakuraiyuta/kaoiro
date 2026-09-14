# shellcheck shell=bash
# Shared by scripts/dev.sh and scripts/dogfood.sh.
#
# runner_token_for_host HOST_ID
#   Reads a KAOIRO_RUNNER_TOKENS value ("host_id:token,...") on stdin and
#   prints the token paired with HOST_ID, or nothing when there is none.
#   Mirrors the server's Auth.parse_pairs/1: split on ",", split each pair
#   on the FIRST ":" only (a token may contain ":"), trim both sides, and
#   let the last entry for a host win. The list travels on stdin, never
#   argv, so it stays out of the process list; the host id goes through
#   ENVIRON rather than `awk -v`, which would interpret backslash escapes.
runner_token_for_host() {
  RUNNER_TOKEN_HOST="$1" awk -F, '{
    for (i = 1; i <= NF; i++) {
      at = index($i, ":")
      if (at == 0) continue
      key = substr($i, 1, at - 1)
      value = substr($i, at + 1)
      gsub(/^[ \t]+|[ \t]+$/, "", key)
      gsub(/^[ \t]+|[ \t]+$/, "", value)
      if (key != "" && value != "" && key == ENVIRON["RUNNER_TOKEN_HOST"]) {
        found = value
      }
    }
  } END { if (found != "") print found }'
}
