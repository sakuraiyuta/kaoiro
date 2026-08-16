#!/bin/sh
# Updates a runner host to a new immutable release (issue #229, ADR-0018).
#
#   kaoiro-runner-update.sh --tarball <path>   [options]
#   kaoiro-runner-update.sh --from-repo <path> [options]
#
#   --install-dir <dir>  install root (default: per-OS data dir)
#   --service <name>     systemd user unit of the runner (default:
#                        kaoiro-runner)
#   --target <os-arch>   build target, only with --from-repo
#   --keep <n>           releases to retain after a successful update
#                        (default 3). `current` and `previous` are never
#                        pruned, whatever this is set to
#   --allow-dirty        permit activating a `-dirty` / `unknown` release.
#                        Development only — see kaoiro-runner-switch.sh
#   --detach             queue this same command as a transient systemd user
#                        unit and return immediately (see below)
#
# WHY --detach EXISTS. The update stops the runner service. An agent running
# UNDER that runner which invokes this script directly kills itself halfway
# through, and nothing after the stop ever runs. --detach hands the work to
# the user systemd instance instead.
#
# WHAT MAKES THAT SAFE IS THE CGROUP, NOT THE PROCESS GROUP. `systemd.kill(5)`
# defaults to KillMode=control-group: "all remaining processes in the control
# group of this unit will be killed on unit stop". Merely leaving the caller's
# process group would not help — anything still inside the runner service's
# cgroup dies with it. A transient SERVICE unit is what escapes: per
# `systemd-run(1)`, it "will run in a clean and detached execution
# environment, with the service manager as its parent process", so it gets a
# cgroup of its own. Hence three properties this script must never lose:
#   * NO --scope. A transient scope runs under systemd-run itself, inheriting
#     the caller's execution environment, and is synchronous — it would put
#     the update right back inside the dying unit.
#   * NO PartOf / BindsTo, which would propagate the runner's stop to it.
#   * --no-block, so queuing does not wait on a unit whose first act is to
#     stop the caller.
#
# THE RESULT IS NOT REPORTED BACK, AND --detach REPORTS NO SUCCESS. Per
# `systemd-run(1)`, --no-block means the start request "is only verified and
# enqueued" — this script returns before the update has even STARTED, let
# alone finished, so its exit status says nothing about the outcome.
# Confirmation is the operator's, via the commands printed on queue.
#
# ORDER OF OPERATIONS. Everything that can fail on its own — building,
# extracting, verifying — happens BEFORE the service is stopped, and writes
# only into releases/<new-id>/. A failure there leaves the running runner
# untouched, still serving from the release it started on.
#
# TEST SEAMS. KAOIRO_SYSTEMD_RUN and KAOIRO_SYSTEMCTL override the two
# service-manager binaries. They exist so the deterministic tests can pin
# this script's behaviour without touching the host's real user systemd
# instance — which supervises the very runner an agent running these tests
# lives under. Not for production use.
#
# Exit 78 (EX_CONFIG) marks a misconfiguration, 75 (EX_TEMPFAIL) a lock held
# by another run.
set -eu

prog=kaoiro-runner-update
unset CDPATH
# PHYSICAL path: invoked as <root>/current/deploy/kaoiro-runner-update.sh,
# the logical path would start resolving to the NEW release the moment the
# switch lands, so the second half of the run would use different scripts
# from the first. Resolving through the symlink once pins the whole run to
# one release's tooling.
deploy_dir=$(cd -P -- "$(dirname -- "$0")" && pwd -P)
self="$deploy_dir/$(basename -- "$0")"
# shellcheck source-path=SCRIPTDIR
# shellcheck source=kaoiro-runner-common.sh
. "$deploy_dir/kaoiro-runner-common.sh"

UPDATE_UNIT=kaoiro-runner-update

tarball=
repo=
root=
service=kaoiro-runner
build_target=
keep=3
allow_dirty=no
detach=no

while [ $# -gt 0 ]; do
  case "$1" in
    --tarball)
      [ $# -ge 2 ] || kaoiro_die "--tarball needs a value" 64
      kaoiro_reject_option_like --tarball "$2"
      tarball=$2
      shift 2
      ;;
    --from-repo)
      [ $# -ge 2 ] || kaoiro_die "--from-repo needs a value" 64
      kaoiro_reject_option_like --from-repo "$2"
      repo=$2
      shift 2
      ;;
    --install-dir)
      [ $# -ge 2 ] || kaoiro_die "--install-dir needs a value" 64
      kaoiro_reject_option_like --install-dir "$2"
      root=$2
      shift 2
      ;;
    --service)
      [ $# -ge 2 ] || kaoiro_die "--service needs a value" 64
      kaoiro_reject_option_like --service "$2"
      service=$2
      shift 2
      ;;
    --target)
      [ $# -ge 2 ] || kaoiro_die "--target needs a value" 64
      kaoiro_reject_option_like --target "$2"
      build_target=$2
      shift 2
      ;;
    --keep)
      [ $# -ge 2 ] || kaoiro_die "--keep needs a value" 64
      keep=$2
      shift 2
      ;;
    --allow-dirty)
      allow_dirty=yes
      shift
      ;;
    --detach)
      detach=yes
      shift
      ;;
    -h | --help)
      awk 'NR > 1 && /^set -/ { exit } NR > 1' "$0"
      exit 0
      ;;
    *)
      kaoiro_die "unknown argument: $1" 64
      ;;
  esac
done

[ -n "$tarball" ] || [ -n "$repo" ] ||
  kaoiro_die "usage: $prog --tarball <path> | --from-repo <path>" 64
[ -z "$tarball" ] || [ -z "$repo" ] ||
  kaoiro_die "--tarball and --from-repo are mutually exclusive" 64
[ -z "$build_target" ] || [ -n "$repo" ] ||
  kaoiro_die "--target only applies with --from-repo" 64
# The glob, not the grep, is what rejects a multi-line value here — same
# line-anchoring trap as kaoiro_valid_release_id; see its comment.
case $keep in
  '' | *[!0-9]*) kaoiro_die "--keep must be a non-negative integer: $keep" 64 ;;
esac
[ "$keep" -ge 1 ] || kaoiro_die "--keep must be at least 1" 64

[ -n "$root" ] || root=$(kaoiro_install_root)

systemctl_bin="${KAOIRO_SYSTEMCTL:-systemctl}"

# ---------------------------------------------------------------- detach ---

if [ "$detach" = yes ]; then
  systemd_run_bin="${KAOIRO_SYSTEMD_RUN:-systemd-run}"
  command -v "$systemd_run_bin" >/dev/null 2>&1 ||
    kaoiro_die "systemd-run not found: $systemd_run_bin (--detach is Linux/systemd only)" 78

  # Rebuild the worker argv from the parsed values rather than replaying
  # "$@" minus --detach: POSIX sh has no arrays, and re-quoting a saved
  # argument list is where this kind of code goes wrong.
  set -- --install-dir "$root" --service "$service" --keep "$keep"
  [ "$allow_dirty" = no ] || set -- "$@" --allow-dirty
  [ -z "$tarball" ] || set -- "$@" --tarball "$tarball"
  if [ -n "$repo" ]; then
    set -- "$@" --from-repo "$repo"
    [ -z "$build_target" ] || set -- "$@" --target "$build_target"
  fi

  # A unit left loaded in `failed` state from an earlier run would make
  # --unit collide. Clearing it is also why --collect is NOT passed: the
  # finished unit has to stay inspectable, since its journal is the only
  # place the result of a detached run appears.
  "$systemctl_bin" --user reset-failed "$UPDATE_UNIT.service" >/dev/null 2>&1 || true

  # A transient unit does NOT inherit this shell's environment — it gets the
  # user manager's. Forward exactly the variables the worker needs, and
  # nothing else: KAOIRO_RUNNER_TOKEN and friends have no business here.
  #
  # No --scope, no --property=PartOf=, no --collect. Each absence is
  # load-bearing and is pinned by releaseUpdate.test.ts; see the header.
  set -- --user --no-block \
    "--unit=$UPDATE_UNIT" \
    "--description=kaoiro runner update" \
    "--setenv=PATH=$PATH" \
    ${KAOIRO_NODE:+"--setenv=KAOIRO_NODE=$KAOIRO_NODE"} \
    -- "$self" "$@"

  # Queue FIRST, report second. The report used to be printed and then
  # `exec` replaced this process, so a systemd-run that failed outright
  # (KAOIRO_SYSTEMD_RUN=/bin/false reproduces it) still printed "ENQUEUED"
  # before exiting non-zero — telling the operator the update was queued when
  # nothing had been. `exec` is gone for the same reason: it cannot be
  # followed by a check.
  "$systemd_run_bin" "$@" ||
    kaoiro_die "failed to queue $UPDATE_UNIT.service — nothing was started, and nothing has changed" 70

  # Deliberately not phrased as an outcome. --no-block returns once the start
  # request is verified and enqueued, so even now the update has not started;
  # a "done" here would be a claim this script cannot make.
  printf '%s: ENQUEUED (not started, not finished): %s.service\n' \
    "$prog" "$UPDATE_UNIT" >&2
  printf '%s: this command reports nothing about the outcome — check:\n' \
    "$prog" >&2
  printf '  journalctl --user -u %s.service -f\n' "$UPDATE_UNIT" >&2
  printf '  systemctl --user status %s.service\n' "$UPDATE_UNIT" >&2
  exit 0
fi

# ---------------------------------------------------------------- worker ---

lock="$root/.lock.update"
kaoiro_lock_acquire "$lock"

# Under the lock, and before this run makes its own staging dir: a build that
# died on SIGKILL leaves ~1.2 GB behind that nothing else ever revisits. ONLY
# this script's own prefix — a standalone install may be running under its
# own lock with its own staging dir.
kaoiro_gc_staging "$root" ".staging.build"

build_dir=
cleanup() {
  [ -z "$build_dir" ] || rm -rf "$build_dir"
  kaoiro_lock_release "$lock"
}
trap cleanup EXIT INT TERM

# The unit has to launch through `current` for a switch to mean anything. A
# host still pointed at a repo checkout would take the whole update — build,
# install, stop, switch, start — and come back running exactly what it was
# running before, reporting success. Checked BEFORE the stop, so failing here
# costs no downtime. This reads the unit's configuration, not the running
# process, so it catches the misconfiguration rather than proving the
# converse.
exec_start=$("$systemctl_bin" --user show -p ExecStart --value "$service" 2>/dev/null || true)
case "$exec_start" in
  *"$root/current/"*) ;;
  *)
    kaoiro_die "$service does not launch through $root/current/ — install the release profile unit first (runner/README.md). ExecStart: ${exec_start:-<unreadable>}" 78
    ;;
esac

# --- prepare: nothing below the switch is touched, so a failure here is a
# --- no-op for the running runner.

if [ -n "$repo" ]; then
  builder="$repo/scripts/build-runner-tarball.sh"
  [ -x "$builder" ] || kaoiro_die "not a kaoiro checkout: $builder is missing or not executable" 78

  # A per-run output dir: the builder names the archive after the revision,
  # so a shared dir would leave this script guessing which of several
  # archives it just produced.
  build_dir="$root/.staging.build.$$"
  rm -rf "$build_dir"
  mkdir -p "$build_dir"

  printf '%s: building a tarball from %s\n' "$prog" "$repo" >&2
  if [ -n "$build_target" ]; then
    "$builder" --target "$build_target" --out "$build_dir" >&2
  else
    "$builder" --out "$build_dir" >&2
  fi

  tarball=
  for archive in "$build_dir"/*.tar.gz; do
    [ -f "$archive" ] || kaoiro_die "the build produced no tarball in $build_dir" 70
    [ -z "$tarball" ] || kaoiro_die "the build produced more than one tarball in $build_dir" 70
    tarball=$archive
  done
fi

printf '%s: installing %s\n' "$prog" "$tarball" >&2
install_args=""
[ "$allow_dirty" = no ] || install_args="--allow-dirty"
# shellcheck disable=SC2086 # install_args is either empty or one literal
# flag this script chose; it must word-split to nothing when empty.
id=$("$deploy_dir/kaoiro-runner-install.sh" "$tarball" --install-dir "$root" $install_args)
printf '%s: prepared release %s\n' "$prog" "$id" >&2

# The activation gate is enforced HERE, not left to the switch below. The
# switch runs after the stop, so discovering there that the id may not be
# activated would cost an outage this check can see coming — a build off a
# dirty tree is the common way to reach it, and the runner would be down for
# a refusal that was decidable before anything stopped.
if [ "$allow_dirty" = no ] && ! kaoiro_clean_release_id "$id"; then
  kaoiro_die "refusing to activate $id: only a clean 40-hex revision may become current — build from a clean tree, or pass --allow-dirty for a development host" 78
fi

# --- commit: from here on the service is down.

printf '%s: stopping %s\n' "$prog" "$service" >&2
"$systemctl_bin" --user stop "$service"

# shellcheck disable=SC2086 # same reasoning as the install call above.
if ! "$deploy_dir/kaoiro-runner-switch.sh" "$id" --install-dir "$root" $install_args >/dev/null; then
  # The switch is atomic, so a failure means `current` never moved. Undoing
  # our own stop restores the exact state we started from.
  printf '%s: switch failed; restarting the previous release\n' "$prog" >&2
  "$systemctl_bin" --user start "$service" || true
  kaoiro_die "switch to $id failed; $service was restarted on the release it was already using" 70
fi

printf '%s: starting %s\n' "$prog" "$service" >&2
start_failed=no
"$systemctl_bin" --user start "$service" || start_failed=yes

# Read the identity back through `current`, the same path the unit launches
# through. Comparing against what we installed is what turns "the commands
# exited 0" into "the host is serving the release we meant".
running=$("$root/current/deploy/kaoiro-runner-launch.sh" --version 2>/dev/null || true)

if [ "$start_failed" = yes ] || [ "$running" != "$id" ]; then
  printf '%s: update did NOT reach a good state\n' "$prog" >&2
  printf '%s:   requested release: %s\n' "$prog" "$id" >&2
  printf '%s:   current reports:   %s\n' "$prog" "${running:-<unreadable>}" >&2
  printf '%s: roll back with:\n' "$prog" >&2
  printf '  %s --user stop %s\n' "$systemctl_bin" "$service" >&2
  printf '  %s --rollback --install-dir %s\n' \
    "$deploy_dir/kaoiro-runner-switch.sh" "$root" >&2
  printf '  %s --user start %s\n' "$systemctl_bin" "$service" >&2
  exit 70
fi

# --- prune: only now, and never what current / previous point at. The runner
# --- resolves the codex wrapper lazily, on the first codex spawn, so a
# --- release still reachable as current is loaded from long after startup.

# Snapshot, with the same scope caveat as install.sh's header: a manual
# kaoiro-runner-switch.sh run takes no lock, so one landing between this read
# and the deletions below could make the snapshot stale and prune what just
# became `current`. Concurrent switch is out of contract here too.
protected=
for link in current previous; do
  if [ -L "$root/$link" ]; then
    protected="$protected $(readlink "$root/$link")"
  fi
done

seen=0
# shellcheck disable=SC2045 # release ids are validated 40-hex[-dirty]
# strings, so word splitting is safe here, and `ls -t` is the only portable
# way to order by recency.
for release in $(ls -1t "$root/releases" 2>/dev/null); do
  kaoiro_valid_release_id "$release" || continue
  seen=$((seen + 1))
  case " $protected " in
    *" releases/$release "*) continue ;;
  esac
  [ "$seen" -gt "$keep" ] || continue
  printf '%s: pruning release %s\n' "$prog" "$release" >&2
  rm -rf "$root/releases/$release"
done

printf '%s: %s is running release %s\n' "$prog" "$service" "$id" >&2
printf '%s\n' "$id"
