#!/bin/sh
# Installs a runner tarball as an immutable release (issue #229, ADR-0018).
#
#   kaoiro-runner-install.sh <tarball> [--install-dir <dir>] [--allow-dirty]
#
#   --install-dir  install root (default: $KAOIRO_RUNNER_INSTALL_DIR, else the
#                  per-OS data dir — see kaoiro-runner-common.sh)
#   --allow-dirty  permit re-installing over a `-dirty` / `unknown` release,
#                  whose id does not identify its content. Development only
#
# AN INSTALLED CLEAN RELEASE IS NEVER REPLACED — there is no flag for it. A
# clean 40-hex id is content-addressed (ADR-0053), so re-installing it can
# only produce the same bytes, and refusing outright is what makes
# releases/<clean-id>/ genuinely immutable rather than immutable by
# convention. A release believed to be corrupt is removed by hand, which
# leaves a trace; a silent overwrite does not.
#
# THIS SCRIPT NEVER TOUCHES A LIVE RELEASE. It writes into a staging dir and
# into releases/<id>/ only, and does not read or move `current`. That is what
# makes it safe to run while the runner service is up: the running process
# resolved its module paths through realpath at startup, so nothing it will
# ever load lives outside the release it was started from (measured
# 2026-08-16 — a lazy require.resolve after a `current` swap still resolved
# inside the original release).
#
# The corollary is why --allow-dirty still refuses to overwrite the release
# `current` or `previous` points at: the runner resolves the codex wrapper
# lazily, on the first codex spawn, so replacing the files under a running
# release breaks a spawn that has not happened yet.
#
# THAT CHECK IS A SNAPSHOT, AND ITS SCOPE IS WORTH STATING PLAINLY.
# `.lock.install` excludes other installs and nothing else;
# kaoiro-runner-switch.sh takes no lock at all, so a switch landing between
# the check below and the `rm -rf` would leave `current` pointing at the tree
# being replaced. Running a switch concurrently with an install is therefore
# OUT OF CONTRACT, not defended against. The window needs --allow-dirty plus
# a concurrent operator action, i.e. a development host; giving all three
# scripts one shared lock over the links is the real fix and is deliberately
# not attempted here (issue #229 review round 3, ARCH).
#
# Prints the installed release id on stdout; everything else goes to stderr,
# so a caller can use `id=$(kaoiro-runner-install.sh ...)`.
#
# Exit 78 (EX_CONFIG) marks a misconfiguration, 70 (EX_SOFTWARE) a broken
# archive, 75 (EX_TEMPFAIL) a lock held by another run.
set -eu

prog=kaoiro-runner-install
unset CDPATH
deploy_dir=$(cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source-path=SCRIPTDIR
# shellcheck source=kaoiro-runner-common.sh
. "$deploy_dir/kaoiro-runner-common.sh"

tarball=
root=
allow_dirty=no

while [ $# -gt 0 ]; do
  case "$1" in
    --install-dir)
      [ $# -ge 2 ] || kaoiro_die "--install-dir needs a value" 64
      kaoiro_reject_option_like --install-dir "$2"
      root=$2
      shift 2
      ;;
    --allow-dirty)
      allow_dirty=yes
      shift
      ;;
    -h | --help)
      awk 'NR > 1 && /^set -/ { exit } NR > 1' "$0"
      exit 0
      ;;
    -*)
      kaoiro_die "unknown option: $1" 64
      ;;
    *)
      [ -z "$tarball" ] || kaoiro_die "more than one tarball given" 64
      tarball=$1
      shift
      ;;
  esac
done

[ -n "$tarball" ] || kaoiro_die "usage: $prog <tarball> [--install-dir <dir>] [--allow-dirty]" 64
[ -f "$tarball" ] || kaoiro_die "tarball not found: $tarball" 78
[ -n "$root" ] || root=$(kaoiro_install_root)

command -v tar >/dev/null 2>&1 || kaoiro_die "tar not found in PATH" 78

mkdir -p "$root/releases"

lock="$root/.lock.install"
kaoiro_lock_acquire "$lock"

# Under the lock, and before this run makes its own. ONLY this script's own
# prefix: an update in progress keeps its build dir under the same root and
# holds a different lock, so it is not ours to judge abandoned.
kaoiro_gc_staging "$root" ".staging.install"

# The staging dir sits INSIDE the install root so the final `mv` is a rename
# within one filesystem, which is what makes it atomic. A staging dir under
# /tmp would silently degrade to a copy across a mount boundary, and a
# half-copied tree would become visible as a release.
staging="$root/.staging.install.$$"

cleanup() {
  rm -rf "$staging"
  kaoiro_lock_release "$lock"
}
trap cleanup EXIT INT TERM

rm -rf "$staging"
mkdir "$staging"

printf '%s: extracting %s\n' "$prog" "$tarball" >&2
tar xzf "$tarball" -C "$staging"

# The archive carries exactly one top-level directory
# (kaoiro-runner-<id>-<os>-<arch>). Discover it rather than reconstructing
# the name: the id and target are the archive's business, not this script's.
tree=
for entry in "$staging"/*; do
  [ -e "$entry" ] || kaoiro_die "archive is empty: $tarball" 70
  [ -z "$tree" ] || kaoiro_die "archive has more than one top-level entry: $tarball" 70
  tree=$entry
done
# -L BEFORE -d: `[ -d ]` follows symlinks, so an archive whose only
# top-level entry is a link to a directory elsewhere passed this check and
# was then `mv`d into place — making releases/<id> itself a link out of the
# install root, at exit 0 (reproduced 2026-08-16).
[ ! -L "$tree" ] ||
  kaoiro_die "archive's top-level entry is a symlink, not a directory: $tarball" 70
[ -d "$tree" ] || kaoiro_die "archive's top-level entry is not a directory: $tarball" 70

# Sets KAOIRO_VERIFIED_IDENTITY, having already proved VERSION and
# dist/build-info.json agree. Taking the id from anywhere else — a second
# `cat VERSION`, or the archive's filename — is what let a tarball name its
# directory after one build while carrying another.
kaoiro_verify_release_tree "$tree"
id=$KAOIRO_VERIFIED_IDENTITY
kaoiro_valid_release_id "$id" ||
  kaoiro_die "release carries an unusable identity: $id" 70

target="$root/releases/$id"

if [ -e "$target" ]; then
  if kaoiro_clean_release_id "$id"; then
    # Content-addressed (ADR-0053): same commit, clean tree, same build. The
    # installed one IS the requested one, so this is a no-op — which is also
    # what keeps a retried update idempotent. There is deliberately no flag
    # to replace it; see the header.
    #
    # BUT VERIFY WHAT IS ALREADY THERE FIRST. Skipping straight to exit 0
    # meant the one path that touches an EXISTING release never looked at
    # it: a release whose dist/cli.js had been deleted was reported as
    # "already installed" and left broken, and the update that followed
    # went on to activate it (reproduced 2026-08-16).
    kaoiro_verify_release_tree "$target"
    if [ "$KAOIRO_VERIFIED_IDENTITY" != "$id" ]; then
      # Same directory name, different build inside. Replacing it silently
      # would destroy whatever the running host may still be using, and
      # keeping it would activate a build nobody asked for. Neither is ours
      # to choose.
      kaoiro_die "release $id is already installed but carries identity $KAOIRO_VERIFIED_IDENTITY — refusing to guess; remove it by hand after checking what uses it" 70
    fi
    printf '%s: release %s is already installed and verified, keeping it\n' "$prog" "$id" >&2
    printf '%s\n' "$id"
    exit 0
  fi

  # `-dirty` / `unknown`: the id does NOT identify the content, so the
  # installed tree and this archive can differ while sharing a name. Keeping
  # the old one silently, or replacing it silently, are both the "you are not
  # running what you think you are running" failure this issue exists to
  # close. Say so and require the operator to choose.
  [ "$allow_dirty" = yes ] ||
    kaoiro_die "release $id is already installed and its id does not identify its content — pass --allow-dirty to replace it (development only)" 78

  # Even then, refuse while the release is reachable as `current` or
  # `previous`: the runner resolves the codex wrapper lazily, so replacing
  # the files under a running release breaks a spawn that has not happened
  # yet, and replacing the rollback target destroys the only way back.
  for link in current previous; do
    if [ -L "$root/$link" ] && [ "$(readlink "$root/$link")" = "releases/$id" ]; then
      kaoiro_die "refusing to replace release $id: $link points at it" 78
    fi
  done

  printf '%s: replacing installed release %s\n' "$prog" "$id" >&2
  rm -rf "$target"
fi

mv "$tree" "$target"

# Stamp the install time. rename(2) does not touch the directory's own mtime,
# and tar restores the mtime the BUILD host recorded, so without this the
# release dirs carry build times — which do not order installs at all once a
# host installs an older archive after a newer one. Retention (the --keep
# pruning in kaoiro-runner-update.sh) orders by this. It is ordering
# metadata and nothing else: ADR-0053 is explicit that mtime is not evidence
# of what a tree contains, and dist/build-info.json remains the identity.
touch "$target"

printf '%s: installed %s\n' "$prog" "$target" >&2
printf '%s\n' "$id"
