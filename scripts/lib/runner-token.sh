# shellcheck shell=bash
# Shared by scripts/dev.sh and scripts/dogfood.sh.
#
# runner_token_for_host HOST_ID
#   Reads a KAOIRO_RUNNER_TOKENS value ("host_id:token,...") on stdin and
#   prints the token paired with HOST_ID, or nothing when there is none.
#   Mirrors the server's Auth.parse_pairs/1: split on ",", split each pair
#   on the FIRST ":" only (a token may contain ":"), reject raw empty keys and
#   values before ASCII space/tab trimming, and let the last entry for a host
#   win. Non-ASCII whitespace (such as NBSP) is unsupported here, so this
#   compatibility claim is limited to ASCII space/tab trimming, first-colon
#   splitting, last-wins replacement, and pre-trim empty checks. The list
#   travels on stdin, never argv, so it stays out of the process list. Trailing
#   CR/LF is removed; a remaining CR/LF rejects the whole list.
runner_token_for_host() {
  local host_id="$1" raw pair key value found=""

  raw=$(cat)
  while [[ "$raw" == *$'\r' || "$raw" == *$'\n' ]]; do
    raw="${raw%$'\r'}"
    raw="${raw%$'\n'}"
  done
  [[ "$raw" == *$'\r'* || "$raw" == *$'\n'* ]] && return 0

  while [[ "$raw" == *,* ]]; do
    pair="${raw%%,*}"
    raw="${raw#*,}"
    if [[ "$pair" == *:* ]]; then
      key="${pair%%:*}"
      value="${pair#*:}"
      if [[ -n "$key" && -n "$value" ]]; then
        key="${key#"${key%%[!$' \t']*}"}"
        key="${key%"${key##*[!$' \t']}"}"
        value="${value#"${value%%[!$' \t']*}"}"
        value="${value%"${value##*[!$' \t']}"}"
        [[ "$key" == "$host_id" ]] && found="$value"
      fi
    fi
  done

  if [[ "$raw" == *:* ]]; then
    key="${raw%%:*}"
    value="${raw#*:}"
    if [[ -n "$key" && -n "$value" ]]; then
      key="${key#"${key%%[!$' \t']*}"}"
      key="${key%"${key##*[!$' \t']}"}"
      value="${value#"${value%%[!$' \t']*}"}"
      value="${value%"${value##*[!$' \t']}"}"
      [[ "$key" == "$host_id" ]] && found="$value"
    fi
  fi

  [[ -n "$found" ]] && printf '%s\n' "$found"
  return 0
}
