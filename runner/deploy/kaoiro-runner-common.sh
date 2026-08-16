#!/bin/sh
# Shared helpers for the release-based deployment scripts (issue #229):
# kaoiro-runner-install.sh, kaoiro-runner-switch.sh and
# kaoiro-runner-update.sh source this file. Never executed directly.
#
# kaoiro-runner-launch.sh deliberately does NOT source it. The shim runs on
# every service start; keeping it self-contained means one more file missing
# from a release cannot turn into a startup failure that is harder to read
# than the artifact check it was supposed to perform.
#
# Callers set `prog` before sourcing so diagnostics name the script the
# operator actually ran.
: "${prog:=kaoiro-runner}"

kaoiro_die() {
  printf '%s: %s\n' "$prog" "$1" >&2
  exit "${2:-1}"
}

# Install root: holds releases/<id>/, plus the `current` and `previous`
# symlinks (issue #229). Distinct from the CONFIG dir resolved by
# kaoiro-runner-launch.sh / setup.ts's resolveConfigDir(), because a release
# is machine-generated multi-GB state, not operator-edited configuration.
#
# On macOS the two resolve to the SAME directory: Application Support is the
# platform's only per-user location for both, and Apple has no XDG-style data
# / config split. The entry names do not collide (releases/, current,
# previous vs runner.config.json, runner.env).
kaoiro_install_root() {
  if [ -n "${KAOIRO_RUNNER_INSTALL_DIR:-}" ]; then
    printf '%s\n' "$KAOIRO_RUNNER_INSTALL_DIR"
    return 0
  fi
  [ -n "${HOME:-}" ] ||
    kaoiro_die "HOME is unset; pass --install-dir or set KAOIRO_RUNNER_INSTALL_DIR"
  if [ "$(uname -s)" = "Darwin" ]; then
    printf '%s\n' "$HOME/Library/Application Support/kaoiro"
  else
    printf '%s\n' "${XDG_DATA_HOME:-$HOME/.local/share}/kaoiro"
  fi
}

# mkdir is atomic, so it doubles as the lock — the same mechanism
# scripts/build-runner-tarball.sh already uses. A SIGKILLed run leaves the
# dir behind and the next run says so rather than silently proceeding.
kaoiro_lock_acquire() {
  mkdir "$1" 2>/dev/null && return 0
  printf '%s: another run holds %s\n' "$prog" "$1" >&2
  printf '%s: wait for it, or remove a stale lock dir\n' "$prog" >&2
  exit 75 # EX_TEMPFAIL
}

kaoiro_lock_release() {
  rmdir "$1" 2>/dev/null || true
}

# systemd user units and launchd agents start with a minimal PATH, so a
# version-managed node (nvm / fnm / asdf) has to be pinned via KAOIRO_NODE —
# same contract as kaoiro-runner-launch.sh.
kaoiro_node() {
  node_bin="${KAOIRO_NODE:-node}"
  command -v "$node_bin" >/dev/null 2>&1 ||
    kaoiro_die "node not found: $node_bin (set KAOIRO_NODE)" 78
  printf '%s\n' "$node_bin"
}

# A value beginning with `-` can be parsed as an OPTION by whatever command it
# reaches next (tar, systemctl, systemd-run) — no shell metacharacter needed,
# and quoting does not help because quoting only closes the shell layer.
# Rejecting it at the boundary is cheaper than auditing every downstream
# parser for a `--` escape we remembered to pass.
kaoiro_reject_option_like() {
  case "$2" in
    -*) kaoiro_die "$1 must not begin with '-': $2" 64 ;;
  esac
}

# A release id is used as a PATH COMPONENT, so it is validated before it ever
# reaches the filesystem: it comes from a VERSION file inside an archive, and
# an id such as `../../etc` would otherwise escape the install root. The
# domain is exactly what scripts/build-identity.mjs's formatIdentityString
# emits from a validated build-info.json (ADR-0053) — a 40-hex SHA or the
# literal `unknown`, optionally `-dirty`.
#
# THE `case` GLOB IS THE GUARD; the grep only pins the shape. grep's `^` and
# `$` anchor to LINE boundaries and `-q` succeeds when ANY line matches, so
# grep alone validates a MULTI-LINE value as long as one of its lines is
# well-formed. Measured 2026-08-16 against the real script: a VERSION file
# holding `../../pwned-marker\n<40 hex>` passed, and install wrote the
# release tree two directories ABOVE the install root, exit 0 — an
# arbitrary-path write driven by tarball content. `$(cat FILE)` strips only
# TRAILING newlines, so embedded ones survive into the id, and a newline is
# not a path separator, so it does not interrupt traversal either.
#
# The glob rejects every byte outside the id alphabet — which covers the
# newline, and the `/` and `.` a traversal needs — so by the time grep runs
# there is exactly one line for its anchors to bind to.
kaoiro_valid_release_id() {
  # Strip the optional suffix FIRST so the alphabet check can be exact. A
  # single glob over the whole id would have to admit d/i/r/t/y for
  # `-dirty`'s sake, which is most of what it is meant to exclude.
  _rid=${1%-dirty}
  case $_rid in
    unknown) return 0 ;;
    '' | *[!0-9a-f]*) return 1 ;;
  esac
  printf '%s' "$_rid" | LC_ALL=C grep -qE '^[0-9a-f]{40}$'
}

# An id that identifies its CONTENT: a clean 40-hex SHA and nothing else.
#
# `unknown` names no commit, and `-dirty` says the working tree carried
# changes the SHA does not describe — two dirty builds of one commit share an
# id while differing in content (ADR-0053: revision plus dirty is the
# identity, and dirty means "this SHA does not tell you what is here").
# Activating either would make `current` a name that does not determine what
# runs, which is the exact failure this release layout exists to remove, so
# production activation is restricted to this domain and anything else needs
# an explicit --allow-dirty.
kaoiro_clean_release_id() {
  # Same two-stage check, and for the same reason, as
  # kaoiro_valid_release_id: the glob is what makes the value single-line,
  # the grep only pins its shape. Not merely defence in depth — this
  # decides whether an id may become `current`, and callers reach it by
  # more than one route.
  case $1 in
    '' | *[!0-9a-f]*) return 1 ;;
  esac
  printf '%s' "$1" | LC_ALL=C grep -qE '^[0-9a-f]{40}$'
}

# Removes leftover staging dirs from a run that died before its EXIT trap
# (SIGKILL, power loss). Without this they accumulate silently — up to
# ~1.2 GB each, named after a dead pid, and nothing else ever revisits them.
#
# `$2` IS THE PREFIX OF THE DIRS THE CALLER ITSELF CREATES, and a caller must
# never pass another script's. What licenses the deletion is "no other run of
# THIS script can be in flight", and that comes from the caller's own lock —
# which says nothing about anyone else's. install and update hold DIFFERENT
# locks, and update INVOKES install, so a glob wide enough to span both had
# the nested install delete the update's live build dir, tarball and all:
# every `--from-repo` update failed with `tar: Cannot open`, exit 2
# (reproduced 2026-08-16). Narrowing each caller to its own prefix is what
# makes the exclusivity premise true again.
#
# Call it BEFORE creating this run's own staging dir, or it deletes that too.
# `.staging.` also stays distinct from `.lock.` so the glob cannot catch the
# lock the caller is currently holding.
kaoiro_gc_staging() {
  _root=$1
  _prefix=$2
  for _stale in "$_root/$_prefix".*; do
    [ -e "$_stale" ] || continue
    printf '%s: removing abandoned staging dir %s\n' "$prog" "$_stale" >&2
    rm -rf "$_stale"
  done
}

# Full verification of a release tree, delegated to verify-release.mjs (see
# that file for what it checks and why the checks live in one place).
#
# Install-time and activation-time verification is the STRICT mode: a
# manifest is required and every entry's sha256 is compared. Neither caller
# is latency-sensitive, and both decide whether a tree may become `current` —
# the point at which a defect stops being recoverable cheaply. The service
# start path deliberately runs the same verifier in existence-only mode
# instead; see kaoiro-runner-launch.sh.
# Sets KAOIRO_VERIFIED_IDENTITY to the identity the tree proved it has —
# taken from the verifier's stdout, not from a second read of VERSION. The
# caller naming a directory after an id it read separately is exactly how the
# directory name and the tree's own build-info came to disagree.
# shellcheck disable=SC2034,SC2154 # KAOIRO_VERIFIED_IDENTITY is read by the
# sourcing script, and `deploy_dir` is assigned by it before this file is
# sourced — neither crosses shellcheck's single-file view.
kaoiro_verify_release_tree() {
  _tree=$1
  # ALWAYS our own copy of the verifier, never "$_tree/deploy/". install runs
  # this against a tree that was just unpacked from an archive, and an
  # archive that supplies the program judging it certifies itself.
  KAOIRO_VERIFIED_IDENTITY=$(
    "$(kaoiro_node)" "$deploy_dir/verify-release.mjs" \
      "$_tree" --require-manifest --hash
  ) || kaoiro_die "release tree failed verification: $_tree" 70
  [ -x "$_tree/deploy/kaoiro-runner-launch.sh" ] ||
    kaoiro_die "release tree is incomplete: deploy/kaoiro-runner-launch.sh missing or not executable in $_tree" 70
}

# Replaces the symlink at $1 with one pointing at $2, atomically.
#
# `mv` cannot do this portably. Plain `mv link dest` FOLLOWS dest when dest is
# a symlink to a directory and moves the new link INSIDE the old release —
# measured on GNU coreutils 9.4: `current` still pointed at the old release
# and a stray `.tmp` link was left inside it, silently. GNU's `mv -T` is
# correct but is not in BSD / macOS mv. rename(2) has the required semantics
# on every platform, and node is already a hard prerequisite of the runner,
# so the swap goes through node.
#
# Paths are passed as argv, never interpolated into the -e source, so a path
# containing quotes or backslashes cannot alter the program.
kaoiro_symlink_swap() {
  # shellcheck disable=SC2016 # `${link}` below is a JS template literal, and
  # keeping the program out of the shell's expansion is the whole point.
  "$(kaoiro_node)" -e '
const fs = require("node:fs");
const [link, target] = process.argv.slice(1);
const tmp = `${link}.tmp.${process.pid}`;
fs.symlinkSync(target, tmp);
try {
  fs.renameSync(tmp, link);
} catch (err) {
  fs.unlinkSync(tmp);
  throw err;
}
' "$1" "$2"
}
