# shellcheck shell=bash
# Shared by scripts/dev.sh and scripts/dogfood.sh.
#
# runner_token_for_host HOST_ID
#   Reads a KAOIRO_RUNNER_TOKENS value ("host_id:token,...") on stdin and
#   prints the token paired with HOST_ID, or nothing when there is none. Its
#   stdin is the exact value the server receives as an environment variable;
#   callers must not append a record-terminating newline.
#   Mirrors the server's Auth.parse_pairs/1: split on ",", split each pair
#   on the FIRST ":" only (a token may contain ":"), reject raw empty keys and
#   values before ASCII whitespace trimming, and let the last entry for a host
#   win. Non-ASCII whitespace (such as NBSP) is unsupported here, so this
#   compatibility claim is limited to ASCII space/tab/CR/LF trimming,
#   first-colon splitting, last-wins replacement, and pre-trim empty checks.
#   The list travels on stdin, never argv, so it stays out of the process list.
#   CR/LF is allowed only as trailing whitespace; a remaining CR/LF rejects the
#   whole list without returning a stale token.
runner_token_for_host() {
  local host_id="$1" raw normalized pair key value found=""

  IFS= read -r -d '' raw || true
  normalized="$raw"
  while [[ "$normalized" == *$'\r' || "$normalized" == *$'\n' ]]; do
    normalized="${normalized%$'\r'}"
    normalized="${normalized%$'\n'}"
  done
  [[ "$normalized" == *$'\r'* || "$normalized" == *$'\n'* ]] && return 0

  while [[ "$raw" == *,* ]]; do
    pair="${raw%%,*}"
    raw="${raw#*,}"
    if [[ "$pair" == *:* ]]; then
      key="${pair%%:*}"
      value="${pair#*:}"
      if [[ -n "$key" && -n "$value" ]]; then
        key="${key#"${key%%[!$' \t\r\n']*}"}"
        key="${key%"${key##*[!$' \t\r\n']}"}"
        value="${value#"${value%%[!$' \t\r\n']*}"}"
        value="${value%"${value##*[!$' \t\r\n']}"}"
        [[ "$key" == "$host_id" ]] && found="$value"
      fi
    fi
  done

  if [[ "$raw" == *:* ]]; then
    key="${raw%%:*}"
    value="${raw#*:}"
    if [[ -n "$key" && -n "$value" ]]; then
      key="${key#"${key%%[!$' \t\r\n']*}"}"
      key="${key%"${key##*[!$' \t\r\n']}"}"
      value="${value#"${value%%[!$' \t\r\n']*}"}"
      value="${value%"${value##*[!$' \t\r\n']}"}"
      [[ "$key" == "$host_id" ]] && found="$value"
    fi
  fi

  [[ -n "$found" ]] && printf '%s\n' "$found"
  return 0
}

# runner_tokens_from_env_file FILE
#   Prints the value from the last KAOIRO_RUNNER_TOKENS assignment, without its
#   record terminator. Leading whitespace before the key is accepted; comments
#   are not assignments. Matching outer quotes are removed.
runner_tokens_from_env_file() {
  local env_file="$1" line value="" found=0

  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    if [[ "$line" =~ ^[[:space:]]*KAOIRO_RUNNER_TOKENS=(.*)$ ]]; then
      value="${BASH_REMATCH[1]}"
      if [[ "$value" == \"*\" || "$value" == \'*\' ]]; then
        value="${value:1:${#value}-2}"
      fi
      found=1
    fi
  done < "$env_file"

  [[ "$found" -eq 1 ]] && printf '%s' "$value"
  return 0
}
