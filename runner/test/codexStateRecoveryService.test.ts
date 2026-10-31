import "../../scripts/test/fixtures/test-isolation.mjs";
import { describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DigestMismatch, PRECONDITIONS, SERVICE_PATHS, deactivate, digestChanges, digestEntries, drive, reach, serviceProblems } from "./codexStateRecoveryRecipes.js";

// Self-tests of the service observation in drive() and of the checks on the
// service declarations: each one must fail on its own input (issue 863).
const seen = (calls: [string, string], active: [string, string]) => ({ callsBefore: calls[0], callsAfter: calls[1], activeBefore: active[0], activeAfter: active[1] });

describe("service observation: serviceProblems", () => {
  it("accepts each operation with its exact suffix, and an unchanged run", () => {
    expect(serviceProblems({ before: "active", op: "untouched" }, seen(["stop\nstart\n", "stop\nstart\n"], ["active", "active"]), "active")).toEqual([]);
    expect(serviceProblems({ before: "active", op: "stop" }, seen(["", "stop\n"], ["active", "inactive"]), "inactive")).toEqual([]);
    expect(serviceProblems({ before: "inactive", op: "start" }, seen(["stop\n", "stop\nstart\n"], ["inactive", "active"]), "active")).toEqual([]);
    expect(serviceProblems({ before: "active", op: "stop-start" }, seen(["", "stop\nstart\n"], ["active", "active"]), "active")).toEqual([]);
  });
  it("rejects a reversed, extra, missing or incomplete suffix", () => {
    const run = (op: string, suffix: string) => serviceProblems({ before: "active", op }, seen(["x\n", `x\n${suffix}`], ["active", "active"]), "active");
    const wanted = { untouched: "", stop: "stop\n", start: "start\n", "stop-start": "stop\nstart\n" } as Record<string, string>;
    const declared = (op: string, suffix: string) => [`calls ${JSON.stringify(suffix)}, declared ${op} ${JSON.stringify(wanted[op])}`];
    expect(run("stop-start", "start\nstop\n")).toEqual(declared("stop-start", "start\nstop\n"));
    expect(run("stop-start", "stop\nstart\nstart\n")).toEqual(declared("stop-start", "stop\nstart\nstart\n"));
    expect(run("stop-start", "stop\n")).toEqual(declared("stop-start", "stop\n"));
    expect(run("stop-start", "stop\nsta")).toEqual(declared("stop-start", "stop\nsta"));
    expect(run("untouched", "stop\n")).toEqual(declared("untouched", "stop\n"));
    expect(run("stop", "")).toEqual(declared("stop", ""));
    expect(run("start", "stop\n")).toEqual(declared("start", "stop\n"));
  });
  it("rejects a final activity that differs from the expectation even when the calls match", () => {
    expect(serviceProblems({ before: "active", op: "stop-start" }, seen(["", "stop\nstart\n"], ["active", "inactive"]), "active")).toEqual(["final activity inactive, expected active"]);
    expect(serviceProblems({ before: "inactive", op: "untouched" }, seen(["", ""], ["inactive", "active"]), "inactive")).toEqual(["final activity active, expected inactive"]);
  });
  it("rejects a log that does not extend the log before the run, whatever its length", () => {
    const extend = ["the call log after the run does not extend the log before it"];
    expect(serviceProblems({ before: "active", op: "stop" }, seen(["stop\nstart\n", "stop\n"], ["active", "inactive"]), "inactive")).toEqual(extend);
    expect(serviceProblems({ before: "active", op: "stop" }, seen(["start\n", "stop\nstop\n"], ["active", "inactive"]), "inactive")).toEqual(extend);
    expect(serviceProblems({ before: "active", op: "untouched" }, seen(["stop\n", ""], ["active", "active"]), "active")).toEqual(extend);
  });
  it("rejects a wrong initial activity and an unknown operation", () => {
    expect(serviceProblems({ before: "inactive", op: "untouched" }, seen(["", ""], ["active", "active"]), "active")).toEqual(["initial activity active, declared inactive"]);
    expect(serviceProblems({ before: "active", op: "restart" }, seen(["", ""], ["active", "active"]), "active")).toEqual(["unknown operation restart"]);
  });
});

describe("service observation: the active variants", () => {
  it("run a service that exists as an owned child, not only as an `active` file", async () => {
    const c = await reach("replace-L3");
    try {
      expect(PRECONDITIONS["owned-service"]!(c), "inactive service").toBe(false);
      writeFileSync(join(c.h.dir, "active"), "active");
      expect(PRECONDITIONS["owned-service"]!(c), "an `active` file alone").toBe(false);
    } finally { await c.h.close(); }
  }, 60_000);
  it("refuse to run when the declared precondition of the variant does not hold", async () => {
    const c = await reach("replace-L3");
    try {
      const failure = await drive("Q-bad:active", c, { prepare: deactivate }).then(() => undefined, (error: unknown) => error);
      expect(String((failure as Error | undefined)?.message), "the run must fail at the service precondition").toContain("service precondition owned-service");
    } finally { await c.h.close(); }
  }, 60_000);
});

describe("service observation: an injected fault", () => {
  it("is the failure that the run reports, not just any failure with the same service calls", async () => {
    const c = await reach("restore-prepared");
    try {
      const failure = await drive("R-RES-stage-copy", c, { injected: "text that no refusal prints" }).then(() => undefined, (error: unknown) => error);
      expect(String((failure as Error | undefined)?.message), "the run must fail at the injected-text assertion").toContain("text that no refusal prints");
    } finally { await c.h.close(); }
  }, 60_000);
});

describe("service observation: the zero-mutation digest", () => {
  // Path -> digest line, as digestEntries returns it.
  const rows = (active: string, calls: string, env = "e1") => new Map([["active", `active f 600 6 ${active}`], ["calls", `calls f 600 5 ${calls}`], ["config", "config d 700"], ["config/runner.env", `config/runner.env f 600 9 ${env}`]]);
  it("leaves out only the named paths", () => {
    expect(digestChanges(rows("a", "c"), rows("b", "d"), SERVICE_PATHS)).toEqual([]);
    expect(digestChanges(rows("a", "c"), rows("b", "d"), ["calls"])).toEqual(["active"]);
    expect(digestChanges(rows("a", "c"), rows("b", "d"), ["active"])).toEqual(["calls"]);
    expect(digestChanges(rows("a", "c"), rows("a", "c", "e2"), SERVICE_PATHS)).toEqual(["config/runner.env"]);
    expect(digestChanges(rows("a", "c"), rows("a", "c"), SERVICE_PATHS)).toEqual([]);
    expect(SERVICE_PATHS).toEqual(["active", "calls"]);
  });
  it("sees an entry that appears or disappears", () => {
    const fewer = rows("a", "c");
    fewer.delete("config/runner.env");
    expect(digestChanges(rows("a", "c"), fewer, SERVICE_PATHS)).toEqual(["config/runner.env"]);
    expect(digestChanges(fewer, rows("a", "c"), SERVICE_PATHS)).toEqual(["config/runner.env"]);
  });
  // A path that contains a space, or that starts with an ignored path, is its own path.
  it("keeps paths that contain spaces or share a prefix apart, and ignores a path only as a whole", () => {
    const keys = (names: string[], changed = "") => new Map(names.map(name => [name, `${name} f 600 1 ${name === changed ? "new" : "old"}`] as const));
    const names = ["config/a b", "config/a c", "active b", "calls.old", "active", "calls"];
    expect(digestChanges(keys(names), keys(names, "config/a b"), SERVICE_PATHS)).toEqual(["config/a b"]);
    expect(digestChanges(keys(names), keys(names, "config/a c"), SERVICE_PATHS)).toEqual(["config/a c"]);
    expect(digestChanges(keys(names), keys(names, "active b"), SERVICE_PATHS)).toEqual(["active b"]);
    expect(digestChanges(keys(names), keys(names, "calls.old"), SERVICE_PATHS)).toEqual(["calls.old"]);
    expect(digestChanges(keys(names), keys(names, "active"), SERVICE_PATHS)).toEqual([]);
  });
  it("sees a change of one of two files whose names share a prefix up to a space, through the real digest", () => {
    const dir = mkdtempSync(join(tmpdir(), "digest-keys-"));
    try {
      mkdirSync(join(dir, "config"));
      for (const name of ["config/a b", "config/a c", "active"]) writeFileSync(join(dir, name), "1");
      const before = digestEntries(dir);
      writeFileSync(join(dir, "config/a b"), "2");
      expect([...before.keys()]).toEqual(["active", "config", "config/a b", "config/a c"]);
      expect(digestChanges(before, digestEntries(dir), SERVICE_PATHS)).toEqual(["config/a b"]);
      writeFileSync(join(dir, "active"), "2");
      expect(digestChanges(before, digestEntries(dir), SERVICE_PATHS)).toEqual(["config/a b"]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("sees changes to directories and symlinks whose names share a prefix through a space", () => {
    const dir = mkdtempSync(join(tmpdir(), "digest-entry-keys-"));
    const dA = "config/d a", dB = "config/d b", lA = "config/l a", lB = "config/l b";
    try {
      mkdirSync(join(dir, "config"));
      mkdirSync(join(dir, dA)); mkdirSync(join(dir, dB));
      chmodSync(join(dir, dA), 0o755); chmodSync(join(dir, dB), 0o755);
      symlinkSync("target a", join(dir, lA)); symlinkSync("target b", join(dir, lB));
      const before = digestEntries(dir);
      expect([...before.keys()]).toEqual(["config", dA, dB, lA, lB]);
      chmodSync(join(dir, dA), 0o700);
      expect(digestChanges(before, digestEntries(dir), SERVICE_PATHS)).toEqual([dA]);
      const beforeLink = digestEntries(dir);
      unlinkSync(join(dir, lA)); symlinkSync("target changed", join(dir, lA));
      expect(digestChanges(beforeLink, digestEntries(dir), SERVICE_PATHS)).toEqual([lA]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  // The active stop of Q-bad rewrites only `active` and `calls`; a write by the
  // stop itself (the fake appends to the runner environment when asked) is
  // outside the exception and must be what the comparison reports.
  it("rejects a write by the observed stop outside the two service files", async () => {
    const c = await reach("replace-L3");
    try {
      const failure = await drive("Q-bad:active", c, { prepare: run => run.h.trigger("late-config") }).then(() => undefined, (error: unknown) => error);
      expect(failure, "the run must fail at the digest comparison").toBeInstanceOf(DigestMismatch);
      expect((failure as DigestMismatch).paths).toEqual(["config/runner.env"]);
    } finally { await c.h.close(); }
  }, 120_000);
});
