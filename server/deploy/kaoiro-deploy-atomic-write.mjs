#!/usr/bin/env node
// Durable atomic write, shared by manifest.mjs and journal.mjs (ふじ
// design review M3, issue #306). A plain `writeFileSync` + `renameSync`
// gives ATOMIC VISIBILITY (a reader never observes a half-written file)
// but not a DURABLE checkpoint: POSIX does not guarantee a rename
// survives a crash unless the new directory entry is itself fsync'd, and
// the file's own data must be fsync'd before the rename or the
// filesystem may reorder them, leaving the rename pointing at
// zero-length or partial content after a crash.
//
// This writes the temp file in the SAME directory as `target` (so the
// rename is same-filesystem and atomic), fsyncs the file, renames, then
// fsyncs the directory. Every step throws on failure — a caller never
// gets a "probably fine" partial write; deciding what a failed
// checkpoint means for an in-flight deploy transaction is the caller's
// job (M3 review note: "checkpoint failure -> next Docker mutation must
// be zero" is verified at CLI integration, not here).
//
// Also exports `fsyncExistingPath` (issue #322 M4, must-fix): the SAME
// durability gap applies to paths this module's own writer never
// touches — an archive `tar`'d by a docker container onto a bind mount,
// or a transaction directory this process just `mkdirSync`'d — where
// nothing here controlled the write, only the fact that it needs to
// survive a crash too.
import { closeSync, fsyncSync, openSync, renameSync, writeSync } from "node:fs";
import { dirname } from "node:path";

const REAL_FS = { closeSync, fsyncSync, openSync, renameSync, writeSync };

/** `fsImpl` defaults to the real `node:fs` calls above; the only reason
 *  it is a parameter at all is that `node:fs`'s own exports are
 *  non-configurable (`Object.defineProperty` on them throws
 *  "Cannot redefine property"), so `node:test`'s `mock.method` cannot
 *  patch them — this module's own test needs to observe the CALL ORDER
 *  (open -> write -> fsync -> close -> rename -> open -> fsync -> close)
 *  to pin the M3 durability contract, and a tracking `fsImpl` is the
 *  seam that makes that observable without touching the module system. */
export function writeFileDurably(target, content, fsImpl = REAL_FS) {
  const dir = dirname(target);
  const tmp = `${target}.tmp.${process.pid}`;
  const fd = fsImpl.openSync(tmp, "w");
  try {
    fsImpl.writeSync(fd, content);
    fsImpl.fsyncSync(fd);
  } finally {
    fsImpl.closeSync(fd);
  }
  fsImpl.renameSync(tmp, target);
  fsyncExistingPath(dir, fsImpl);
}

/** issue #322 M4 (must-fix): fsync a path this process did NOT itself
 *  write — a docker/tar-produced archive, or a directory this process
 *  just added an entry to (`mkdirSync`) — so its data (file) or its new
 *  entry (directory) survives a crash the same way `writeFileDurably`'s
 *  own steps already do. Opening with `"r"` works for both a regular
 *  file and a directory on POSIX (Linux is this project's only deploy
 *  target — deployment.md's runbook is systemd/Linux throughout), which
 *  is why one function covers both call shapes instead of two. Every
 *  step throws on failure, same contract as `writeFileDurably`: the
 *  caller decides what a failed checkpoint means for the in-flight
 *  transaction, this module only refuses to claim success it did not
 *  measure. */
export function fsyncExistingPath(path, fsImpl = REAL_FS) {
  const fd = fsImpl.openSync(path, "r");
  try {
    fsImpl.fsyncSync(fd);
  } finally {
    fsImpl.closeSync(fd);
  }
}
