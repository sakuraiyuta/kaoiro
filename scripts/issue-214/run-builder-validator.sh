#!/usr/bin/env bash
set -euo pipefail

root=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
scratch=$(mktemp -d "${TMPDIR:-/tmp}/momo214-issue-214-builder-validator.XXXXXX")
trap 'rm -rf -- "$scratch"' EXIT

pnpm -C "$root/wrapper" build
node "$root/scripts/issue-214/prepare-builder-validator.mjs" "$scratch"

export KAOIRO_ISSUE_214_BUILDER_PAYLOAD="$scratch/payload.json"
export KAOIRO_ISSUE_214_BUILDER_MANIFEST="$scratch/manifest.json"
export KAOIRO_ISSUE_214_EXPECTED_GIT_REVISION
KAOIRO_ISSUE_214_EXPECTED_GIT_REVISION=$(git -C "$root" rev-parse HEAD)

"$root/scripts/mix-test.sh" "$@"
