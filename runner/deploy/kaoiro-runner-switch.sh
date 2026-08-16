#!/bin/sh
# Points the `current` release symlink at another installed release, or back
# at the previous one (issue #229, ADR-0018).
#
#   kaoiro-runner-switch.sh <release-id> [--install-dir <dir>] [--allow-dirty]
#   kaoiro-runner-switch.sh --rollback   [--install-dir <dir>]
#
# ACTIVATION IS RESTRICTED TO CLEAN IDS. Only a 40-hex SHA may become
# `current` by default; `-dirty` and `unknown` need --allow-dirty and are for
# development. `current` is the name that decides what the host runs, so it
# has to resolve to a commit — an id that does not determine its own content
# would put the guesswork this layout removes straight back, one level up.
#
# --rollback carries NO such gate: whatever is in `previous` was activated
# once already, and refusing to restore it would leave a host stuck on a
# broken release for a reason that no longer helps anyone.
#
# The switch itself is atomic: a temporary symlink is created next to
# `current` and rename(2)d over it, so no observer ever sees `current`
# missing or dangling. See kaoiro_symlink_swap in kaoiro-runner-common.sh for
# why this cannot go through `mv`.
#
# STOPPING AND STARTING THE SERVICE IS THE CALLER'S JOB. This script only
# moves the pointer, which keeps it usable for a manual rollback on a host
# whose service manager is in an unknown state.
#
# Prints the release id `current` ends up pointing at, on stdout.
#
# Exit 78 (EX_CONFIG) marks a misconfiguration, 70 (EX_SOFTWARE) an
# incomplete release tree.
set -eu

prog=kaoiro-runner-switch
unset CDPATH
deploy_dir=$(cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source-path=SCRIPTDIR
# shellcheck source=kaoiro-runner-common.sh
. "$deploy_dir/kaoiro-runner-common.sh"

id=
root=
rollback=no
allow_dirty=no

while [ $# -gt 0 ]; do
  case "$1" in
    --install-dir)
      [ $# -ge 2 ] || kaoiro_die "--install-dir needs a value" 64
      kaoiro_reject_option_like --install-dir "$2"
      root=$2
      shift 2
      ;;
    --rollback)
      rollback=yes
      shift
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
      [ -z "$id" ] || kaoiro_die "more than one release id given" 64
      id=$1
      shift
      ;;
  esac
done

[ -n "$root" ] || root=$(kaoiro_install_root)
[ -d "$root/releases" ] || kaoiro_die "no releases installed under $root" 78

# `previous` is written BEFORE `current` on a forward switch: if the run dies
# between the two, both point at the old release — consistent, and a rollback
# is a no-op rather than a jump two generations back.
switch_to() {
  _id=$1
  _target="$root/releases/$_id"
  [ -d "$_target" ] || kaoiro_die "no such release: $_id (looked in $root/releases)" 78
  kaoiro_verify_release_tree "$_target"
  # The directory name is what `current` will point at; the tree's own
  # build-info is what actually runs. Re-checked here and not only at install
  # time, because a release directory can be renamed, restored from a backup,
  # or built by an older installer that did not enforce this.
  [ "$KAOIRO_VERIFIED_IDENTITY" = "$_id" ] ||
    kaoiro_die "release directory $_id carries identity $KAOIRO_VERIFIED_IDENTITY — refusing to activate a name that does not match its contents" 70

  _old=""
  if [ -L "$root/current" ]; then
    _old=$(readlink "$root/current")
  fi

  if [ "$_old" = "releases/$_id" ]; then
    printf '%s: current already points at %s\n' "$prog" "$_id" >&2
    printf '%s\n' "$_id"
    return 0
  fi

  # Relative targets keep the install root relocatable.
  if [ -n "$_old" ]; then
    kaoiro_symlink_swap "$root/previous" "$_old"
  fi
  kaoiro_symlink_swap "$root/current" "releases/$_id"

  printf '%s: current -> releases/%s\n' "$prog" "$_id" >&2
  printf '%s\n' "$_id"
}

if [ "$rollback" = yes ]; then
  [ -z "$id" ] || kaoiro_die "--rollback takes no release id" 64
  [ -L "$root/previous" ] || kaoiro_die "no previous release recorded under $root" 78

  prev=$(readlink "$root/previous")
  prev_id=${prev#releases/}
  [ "$prev_id" != "$prev" ] ||
    kaoiro_die "previous does not point into releases/: $prev" 70
  kaoiro_valid_release_id "$prev_id" ||
    kaoiro_die "previous points at an unusable release id: $prev_id" 70

  prev_target="$root/releases/$prev_id"
  [ -d "$prev_target" ] || kaoiro_die "previous release is gone: $prev_target" 78
  kaoiro_verify_release_tree "$prev_target"
  [ "$KAOIRO_VERIFIED_IDENTITY" = "$prev_id" ] ||
    kaoiro_die "previous release directory $prev_id carries identity $KAOIRO_VERIFIED_IDENTITY — refusing to roll back onto a name that does not match its contents" 70

  cur=""
  if [ -L "$root/current" ]; then
    cur=$(readlink "$root/current")
  fi

  # The rollback itself goes first. A run that dies right after it leaves
  # `current` rolled back — the outcome that was asked for — with `previous`
  # merely stale, which degrades a second rollback to a no-op instead of
  # stepping further back into history.
  kaoiro_symlink_swap "$root/current" "$prev"
  if [ -n "$cur" ]; then
    kaoiro_symlink_swap "$root/previous" "$cur"
  fi

  printf '%s: rolled back, current -> %s\n' "$prog" "$prev" >&2
  printf '%s\n' "$prev_id"
  exit 0
fi

[ -n "$id" ] || kaoiro_die "usage: $prog <release-id> | --rollback [--install-dir <dir>]" 64
kaoiro_valid_release_id "$id" || kaoiro_die "unusable release id: $id" 64
kaoiro_clean_release_id "$id" || [ "$allow_dirty" = yes ] ||
  kaoiro_die "refusing to activate $id: only a clean 40-hex revision may become current — pass --allow-dirty for a development host" 78
switch_to "$id"
