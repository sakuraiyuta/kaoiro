import assert from "node:assert/strict";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { fsyncExistingPath, writeFileDurably } from "../kaoiro-deploy-atomic-write.mjs";

// Wraps the real fs calls to record the ORDER they run in — that is
// what actually pins the durability contract from ふじ design review M3
// ("temp create -> fsync(file) -> rename -> fsync(dir)"), not merely
// "these functions all got called somewhere". node:fs's own exports are
// non-configurable, so this drives the module's own `fsImpl` seam
// instead of trying to mock node:fs directly.
function trackingFs(calls) {
  return {
    openSync: (...args) => {
      const fd = openSync(...args);
      calls.push({ op: "open", path: args[0], fd });
      return fd;
    },
    writeSync: (...args) => {
      calls.push({ op: "write", fd: args[0] });
      return writeSync(...args);
    },
    fsyncSync: (...args) => {
      calls.push({ op: "fsync", fd: args[0] });
      return fsyncSync(...args);
    },
    renameSync: (...args) => {
      calls.push({ op: "rename" });
      return renameSync(...args);
    },
    closeSync: (...args) => {
      calls.push({ op: "close", fd: args[0] });
      return closeSync(...args);
    },
  };
}

test("writeFileDurably fsyncs the file before rename, and the directory after", () => {
  const dir = mkdtempSync(join(tmpdir(), "kaoiro-deploy-atomic-"));
  const target = join(dir, "out.txt");
  const calls = [];
  try {
    writeFileDurably(target, "hello\n", trackingFs(calls));
    const ops = calls.map((c) => c.op);
    assert.deepEqual(ops, ["open", "write", "fsync", "close", "rename", "open", "fsync", "close"]);

    // The two opens are DIFFERENT targets (temp file, then the directory
    // itself) — an ordering check alone would not catch a bug that
    // fsyncs the wrong fd twice instead of the directory.
    assert.equal(calls[0].path, `${target}.tmp.${process.pid}`);
    assert.equal(calls[5].path, dir);

    // The fsync/close pair around each open must reference the SAME fd
    // that open returned, not a stale one from the previous open.
    assert.equal(calls[2].fd, calls[0].fd);
    assert.equal(calls[3].fd, calls[0].fd);
    assert.equal(calls[6].fd, calls[5].fd);
    assert.equal(calls[7].fd, calls[5].fd);

    assert.equal(readFileSync(target, "utf8"), "hello\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeFileDurably uses the real fs by default", () => {
  const dir = mkdtempSync(join(tmpdir(), "kaoiro-deploy-atomic-default-"));
  const target = join(dir, "out.txt");
  try {
    writeFileDurably(target, "world\n");
    assert.equal(readFileSync(target, "utf8"), "world\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// issue #322 M4 (must-fix): fsyncExistingPath fsyncs a path THIS process
// did not itself write (a docker/tar-produced archive, or a directory it
// just added an entry to) — same durability gap as writeFileDurably's
// own dir-fsync step, applied to paths that step never covers.
test("fsyncExistingPath opens, fsyncs, and closes — for a file", () => {
  const dir = mkdtempSync(join(tmpdir(), "kaoiro-deploy-atomic-fsync-"));
  const target = join(dir, "archive.tar.gz");
  writeFileSync(target, "not really a tarball, just needs to exist\n");
  const calls = [];
  try {
    fsyncExistingPath(target, trackingFs(calls));
    assert.deepEqual(
      calls.map((c) => c.op),
      ["open", "fsync", "close"],
    );
    assert.equal(calls[0].path, target);
    assert.equal(calls[1].fd, calls[0].fd);
    assert.equal(calls[2].fd, calls[0].fd);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fsyncExistingPath opens, fsyncs, and closes — for a directory (the mkdirSync durability case)", () => {
  const parent = mkdtempSync(join(tmpdir(), "kaoiro-deploy-atomic-fsync-dir-"));
  const child = join(parent, "20260907T000000Z");
  mkdirSync(child);
  const calls = [];
  try {
    // Mirrors kaoiro-server-deploy.mjs's own call shape: fsync the
    // PARENT after mkdirSync adds a new entry to it, not the new
    // directory itself.
    fsyncExistingPath(parent, trackingFs(calls));
    assert.deepEqual(
      calls.map((c) => c.op),
      ["open", "fsync", "close"],
    );
    assert.equal(calls[0].path, parent);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("fsyncExistingPath uses the real fs by default", () => {
  const dir = mkdtempSync(join(tmpdir(), "kaoiro-deploy-atomic-fsync-default-"));
  const target = join(dir, "archive.tar.gz");
  writeFileSync(target, "hello\n");
  try {
    assert.doesNotThrow(() => fsyncExistingPath(target));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fsyncExistingPath throws (never silently succeeds) when the path does not exist", () => {
  const dir = mkdtempSync(join(tmpdir(), "kaoiro-deploy-atomic-fsync-missing-"));
  try {
    assert.throws(() => fsyncExistingPath(join(dir, "never-created.tar.gz")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// issue #322 M4: pins that a fsyncSync failure PROPAGATES rather than
// being swallowed, and that the fd is still closed (the `finally`) even
// though the call that throws happens between open and close — a bug
// class the real `writeFileDurably` test above cannot catch on its own
// happy-path fixture, since fsyncSync never legitimately fails there.
test("fsyncExistingPath propagates a fsyncSync failure and still closes the fd", () => {
  const dir = mkdtempSync(join(tmpdir(), "kaoiro-deploy-atomic-fsync-fail-"));
  const target = join(dir, "archive.tar.gz");
  writeFileSync(target, "hello\n");
  const calls = [];
  const failingFs = {
    ...trackingFs(calls),
    fsyncSync: (...args) => {
      calls.push({ op: "fsync", fd: args[0] });
      throw new Error("simulated fsync failure (issue #322 M4 guard)");
    },
  };
  try {
    assert.throws(() => fsyncExistingPath(target, failingFs), /simulated fsync failure/);
    assert.deepEqual(
      calls.map((c) => c.op),
      ["open", "fsync", "close"],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
