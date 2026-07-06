#!/usr/bin/env bash
# Build a persona pack zip from a working tree (ADR-0029 / phase-10).
#
# Usage: scripts/build-persona-pack.sh <id> [--out <dir>]
#
# Reads `persona-packs/<id>/{manifest.json, personality.md, sprites/*.png}`,
# validates the required shape, and emits `<out>/<id>-<version>.zip`. The
# default output directory is `server/priv/persona-packs/`, the server's
# default ingest dir; the auto-watcher (KaoiroServer.PersonaWatcher) will
# rebuild the manifest as soon as the zip lands there.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
src_root="$root/persona-packs"
out_dir="$root/server/priv/persona-packs"

usage() {
  echo "Usage: $(basename "$0") <id> [--out <dir>]" >&2
  exit 2
}

id="${1:-}"
[[ -z "$id" ]] && usage
shift
while [[ $# -gt 0 ]]; do
  case "$1" in
    --out) out_dir="$2"; shift 2 ;;
    *) usage ;;
  esac
done

for cmd in jq zip; do
  command -v "$cmd" >/dev/null 2>&1 ||
    { echo "error: '$cmd' not found in PATH" >&2; exit 1; }
done

src="$src_root/$id"
[[ -d "$src" ]] || { echo "error: source tree not found: $src" >&2; exit 1; }
[[ -f "$src/manifest.json" ]] ||
  { echo "error: manifest.json not found: $src/manifest.json" >&2; exit 1; }
[[ -f "$src/personality.md" ]] ||
  { echo "error: personality.md not found: $src/personality.md" >&2; exit 1; }
[[ -d "$src/sprites" ]] ||
  { echo "error: sprites/ not found: $src/sprites" >&2; exit 1; }

# Required manifest fields (persona-pack-schema.md).
required=(id name sprite_set version license min_kaoiro_version states)
for field in "${required[@]}"; do
  jq -e --arg f "$field" 'has($f)' "$src/manifest.json" >/dev/null ||
    { echo "error: manifest.json missing field: $field" >&2; exit 1; }
done

manifest_id=$(jq -r '.id' "$src/manifest.json")
[[ "$manifest_id" == "$id" ]] ||
  { echo "error: manifest.id '$manifest_id' != directory '$id'" >&2; exit 1; }

# 7 states, each with a matching PNG in sprites/.
required_states=(idle thinking tool_running waiting_input
                 waiting_permission "done" error)
for state in "${required_states[@]}"; do
  [[ -f "$src/sprites/$state.png" ]] ||
    { echo "error: sprites/$state.png not found" >&2; exit 1; }
done

version=$(jq -r '.version' "$src/manifest.json")
mkdir -p "$out_dir"
out_zip="$out_dir/$id-$version.zip"

# Rebuild deterministically: remove prior zip for the same id-version so
# `zip` never appends to a stale archive.
rm -f "$out_zip"

# Zip the pack's 3 top-level entries relative to the source tree so the
# archive matches the schema (manifest.json / personality.md / sprites/
# directly at zip root).
(
  cd "$src"
  zip -qr "$out_zip" manifest.json personality.md sprites
)

echo "built $out_zip"
