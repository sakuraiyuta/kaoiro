# shellcheck shell=bash
# Shared launcher-owned runner pairing helpers.

pairing_host_id() {
  local config="$1" host_id

  host_id="$(node -e \
    'process.stdout.write(String(require(process.argv[1]).host_id ?? ""))' \
    "$config")" || {
    echo "runner pairing: error — cannot read host_id from $config" >&2
    return 1
  }
  if [[ ! "$host_id" =~ ^[A-Za-z0-9._-]+$ ]]; then
    echo "runner pairing: error — host_id in $config must match" \
      "[A-Za-z0-9._-]+" >&2
    return 1
  fi
  printf '%s\n' "$host_id"
}

pairing_ensure_runner_env() {
  local path="$1" token line extra

  if [[ ! -e "$path" ]]; then
    token="$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")" || {
      echo "runner pairing: error — runner token generation failed" >&2
      return 1
    }
    if [[ ! "$token" =~ ^[0-9a-f]{64}$ ]]; then
      echo "runner pairing: error — runner token generation failed" >&2
      return 1
    fi
    (umask 077; printf 'KAOIRO_RUNNER_TOKEN=%s\n' "$token" >"$path") || return 1
    printf '%s\n' "$token"
    return 0
  fi

  exec 3<"$path" || return 1
  if ! IFS= read -r line <&3 && [[ -z "$line" ]]; then
    exec 3<&-
    echo "runner pairing: error — $path is not in the launcher format; fix or delete it" >&2
    return 1
  fi
  if IFS= read -r extra <&3 || [[ -n "$extra" ]]; then
    exec 3<&-
    echo "runner pairing: error — $path is not in the launcher format; fix or delete it" >&2
    return 1
  fi
  exec 3<&-
  line="${line%$'\r'}"
  if [[ "$line" =~ ^KAOIRO_RUNNER_TOKEN=([0-9a-f]{64})$ ]]; then
    token="${BASH_REMATCH[1]}"
  elif [[ "$line" =~ ^KAOIRO_RUNNER_TOKEN=\'([0-9a-f]{64})\'$ ]]; then
    token="${BASH_REMATCH[1]}"
  elif [[ "$line" =~ ^KAOIRO_RUNNER_TOKEN=\"([0-9a-f]{64})\"$ ]]; then
    token="${BASH_REMATCH[1]}"
  else
    echo "runner pairing: error — $path is not in the launcher format; fix or delete it" >&2
    return 1
  fi
  printf '%s\n' "$token"
}

pairing_check_token() {
  local token="$1"

  if [[ ! "$token" =~ ^[A-Za-z0-9._~+/=:-]{16,}$ ]]; then
    echo "runner pairing: error — KAOIRO_RUNNER_TOKEN must match" \
      "[A-Za-z0-9._~+/=:-]{16,}" >&2
    return 1
  fi
}

pairing_append() {
  local list="$1" host_id="$2" token="$3"

  if [[ -z "$list" ]]; then
    printf '%s:%s' "$host_id" "$token"
  else
    printf '%s,%s:%s' "$list" "$host_id" "$token"
  fi
}
