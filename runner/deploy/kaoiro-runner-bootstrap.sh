#!/bin/sh
# Single entry point for a FRESH host's first-time runner install (issue
# #314, folding in issue #303 scope item 1): tarball -> wizard -> install ->
# switch -> service unit -> enable/start.
#
#   kaoiro-runner-bootstrap.sh <tarball> [--install-dir <dir>]
#     [--reconfigure] [--dry-run]
#
#   --install-dir  install root (default: per-OS data dir, see
#                  kaoiro_install_root in kaoiro-runner-common.sh)
#   --reconfigure  re-run the setup wizard even though runner.config.json /
#                  runner.env already exist. Existing files are backed up
#                  to <path>.bak-<unix-timestamp> first, never overwritten
#                  blind
#   --dry-run      print the plan; touches nothing. The wizard is
#                  interactive and cannot be previewed, so it is skipped
#                  entirely in this mode (not merely "would run it")
#
# EXISTING install / switch / update SCRIPTS ARE UNCHANGED. This composes
# kaoiro-runner-install.sh and kaoiro-runner-switch.sh exactly as an
# operator would invoke them by hand, and adds the one piece #303 scope 1
# left out of the operator manual: the one-time service-manager setup
# (systemd user unit on Linux, LaunchAgent on macOS).
#
# ORDER OF OPERATIONS: wizard -> install -> switch -> unit file -> enable /
# start. The wizard is the ONLY interactive step; everything after it runs
# unattended. Placing it first means every later step already has the
# config it needs, and a wizard the operator abandons (Ctrl-C, exit 130)
# leaves nothing else half-done.
#
# OS DETECTION: `uname -s` decides Linux (systemd --user unit) vs Darwin
# (launchd LaunchAgent); anything else is refused outright, matching
# scripts/build-runner-tarball.sh's own fixed target list rather than
# guessing. KAOIRO_UNAME and KAOIRO_LAUNCHCTL are TEST-ONLY override seams
# (same reasoning as KAOIRO_SYSTEMCTL / KAOIRO_SYSTEMD_RUN in
# kaoiro-runner-update.sh) — NEVER set them in production; KAOIRO_UNAME in
# particular would desync this script's idea of the host from every other
# tool that shells out to the real `uname`.
#
# IDEMPOTENT RE-RUN (this script is safe to run again on an already-set-up
# host, not just a fresh one):
#   - the wizard step is SKIPPED if runner.config.json or runner.env
#     already exist at the resolved config dir (kaoiro_config_dir), unless
#     --reconfigure is given
#   - install / switch are already idempotent by design (see their own
#     header comments) — re-running them here is a no-op or a clean replace
#   - the unit/plist file is regenerated from the template every run and
#     compared byte-for-byte against what is already on disk. Identical:
#     nothing is written. Different (or missing): written, and the service
#     manager is told about it (daemon-reload / a fresh plist on disk) —
#     but a service that is CURRENTLY ACTIVE is never restarted by this
#     script. Restarting drops every session the runner is supervising,
#     which is not this script's call to make; it prints the exact restart
#     commands and stops there.
#   - `enable --now` (Linux) is called unconditionally on every run: telling
#     systemd to start an already-active unit is a no-op (measured live,
#     2026-09-07 — same PID before and after), so this cannot restart a
#     live one. macOS has no equivalent "start if not already started" verb
#     (`launchctl bootstrap` on an already-loaded job errors instead), so
#     the Darwin branch below only bootstraps when NOT already loaded.
#
# NEVER PRINTS runner.env's CONTENTS. It carries KAOIRO_RUNNER_TOKEN; this
# script only ever names its PATH, in every mode including --dry-run.
#
# Exit 64 (EX_USAGE) bad arguments, 78 (EX_CONFIG) misconfiguration or an
# unsupported OS, 70 (EX_SOFTWARE) a step failed, 75 (EX_TEMPFAIL) a lock
# held by another run.
set -eu

prog=kaoiro-runner-bootstrap
unset CDPATH
deploy_dir=$(cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source-path=SCRIPTDIR
# shellcheck source=kaoiro-runner-common.sh
. "$deploy_dir/kaoiro-runner-common.sh"

systemctl_bin="${KAOIRO_SYSTEMCTL:-systemctl}"
launchctl_bin="${KAOIRO_LAUNCHCTL:-launchctl}"

# --------------------------------------------------------- service files --
# Local to this script: no other script under deploy/ touches a
# service-manager file, and both branches close over `deploy_dir` (this
# script's own directory, where the templates live).

# sed's REPLACEMENT text treats a literal `&` as "the whole match" and `\`
# as an escape leader, so an install root or $HOME carrying either would
# silently splice @@DEPLOY_DIR@@ itself back into the rendered unit/plist
# instead of the intended path — the placeholder text survives into the
# file, and the service reads it on every future start. `|` (this script's
# own sed delimiter, chosen so a `/`-heavy path needs no escaping) fails
# LOUDLY instead ("unterminated `s' command"), the safer of the two but
# still worth closing with the same substitution.
sed_escape_replacement() {
  printf '%s' "$1" | sed -e 's/[\\&|]/\\&/g'
}

# A newline in the value cannot be escaped this way (sed's own replacement
# text is line-based), so it is rejected before rendering rather than risking
# a truncated or multi-line substitution. Prints its own diagnostic and
# returns non-zero rather than calling kaoiro_die directly, so a caller
# writing the render's stdout to a temp file can clean that file up before
# exiting.
reject_newline() {
  # $1 = label (for the message), $2 = value
  # `if` (not `[ ... ] && return 0`): under `set -e`, a bare AND-list whose
  # left side fails would exit the whole script right there instead of
  # falling through to the diagnostic below — `-e` is only suspended for a
  # command tested as an `if` CONDITION, not for one that is merely the left
  # side of `&&` in a standalone statement.
  if [ "$(printf '%s' "$2" | wc -l)" -eq 0 ]; then
    return 0
  fi
  printf '%s: %s must not contain a newline: %s\n' "$prog" "$1" "$2" >&2
  return 1
}

render_systemd_unit() {
  # $1 = install root
  reject_newline "install root" "$1" || return 1
  sed "s|@@DEPLOY_DIR@@|$(sed_escape_replacement "$1/current/deploy")|" \
    "$deploy_dir/kaoiro-runner.service"
}

render_launchd_plist() {
  # $1 = install root
  reject_newline "install root" "$1" || return 1
  reject_newline HOME "$HOME" || return 1
  sed -e "s|@@DEPLOY_DIR@@|$(sed_escape_replacement "$1/current/deploy")|" \
    -e "s|@@HOME@@|$(sed_escape_replacement "$HOME")|" \
    "$deploy_dir/com.kaoiro.runner.plist"
}

plan_systemd() {
  _root=$1
  _unit_path="$HOME/.config/systemd/user/kaoiro-runner.service"
  if [ -e "$_unit_path" ] && render_systemd_unit "$_root" | cmp -s - "$_unit_path"; then
    printf '%s: unit file up to date: %s\n' "$prog" "$_unit_path" >&2
  else
    printf '%s: would write unit file: %s\n' "$prog" "$_unit_path" >&2
  fi
  printf '%s: would run: %s --user daemon-reload\n' "$prog" "$systemctl_bin" >&2
  printf '%s: would run: %s --user enable --now kaoiro-runner\n' "$prog" "$systemctl_bin" >&2
}

plan_launchd() {
  _root=$1
  _plist_path="$HOME/Library/LaunchAgents/com.kaoiro.runner.plist"
  if [ -e "$_plist_path" ] && render_launchd_plist "$_root" | cmp -s - "$_plist_path"; then
    printf '%s: plist up to date: %s\n' "$prog" "$_plist_path" >&2
  else
    printf '%s: would write plist: %s\n' "$prog" "$_plist_path" >&2
  fi
  _uid=$(id -u)
  if "$launchctl_bin" print "gui/$_uid/com.kaoiro.runner" >/dev/null 2>&1; then
    printf '%s: com.kaoiro.runner is already loaded — a plist change would need a manual bootout+bootstrap (printed after a real run, never done automatically)\n' "$prog" >&2
  else
    printf '%s: would run: %s bootstrap gui/%s %s\n' "$prog" "$launchctl_bin" "$_uid" "$_plist_path" >&2
  fi
}

apply_systemd() {
  _root=$1
  _unit_dir="$HOME/.config/systemd/user"
  _unit_path="$_unit_dir/kaoiro-runner.service"
  mkdir -p "$_unit_dir"
  _new="$_unit_dir/.kaoiro-runner.service.new.$$"
  render_systemd_unit "$_root" >"$_new" ||
    { rm -f "$_new"; kaoiro_die "failed to render $_unit_path" 70; }
  _changed=yes
  [ ! -e "$_unit_path" ] || ! cmp -s "$_new" "$_unit_path" || _changed=no
  _was_active=no
  ! "$systemctl_bin" --user is-active --quiet kaoiro-runner 2>/dev/null || _was_active=yes
  if [ "$_changed" = yes ]; then
    mv "$_new" "$_unit_path"
    printf '%s: wrote %s\n' "$prog" "$_unit_path" >&2
    "$systemctl_bin" --user daemon-reload
  else
    rm -f "$_new"
    printf '%s: unit file unchanged: %s\n' "$prog" "$_unit_path" >&2
  fi
  "$systemctl_bin" --user enable --now kaoiro-runner
  if [ "$_changed" = yes ] && [ "$_was_active" = yes ]; then
    printf '%s: kaoiro-runner was already running and its unit file just changed — this does NOT restart it for you:\n' "$prog" >&2
    printf '  %s --user restart kaoiro-runner\n' "$systemctl_bin" >&2
  fi
}

apply_launchd() {
  _root=$1
  mkdir -p "$HOME/Library/Logs/kaoiro"
  _agents_dir="$HOME/Library/LaunchAgents"
  mkdir -p "$_agents_dir"
  _plist_path="$_agents_dir/com.kaoiro.runner.plist"
  _new="$_agents_dir/.com.kaoiro.runner.plist.new.$$"
  render_launchd_plist "$_root" >"$_new" ||
    { rm -f "$_new"; kaoiro_die "failed to render $_plist_path" 70; }
  _changed=yes
  [ ! -e "$_plist_path" ] || ! cmp -s "$_new" "$_plist_path" || _changed=no
  _uid=$(id -u)
  _was_loaded=no
  ! "$launchctl_bin" print "gui/$_uid/com.kaoiro.runner" >/dev/null 2>&1 || _was_loaded=yes
  if [ "$_changed" = yes ]; then
    mv "$_new" "$_plist_path"
    printf '%s: wrote %s\n' "$prog" "$_plist_path" >&2
  else
    rm -f "$_new"
    printf '%s: plist unchanged: %s\n' "$prog" "$_plist_path" >&2
  fi
  if [ "$_was_loaded" = no ]; then
    "$launchctl_bin" bootstrap "gui/$_uid" "$_plist_path"
    printf '%s: loaded com.kaoiro.runner\n' "$prog" >&2
  elif [ "$_changed" = yes ]; then
    printf '%s: com.kaoiro.runner was already loaded and its plist just changed — this does NOT reload it for you:\n' "$prog" >&2
    printf '  %s bootout gui/%s/com.kaoiro.runner\n' "$launchctl_bin" "$_uid" >&2
    printf '  %s bootstrap gui/%s %s\n' "$launchctl_bin" "$_uid" "$_plist_path" >&2
  fi
}

# ------------------------------------------------------------------ args --

tarball=
root=
reconfigure=no
dry_run=no

while [ $# -gt 0 ]; do
  case "$1" in
    --install-dir)
      [ $# -ge 2 ] || kaoiro_die "--install-dir needs a value" 64
      kaoiro_reject_option_like --install-dir "$2"
      root=$2
      shift 2
      ;;
    --reconfigure)
      reconfigure=yes
      shift
      ;;
    --dry-run)
      dry_run=yes
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

[ -n "$tarball" ] ||
  kaoiro_die "usage: $prog <tarball> [--install-dir <dir>] [--reconfigure] [--dry-run]" 64
[ -n "$root" ] || root=$(kaoiro_install_root)

# --------------------------------------------------------------- OS branch --
# Decided ONCE, up front: every later step (unit vs plist, systemctl vs
# launchctl) reads this instead of re-deriving it, so the two cannot
# disagree partway through a run.
os=${KAOIRO_UNAME:-$(uname -s)}
case "$os" in
  Linux) service_kind=systemd ;;
  Darwin) service_kind=launchd ;;
  *)
    kaoiro_die "unsupported OS: $os (this script supports Linux/systemd and macOS/launchd only)" 78
    ;;
esac

config_dir=$(kaoiro_config_dir)
config_json="$config_dir/runner.config.json"
config_env="$config_dir/runner.env"

config_exists=no
[ ! -e "$config_json" ] && [ ! -e "$config_env" ] || config_exists=yes

run_wizard=yes
[ "$config_exists" = no ] || [ "$reconfigure" = yes ] || run_wizard=no

# ------------------------------------------------------------------ plan ---

if [ "$dry_run" = yes ]; then
  printf '%s: DRY RUN — nothing below will actually happen\n' "$prog" >&2
  printf '%s: install root: %s\n' "$prog" "$root" >&2
  printf '%s: config dir:   %s (files are never printed)\n' "$prog" "$config_dir" >&2
  if [ "$run_wizard" = yes ]; then
    printf '%s: would run the setup wizard (%s)\n' "$prog" "$deploy_dir/kaoiro-runner-setup.sh" >&2
  else
    printf '%s: would SKIP the setup wizard — %s already exists (pass --reconfigure to force it)\n' \
      "$prog" "$config_dir" >&2
  fi
  # install.sh has no side-effect-free way to report the release id a
  # tarball WOULD get without extracting it (its own header explains why a
  # second, independent read of the id — from anywhere but the verified
  # tree itself — is exactly the class of bug ADR-0053 closed). Naming the
  # tarball here instead of a guessed id is the honest plan.
  printf '%s: would install %s into %s/releases/\n' "$prog" "$tarball" "$root" >&2
  printf '%s: would switch %s/current to the newly-installed release\n' "$prog" "$root" >&2
  case "$service_kind" in
    systemd) plan_systemd "$root" ;;
    launchd) plan_launchd "$root" ;;
  esac
  exit 0
fi

# --------------------------------------------------------------- worker ---

# mkdir -p BEFORE the lock, same as kaoiro-runner-install.sh's own
# mkdir -p "$root/releases" before ITS lock: `mkdir "$root/.lock.bootstrap"`
# needs `$root` to already exist, and on a genuinely fresh host — the exact
# case this script exists for — nothing has created it yet. Without this,
# a missing `$root` and an ACTUAL concurrent run both fail the same mkdir,
# and kaoiro_lock_acquire cannot tell them apart; it would misreport
# "another run holds it" for a host that never had one.
mkdir -p "$root"
lock="$root/.lock.bootstrap"
kaoiro_lock_acquire "$lock"
trap 'kaoiro_lock_release "$lock"' EXIT INT TERM

if [ "$run_wizard" = yes ]; then
  if [ "$reconfigure" = yes ] && [ "$config_exists" = yes ]; then
    stamp=$(date +%s)
    for f in "$config_json" "$config_env"; do
      [ -e "$f" ] || continue
      printf '%s: backing up %s -> %s.bak-%s\n' "$prog" "$f" "$f" "$stamp" >&2
      cp -p "$f" "$f.bak-$stamp"
    done
  fi
  printf '%s: running the setup wizard\n' "$prog" >&2
  "$deploy_dir/kaoiro-runner-setup.sh"
else
  printf '%s: %s already exists — skipping the setup wizard (pass --reconfigure to re-run it)\n' \
    "$prog" "$config_dir" >&2
fi

printf '%s: installing %s\n' "$prog" "$tarball" >&2
id=$("$deploy_dir/kaoiro-runner-install.sh" "$tarball" --install-dir "$root")
printf '%s: installed release %s\n' "$prog" "$id" >&2

printf '%s: switching current to %s\n' "$prog" "$id" >&2
"$deploy_dir/kaoiro-runner-switch.sh" "$id" --install-dir "$root" >/dev/null

case "$service_kind" in
  systemd) apply_systemd "$root" ;;
  launchd) apply_launchd "$root" ;;
esac

printf '%s: done — %s is running release %s\n' "$prog" "$service_kind" "$id" >&2
