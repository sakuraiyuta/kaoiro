import assert from "node:assert/strict";
import { closeSync, fsyncSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { writeFileDurably } from "../kaoiro-deploy-atomic-write.mjs";

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
