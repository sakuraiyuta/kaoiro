#!/usr/bin/env bash
# Deploys the runner the way scripts/build-runner-tarball.sh does and checks
# that every bare import in the deployed first-party code resolves. Expects
# built dist trees: pnpm -C wrapper build && pnpm -C runner build.
set -euo pipefail

root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
# A path relative to the workspace, like the tarball build: pnpm's legacy
# deploy miscomputes the virtual store for some absolute targets outside it.
stage_rel=".tarball-build.import-check.$$"
trap 'rm -rf -- "${root:?}/$stage_rel"' EXIT

(cd "$root" && pnpm --filter=@kaoiro/runner --prod deploy "$stage_rel/runner" --legacy >/dev/null)
node "$root/scripts/check-prod-deploy-imports.mjs" "$root/$stage_rel/runner"
