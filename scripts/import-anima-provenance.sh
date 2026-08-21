#!/usr/bin/env bash
# Import sanitized generation provenance from the Anima dir into
# persona-packs/<id>/provenance/<state>.json (issue 173).
#
# Usage: scripts/import-anima-provenance.sh <id> [--anima-dir <dir>]
#
# For each of the 7 states, finds the pre-rembg source PNG under
# assets-work/, matches it against the Anima dir by sha256 (state ->
# job_id is decided by content, never by eyeballing), then sanitizes the
# matched Anima json through a fixed allowlist and writes the result.
#
# Matching is fail-loud by design: zero or multiple sha256 matches, or
# an unknown json field, abort instead of silently skipping.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
anima_dir="${KAOIRO_ANIMA_DIR:-$HOME/nextcloud/storage.example.invalid/カメラアップロード/Anima}"

usage() {
  echo "Usage: $(basename "$0") <id> [--anima-dir <dir>]" >&2
  exit 2
}

id="${1:-}"
[[ -z "$id" ]] && usage
shift
while [[ $# -gt 0 ]]; do
  case "$1" in
    --anima-dir) anima_dir="$2"; shift 2 ;;
    *) usage ;;
  esac
done

for cmd in jq sha256sum; do
  command -v "$cmd" >/dev/null 2>&1 ||
    { echo "error: '$cmd' not found in PATH" >&2; exit 1; }
done

# Provenance fields kept in the sanitized output (reproduction + lineage).
# The generator-agnostic fields are optional, but accepted so provenance made
# outside Anima can retain its tool, source references, post-processing, and
# output digest under the schema's same fail-closed allowlist. Order here also
# fixes the output key order.
allow_fields=(mode prompt negative model architecture seed steps width
              height cfg denoise generated_at job_id source_job_id tool
              source_refs postprocess sha256)
# Fields intentionally dropped. silent_deny_fields carry PII/credential
# material (account is an email, image_url is a signed URL) and must
# never surface even in a diagnostic line. All other unrecognised fields
# are fail-closed errors, rather than being silently omitted.
silent_deny_fields=(account image_url)
states=(idle thinking tool_running waiting_input waiting_permission
        "done" error)

allow_json="$(printf '%s\n' "${allow_fields[@]}" | jq -R . | jq -s .)"
known_json="$(printf '%s\n' "${allow_fields[@]}" "${silent_deny_fields[@]}" |
  jq -R . | jq -s .)"

# Anima dir accessibility check first — the rclone mount does not survive
# a reboot and resurfaces as a read failure, not a missing directory.
if ! ls "$anima_dir" >/dev/null 2>&1; then
  cat >&2 <<EOF
error: Anima dir not accessible: $anima_dir
If this is a stale rclone mount ("Transport endpoint is not connected"),
recover with:
  fusermount -u "$anima_dir"
  rclone mount storage.example.invalid:/カメラアップロード/Anima "$anima_dir" --daemon
EOF
  exit 1
fi

shopt -s nullglob
anima_pngs=("$anima_dir"/*.png)
shopt -u nullglob
[[ ${#anima_pngs[@]} -gt 0 ]] ||
  { echo "error: no .png files under Anima dir: $anima_dir" >&2; exit 1; }

# Precompute every Anima png's sha256 once; matching each of the 7 source
# pngs against it individually would be O(states * anima_pngs) in
# repeated sha256sum invocations otherwise.
anima_cache="$(mktemp)"
trap 'rm -f "$anima_cache"' EXIT
sha256sum "${anima_pngs[@]}" > "$anima_cache"

out_dir="$root/persona-packs/$id/provenance"
mkdir -p "$out_dir"

# Resolve the single pre-rembg source PNG for a state. Two known layouts
# exist (assets-work/<id>/ direct, or assets-work/dist/<id>/raw/ for
# personas whose working tree was reorganized) — probe both rather than
# hardcoding one, but never silently prefer one over the other.
find_source_png() {
  local state="$1"
  local candidates=()
  local p
  p="$root/assets-work/$id/$state.png"
  [[ -f "$p" ]] && candidates+=("$p")
  p="$root/assets-work/dist/$id/raw/$state.png"
  [[ -f "$p" ]] && candidates+=("$p")
  case "${#candidates[@]}" in
    0)
      echo "error: no source png for $id/$state (checked assets-work/$id/ and assets-work/dist/$id/raw/)" >&2
      exit 1
      ;;
    1) printf '%s\n' "${candidates[0]}" ;;
    *)
      echo "error: ambiguous source png for $id/$state: ${candidates[*]}" >&2
      exit 1
      ;;
  esac
}

for state in "${states[@]}"; do
  src_png="$(find_source_png "$state")"
  src_sha="$(sha256sum "$src_png" | cut -d' ' -f1)"

  matches="$(grep "^$src_sha  " "$anima_cache" | cut -d' ' -f3- || true)"
  if [[ -z "$matches" ]]; then
    echo "error: no Anima match for $id/$state (sha256 $src_sha, source: $src_png)" >&2
    exit 1
  fi
  match_count="$(printf '%s\n' "$matches" | wc -l)"
  if [[ "$match_count" -gt 1 ]]; then
    echo "error: multiple Anima matches for $id/$state (sha256 $src_sha): $matches" >&2
    exit 1
  fi

  anima_png="$matches"
  anima_json="${anima_png%.png}.json"
  [[ -f "$anima_json" ]] ||
    { echo "error: matched Anima png has no sibling json: $anima_png" >&2; exit 1; }

  # Cross-check against assets-work/dist/<id>/<state>.png.job.json when
  # present (kohaku ships one) — its job_id must agree with the sha256
  # match, or the matching logic itself is suspect.
  job_json="$root/assets-work/dist/$id/$state.png.job.json"
  if [[ -f "$job_json" ]]; then
    cross_job_id="$(jq -r '.job_id' "$job_json")"
    matched_job_id="$(basename "$anima_json" .json)"
    if [[ "$cross_job_id" != "$matched_job_id" ]]; then
      echo "error: job_id cross-check mismatch for $id/$state: $job_json says $cross_job_id, sha256 match says $matched_job_id" >&2
      exit 1
    fi
  fi

  unknown_fields="$(jq -r --argjson known "$known_json" \
    '(keys - $known) | .[]' "$anima_json")"
  if [[ -n "$unknown_fields" ]]; then
    while IFS= read -r field; do
      echo "error: unknown field '$field' in $anima_json" >&2
    done <<< "$unknown_fields"
    exit 1
  fi

  out_file="$out_dir/$state.json"
  tmp_out="$(mktemp)"
  jq --argjson allow "$allow_json" \
    '. as $in | reduce $allow[] as $k
      ({}; if ($in | has($k)) then . + {($k): $in[$k]} else . end)' \
    "$anima_json" > "$tmp_out"
  mv "$tmp_out" "$out_file"
  echo "wrote $out_file (job_id=$(basename "$anima_json" .json))"
done
