#!/bin/sh
# Updates a runner host to a new immutable release (issue #219, ADR-0018).
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
#   --codex-home <path>  explicit private Codex home (Linux/systemd)
#   --codex-backup-dir <path> new snapshot directory, paired with --codex-home
#   --restore-codex-backup <path> restore a retained snapshot instead of updating
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
codex_home=
codex_backup=
codex_restore=
codex_transaction=
switch_recovered=no
release_authority=
release_repo=
release_attempt=
release_plan_sha256=
release_skip=
release_skip_reason=
release_expected_authority=
release_target=
release_alias=
release_seen=
release_invocation=
release_proof_sha256=

while [ $# -gt 0 ]; do
  case "$1" in
    --release-repo|--release-authority|--release-attempt|--release-plan-sha256|--skip-release-reconciliation|--skip-reason|--expected-authority-sha256|--release-target|--release-alias)
      [ $# -ge 2 ] || kaoiro_die "$1 needs a value" 64
      kaoiro_reject_option_like "$1" "$2"
      case " $release_seen " in *" $1 "*) kaoiro_die "repeated release argument: $1" 64 ;; esac
      release_seen="$release_seen $1"
      case "$1" in
        --release-repo) release_repo=$2 ;;
        --release-authority) release_authority=$2 ;;
        --release-attempt) release_attempt=$2 ;;
        --release-plan-sha256) release_plan_sha256=$2 ;;
        --skip-release-reconciliation) release_skip=$2 ;;
        --skip-reason) release_skip_reason=$2 ;;
        --expected-authority-sha256) release_expected_authority=$2 ;;
        --release-target) release_target=$2 ;;
        --release-alias) release_alias=$2 ;;
      esac
      shift 2
      ;;
    --codex-home|--codex-backup-dir|--restore-codex-backup)
      [ $# -ge 2 ] || kaoiro_die "$1 needs a value" 64
      kaoiro_reject_option_like "$1" "$2"
      case "$2" in /*) ;; *) kaoiro_die "$1 requires an absolute path" 64 ;; esac
      case "$1" in
        --codex-home) codex_home=$2 ;;
        --codex-backup-dir) codex_backup=$2 ;;
        --restore-codex-backup) codex_restore=$2 ;;
      esac
      shift 2
      ;;
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

[ -n "$tarball" ] || [ -n "$repo" ] || [ -n "$codex_restore" ] ||
  kaoiro_die "usage: $prog --tarball <path> | --from-repo <path>" 64
[ -z "$tarball" ] || [ -z "$repo" ] ||
  kaoiro_die "--tarball and --from-repo are mutually exclusive" 64
[ -z "$build_target" ] || [ -n "$repo" ] ||
  kaoiro_die "--target only applies with --from-repo" 64
if [ -n "$codex_restore" ]; then
  [ -n "$codex_home" ] && [ -z "$codex_backup$tarball$repo$build_target" ] ||
    kaoiro_die "restore requires --codex-home and excludes forward inputs" 64
elif [ -n "$codex_home$codex_backup" ]; then
  [ -n "$codex_home" ] && [ -n "$codex_backup" ] ||
    kaoiro_die "--codex-home and --codex-backup-dir must be paired" 64
fi
# The glob, not the grep, is what rejects a multi-line value here — same
# line-anchoring trap as kaoiro_valid_release_id; see its comment.
case $keep in
  '' | *[!0-9]*) kaoiro_die "--keep must be a non-negative integer: $keep" 64 ;;
esac
[ "$keep" -ge 1 ] || kaoiro_die "--keep must be at least 1" 64

[ -n "$root" ] || root=$(kaoiro_install_root)

systemctl_bin="${KAOIRO_SYSTEMCTL:-systemctl}"
UPDATE_UNIT="${service%.service}-update"

release_audit() {
  _release_owner=$1
  set -- --config "${KAOIRO_RUNNER_CONFIG:-$(kaoiro_config_dir)/runner.config.json}"
  _release_repo=${release_repo:-$repo}
  [ -z "$_release_repo" ] || set -- "$@" --repo "$_release_repo"
  _release_target=$release_target
  [ -z "$_release_target" ] || set -- "$@" --target-sha "$_release_target"
  [ -z "$release_authority" ] || set -- "$@" --release-authority "$release_authority"
  [ -z "$release_attempt" ] || set -- "$@" --release-attempt "$release_attempt"
  [ -z "$release_plan_sha256" ] || set -- "$@" --release-plan-sha256 "$release_plan_sha256"
  [ -z "$release_skip" ] || set -- "$@" --skip-release-reconciliation "$release_skip"
  [ -z "$release_skip_reason" ] || set -- "$@" --skip-reason "$release_skip_reason"
  [ -z "$release_expected_authority" ] || set -- "$@" --expected-authority-sha256 "$release_expected_authority"
  [ -z "$release_alias" ] || set -- "$@" --alias "$release_alias"
  [ -z "$_release_owner" ] || set -- "$@" --owner-pid "$_release_owner" --mode worker --updater "$self"
  kaoiro_release_gate runner-audit "$root" "$@"
}
if [ -n "$codex_restore" ] && kaoiro_release_enrolled "$root"; then
  [ -z "$release_attempt$release_plan_sha256$release_skip$release_skip_reason" ] ||
    kaoiro_die "Recovery cannot assert a forward production release context" 64
  kaoiro_release_gate runner-restore-admission "$root" --snapshot "$codex_restore" --home "$codex_home" --service "$service" >/dev/null ||
    kaoiro_die "Recovery lineage refused before admission" 78
else
  release_audit "" >/dev/null || kaoiro_die "Release admission refused before queue or prepare" 78
fi

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
  [ -z "$codex_home" ] || set -- "$@" --codex-home "$codex_home"
  [ -z "$codex_backup" ] || set -- "$@" --codex-backup-dir "$codex_backup"
  [ -z "$codex_restore" ] || set -- "$@" --restore-codex-backup "$codex_restore"
  [ -z "$tarball" ] || set -- "$@" --tarball "$tarball"
  if [ -n "$repo" ]; then
    set -- "$@" --from-repo "$repo"
    [ -z "$build_target" ] || set -- "$@" --target "$build_target"
  fi

  [ -z "$release_authority" ] || set -- "$@" --release-authority "$release_authority"
  [ -z "$release_attempt" ] || set -- "$@" --release-attempt "$release_attempt"
  [ -z "$release_plan_sha256" ] || set -- "$@" --release-plan-sha256 "$release_plan_sha256"
  [ -z "$release_skip" ] || set -- "$@" --skip-release-reconciliation "$release_skip"
  [ -z "$release_skip_reason" ] || set -- "$@" --skip-reason "$release_skip_reason"
  [ -z "$release_expected_authority" ] || set -- "$@" --expected-authority-sha256 "$release_expected_authority"
  [ -z "$release_repo" ] || set -- "$@" --release-repo "$release_repo"
  [ -z "$release_target" ] || set -- "$@" --release-target "$release_target"
  [ -z "$release_alias" ] || set -- "$@" --release-alias "$release_alias"

  if kaoiro_release_enrolled "$root"; then
    detached_tool_sha256=$("$(kaoiro_node)" -e 'console.log(JSON.parse(require("node:fs").readFileSync(process.argv[1])).sha256)' "$deploy_dir/release-tools/TOOL-MANIFEST.json")
    detached_authority_sha256=$("$(kaoiro_node)" -e 'console.log(require("node:crypto").createHash("sha256").update(require("node:fs").readFileSync(process.argv[1])).digest("hex"))' "$root/release-authority.json")
    if [ -n "$release_expected_authority" ]; then
      [ "$release_expected_authority" = "$detached_authority_sha256" ] || kaoiro_die "Detached authority changed before queue" 78
    else
      set -- "$@" --expected-authority-sha256 "$detached_authority_sha256"
    fi
    set -- "$(kaoiro_node)" "$deploy_dir/release-tools/scripts/production-release-launcher.mjs" \
      worker "$detached_tool_sha256" "$deploy_dir" "$@"
  else
    set -- "$self" "$@"
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
    --expand-environment=no \
    "--setenv=PATH=$PATH" \
    "--setenv=KAOIRO_RUNNER_DIR=$(kaoiro_config_dir)" \
    ${KAOIRO_RUNNER_CONFIG:+"--setenv=KAOIRO_RUNNER_CONFIG=$KAOIRO_RUNNER_CONFIG"} \
    ${KAOIRO_NODE:+"--setenv=KAOIRO_NODE=$KAOIRO_NODE"} \
    -- "$@"

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

# Shared with kaoiro-runner-switch.sh and kaoiro-runner-install.sh (issue
# #243) — this script's own prune loop below is the only place it needs it,
# so links_held tracks whether THIS run actually acquired it and cleanup()
# releases it only then, same reasoning as install.sh's own copy of this
# comment.
links_lock="$root/.lock.links"
links_held=no

# Under the lock, and before this run makes its own staging dir: a build that
# died on SIGKILL leaves ~1.2 GB behind that nothing else ever revisits. ONLY
# this script's own prefix — a standalone install may be running under its
# own lock with its own staging dir.

build_dir=
cleanup() {
  if [ -f "$lock/release-owner.json" ]; then
    kaoiro_release_gate runner-cleanup "$root" --owner-pid "$$" >/dev/null || return 1
  fi
  [ -z "$build_dir" ] || rm -rf "$build_dir"
  [ "$links_held" = no ] || kaoiro_lock_release "$links_lock"
  rm -f "$lock/codex-owner.json"
  kaoiro_lock_release "$lock"
}
trap cleanup EXIT INT TERM
if [ -n "$codex_restore" ] && kaoiro_release_enrolled "$root"; then
  kaoiro_release_gate runner-restore-admission "$root" --snapshot "$codex_restore" --home "$codex_home" --service "$service" >/dev/null ||
    kaoiro_die "Executed recovery lineage refused before prepare" 78
else
  release_audit "$$" >/dev/null || kaoiro_die "Executed worker reconciliation refused before prepare" 78
fi
kaoiro_gc_staging "$root" ".staging.build"

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

if [ -z "$codex_restore" ]; then
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
  tagged_arg=
  [ "$allow_dirty" = yes ] || tagged_arg=--require-tagged
  if [ -n "$build_target" ]; then
    "$builder" $tagged_arg --target "$build_target" --out "$build_dir" >&2
  else
    "$builder" $tagged_arg --out "$build_dir" >&2
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

fi

if [ -n "$codex_home" ]; then
  printf '%s: WARNING: external Codex-home writers are not inspected; snapshot recovery may fail and require fresh setup (docs/operations/codex-home.md)\n' "$prog" >&2
  tool_id=$(cat "$deploy_dir/../VERSION")
  if [ -n "$codex_restore" ]; then
    codex_transaction=$(kaoiro_codex_state prepare-restore "$root" "$codex_restore" "$codex_home" "$service" "$tool_id" "$$") ||
      kaoiro_die "Codex restore preflight refused before stop" 78
    id=$(kaoiro_codex_state target "$root" "$codex_transaction")
  else
    codex_transaction=$(kaoiro_codex_state prepare "$root" "$id" "$codex_home" "$codex_backup" "$service" "$tool_id" "$$") ||
      kaoiro_die "Codex backup preflight refused before stop" 78
  fi
else
  kaoiro_codex_state preflight "$root" "$id" "" ||
    kaoiro_die "Codex pin transition requires an explicit state backup" 78
fi
install_args=""
[ "$allow_dirty" = no ] || install_args="--allow-dirty"

kaoiro_preflight_build_format "$root/releases/$id" "$allow_dirty" ||
  kaoiro_die "Target build format refused before stopping the runner" 78

if kaoiro_release_enrolled "$root" && [ -z "$codex_restore" ]; then
  kaoiro_release_gate runner-seal "$root" --owner-pid "$$" --target-sha "$id" >/dev/null ||
    kaoiro_die "Release proof could not be sealed before stop" 78
  release_invocation=$("$(kaoiro_node)" -e 'console.log(JSON.parse(require("node:fs").readFileSync(process.argv[1])).invocation_uuid)' "$lock/release-switch-proof.json")
  release_proof_sha256=$("$(kaoiro_node)" -e 'console.log(require("node:crypto").createHash("sha256").update(require("node:fs").readFileSync(process.argv[1])).digest("hex"))' "$lock/release-switch-proof.json")
fi

# --- commit: from here on a stop may interrupt the source.

source_was_active=no
if [ -n "$codex_transaction" ]; then
  source_state=$("$systemctl_bin" --user show --property=ActiveState --value "$service") ||
    kaoiro_die "Cannot read source activity before stop; transaction $codex_transaction" 78
  case "$source_state" in
    active) source_was_active=yes ;;
    inactive|failed) ;;
    *) kaoiro_die "Source activity is transitional or unknown before stop; transaction $codex_transaction" 78 ;;
  esac
fi
abort_before_switch() {
  reason=$1
  abort_status=$2
  kaoiro_codex_state summary "$root" "$codex_transaction" >&2 || true
  if [ "$source_was_active" = yes ]; then
    mkdir "$links_lock" 2>/dev/null ||
      kaoiro_die "$reason; source recovery refused: links lock unavailable; transaction $codex_transaction" "$abort_status"
    links_held=yes
    source_id=$(kaoiro_codex_state restart-source-check "$root" "$codex_transaction") ||
      kaoiro_die "$reason; source recovery refused; transaction $codex_transaction" "$abort_status"
    source_state=$("$systemctl_bin" --user show --property=ActiveState --value "$service") ||
      kaoiro_die "$reason; source recovery refused: activity unreadable; transaction $codex_transaction" "$abort_status"
    case "$source_state" in
      active) recovery_message="unchanged source remains running" ;;
      inactive|failed)
        "$systemctl_bin" --user start "$service" ||
          kaoiro_die "$reason; source restart failed; transaction $codex_transaction" "$abort_status"
        recovery_message="unchanged source was resumed"
        ;;
      *) kaoiro_die "$reason; source recovery refused: transitional service; transaction $codex_transaction" "$abort_status" ;;
    esac
    kaoiro_codex_state restart-source-verify "$root" "$codex_transaction" >/dev/null ||
      kaoiro_die "$reason; source restart verification failed; transaction $codex_transaction" "$abort_status"
    source_running=$(kaoiro_read_machine_identity "$root/current" "${source_id%-dirty}" "$allow_dirty" 2>/dev/null || true)
    kaoiro_identity_attests_revision "$source_running" "${source_id%-dirty}" "$allow_dirty" ||
      kaoiro_die "$reason; source identity verification failed; transaction $codex_transaction" "$abort_status"
    kaoiro_die "$reason; $recovery_message; transaction $codex_transaction" "$abort_status"
  fi
  kaoiro_die "$reason; source was already stopped; transaction $codex_transaction" "$abort_status"
}

printf '%s: stopping %s\n' "$prog" "$service" >&2
stop_status=0
"$systemctl_bin" --user stop "$service" || stop_status=$?
if [ "$stop_status" -ne 0 ]; then
  [ -z "$codex_transaction" ] || abort_before_switch "Runner stop failed" "$stop_status"
  exit "$stop_status"
fi

if [ -n "$codex_transaction" ]; then
  state_action=snapshot
  [ -z "$codex_restore" ] || state_action=restore
  if ! kaoiro_codex_state "$state_action" "$root" "$codex_transaction"; then
    abort_before_switch "Codex state preparation failed" 78
  fi
fi

set -- "$id" --install-dir "$root" --codex-transaction "$codex_transaction"
[ "$allow_dirty" = no ] || set -- "$@" --allow-dirty
[ -z "$release_invocation" ] || set -- "$@" --release-invocation "$release_invocation" --release-proof-sha256 "$release_proof_sha256"
if ! "$deploy_dir/kaoiro-runner-switch.sh" "$@" >/dev/null; then
  if [ -n "$codex_transaction" ]; then
    [ -z "$codex_restore" ] ||
      kaoiro_die "Restore switch failed; runner remains stopped; inspect transaction $codex_transaction, then use operator fresh setup (docs/operations/codex-home.md) if snapshot recovery cannot succeed" 78
    printf '%s: switch failed; recovering the recorded source according to the startup phase\n' "$prog" >&2
    codex_restore=$codex_backup
    codex_transaction=$(kaoiro_codex_state prepare-recovery "$root" "$codex_transaction" "$$") ||
      kaoiro_die "Source recovery preflight failed; runner remains stopped; inspect snapshot or use operator fresh setup (docs/operations/codex-home.md)" 78
    id=$(kaoiro_codex_state target "$root" "$codex_transaction")
    if ! kaoiro_codex_state restore "$root" "$codex_transaction"; then
      kaoiro_die "Source snapshot restore failed; runner remains stopped; preserve transaction $codex_transaction for operator fresh setup (docs/operations/codex-home.md)" 78
    fi
    # shellcheck disable=SC2086 # install_args is empty or --allow-dirty.
    if ! "$deploy_dir/kaoiro-runner-switch.sh" "$id" --install-dir "$root" --codex-transaction "$codex_transaction" $install_args >/dev/null; then
      kaoiro_die "Source recovery switch failed; runner remains stopped; preserve transaction $codex_transaction for operator fresh setup (docs/operations/codex-home.md)" 78
    fi
    switch_recovered=yes
  else
    # The legacy non-state switch is atomic; no native pin change was allowed.
    printf '%s: switch failed; restarting the previous release\n' "$prog" >&2
    "$systemctl_bin" --user start "$service" || true
    kaoiro_die "switch to $id failed; $service was restarted on the release it was already using" 70
  fi
fi

if [ -n "$codex_transaction" ]; then
  if ! kaoiro_codex_state before-start "$root" "$codex_transaction"; then
    kaoiro_die "Codex pre-start check failed; runner remains stopped; transaction $codex_transaction" 78
  fi
fi

printf '%s: starting %s\n' "$prog" "$service" >&2
start_failed=no
"$systemctl_bin" --user start "$service" || start_failed=yes

# Read the identity back through `current`, the same path the unit launches
# through. Comparing against what we installed is what turns "the commands
# exited 0" into "the host is serving the release we meant".
running=$(kaoiro_read_machine_identity "$root/current" "${id%-dirty}" "$allow_dirty" 2>/dev/null || true)

# `$id` is the release-directory identity (`<revision>[-dirty]`); what the
# artifact reports is its own wording of the same revision, so the check is
# attestation, not string equality — see kaoiro_identity_attests_revision.
if [ "$start_failed" = yes ] ||
  ! kaoiro_identity_attests_revision "$running" "${id%-dirty}" "$allow_dirty"; then
  printf '%s: update did NOT reach a good state\n' "$prog" >&2
  printf '%s:   requested release: %s\n' "$prog" "$id" >&2
  printf '%s:   current reports:   %s\n' "$prog" "${running:-<unreadable>}" >&2
  if [ -n "$codex_transaction" ]; then
    printf '%s: runner needs state-aware recovery; transaction %s\n' "$prog" "$codex_transaction" >&2
    printf '  %s --install-dir "%s" --service "%s" --restore-codex-backup "%s" --codex-home "%s" --detach\n' \
      "$self" "$root" "$service" "${codex_restore:-$codex_backup}" "$codex_home" >&2
    printf '%s: if snapshot recovery cannot succeed, keep the runner stopped and use operator fresh setup (docs/operations/codex-home.md)\n' "$prog" >&2
    exit 70
  fi
  printf '%s: roll back with:\n' "$prog" >&2
  printf '  %s --user stop %s\n' "$systemctl_bin" "$service" >&2
  printf '  %s --rollback --install-dir %s\n' \
    "$deploy_dir/kaoiro-runner-switch.sh" "$root" >&2
  printf '  %s --user start %s\n' "$systemctl_bin" "$service" >&2
  exit 70
fi

if [ -n "$codex_transaction" ]; then
  kaoiro_codex_state started "$root" "$codex_transaction" ||
    kaoiro_die "Cannot record startup; preserve transaction $codex_transaction" 78
  printf '%s: awaiting actual Codex start/history acceptance: transaction %s\n' "$prog" "$codex_transaction" >&2
  if [ "$switch_recovered" = yes ]; then
    kaoiro_die "Update switch failed; recorded source was restored and restarted; verify actual Codex recovery for transaction $codex_transaction" 70
  fi
  [ -z "$codex_restore" ] || exit 0
fi

# --- prune: only now, and never what current / previous point at. The runner
# --- resolves the codex wrapper lazily, on the first codex spawn, so a
# --- release still reachable as current is loaded from long after startup.

# Snapshot, held under .lock.links (issue #243) — the SAME lock
# kaoiro-runner-switch.sh takes around its own current/previous swap, and
# kaoiro-runner-install.sh around its own replace check. Without it, a
# manual switch landing between this read and the deletions below could
# make the snapshot stale and prune what just became `current`. Acquired
# only for this narrow window: the nested install call earlier in this
# script has already returned by the time this runs, so there is no
# reentrancy risk (see kaoiro-runner-install.sh's own .lock.links comment).
# A lock that cannot be acquired here means SOME other run is touching the
# links right now, so this run stops rather than guess at a stale snapshot
# — the host is left running the release it just switched to, just not
# pruned this time; a later update retries the prune.
kaoiro_lock_acquire "$links_lock"
links_held=yes

codex_protected=$(kaoiro_codex_state protected "$root") ||
  kaoiro_die "Cannot determine retained Codex releases" 78
protected=
for protected_id in $codex_protected; do
  protected="$protected releases/$protected_id"
done
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

kaoiro_lock_release "$links_lock"
links_held=no

printf '%s: %s is running release %s\n' "$prog" "$service" "$id" >&2
printf '%s\n' "$id"
