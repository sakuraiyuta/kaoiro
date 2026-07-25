#!/usr/bin/env bash
# Build a self-contained runner tarball (issue #70, ADR-0018).
#
# The output needs nothing but a Node runtime on the target host: the wrapper
# packages, their engine CLIs (Claude Code / codex ship as platform-specific
# npm packages) and every native module are inside. Setting it up is
# "unpack -> edit config -> run", with no pnpm install / build / workspace
# resolution on the deployment host.
#
#   scripts/build-runner-tarball.sh [--target <os>-<arch>] [--out <dir>]
#
#   --target  darwin-arm64 | linux-x64   (default: this host)
#   --out     output directory           (default: <repo>/dist-tarball)
#
# Cross-building works because pnpm can fetch another platform's optional
# dependencies (`supportedArchitectures`), which this script injects into
# pnpm-workspace.yaml for the duration of the build and then reverts. A
# darwin host can therefore produce the linux-x64 archive.
#
# Three pnpm quirks are handled here so callers never see them:
#   1. `pnpm deploy` needs `--legacy` unless the workspace sets
#      inject-workspace-packages=true.
#   2. Its output path is resolved relative to the workspace, so an absolute
#      target silently breaks (it tried to mkdir /Users/tmp for /tmp/x).
#   3. It honours .gitignore for the deployed package itself — runner's
#      `files` list in package.json is what keeps dist/ in the archive.
set -euo pipefail

root=$(cd -- "$(dirname -- "$0")/.." && pwd)
cd "$root"

host_os=$(uname -s | tr '[:upper:]' '[:lower:]')
case "$(uname -m)" in
  arm64 | aarch64) host_cpu=arm64 ;;
  x86_64 | amd64) host_cpu=x64 ;;
  *) host_cpu=$(uname -m) ;;
esac

target="$host_os-$host_cpu"
out="$root/dist-tarball"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target)
      target="${2:?--target needs a value}"
      shift 2
      ;;
    --out)
      out="${2:?--out needs a value}"
      shift 2
      ;;
    -h | --help)
      sed -n '2,20p' "$0"
      exit 0
      ;;
    *)
      echo "build-runner-tarball: unknown option: $1" >&2
      exit 64 # EX_USAGE
      ;;
  esac
done

case "$target" in
  darwin-arm64 | darwin-x64 | linux-x64 | linux-arm64) ;;
  *)
    echo "build-runner-tarball: unsupported target: $target" >&2
    echo "  expected darwin-arm64 | darwin-x64 | linux-x64 | linux-arm64" >&2
    exit 64
    ;;
esac
target_os=${target%-*}
target_cpu=${target##*-}

for cmd in pnpm node tar; do
  command -v "$cmd" >/dev/null 2>&1 || {
    echo "build-runner-tarball: $cmd not found in PATH" >&2
    exit 69 # EX_UNAVAILABLE
  }
done

rev=$(git rev-parse --short HEAD 2>/dev/null || echo unknown)
git diff --quiet 2>/dev/null || rev="$rev-dirty"
name="kaoiro-runner-$rev-$target"

# Staging dir must be workspace-relative (quirk 2 above).
stage_rel=".tarball-build"
stage="$root/$stage_rel"
ws="$root/pnpm-workspace.yaml"
ws_backup="$stage/pnpm-workspace.yaml.orig"

cleanup() {
  if [[ -f "$ws_backup" ]]; then
    cp "$ws_backup" "$ws"
  fi
  rm -rf "$stage"
}
trap cleanup EXIT INT TERM

rm -rf "$stage"
mkdir -p "$stage" "$out"

echo "build-runner-tarball: target=$target rev=$rev"

echo "build-runner-tarball: building TypeScript"
pnpm -C wrapper build >/dev/null
pnpm -C runner build >/dev/null

# Cross-target: ask pnpm for the other platform's optional dependencies. Note
# the archive then also carries that platform's musl variants — a `libc`
# filter does not exclude them — which is why the linux archive works on both
# glibc and musl hosts (at the cost of ~300 MB).
if [[ "$target" != "$host_os-$host_cpu" ]]; then
  echo "build-runner-tarball: fetching $target optional dependencies"
  cp "$ws" "$ws_backup"
  cat >>"$ws" <<YAML

# Injected by scripts/build-runner-tarball.sh (reverted after the build).
supportedArchitectures:
  os:
    - $target_os
  cpu:
    - $target_cpu
YAML
fi

echo "build-runner-tarball: pnpm deploy"
pnpm --filter=@kaoiro/runner --prod deploy "$stage_rel/$name" --legacy >/dev/null

# The launch shim resolves ../dist/cli.js from its own directory, so the deploy
# tree needs no rearranging: deploy/ and dist/ are already siblings.
[[ -f "$stage/$name/dist/cli.js" ]] || {
  echo "build-runner-tarball: dist/cli.js missing from the deploy tree" >&2
  exit 70 # EX_SOFTWARE
}
[[ -x "$stage/$name/deploy/kaoiro-runner-launch.sh" ]] || {
  echo "build-runner-tarball: launch shim missing or not executable" >&2
  exit 70
}
printf '%s\n' "$rev" >"$stage/$name/VERSION"

echo "build-runner-tarball: archiving"
tar czf "$out/$name.tar.gz" -C "$stage" "$name"

echo "build-runner-tarball: done"
du -h "$out/$name.tar.gz"
