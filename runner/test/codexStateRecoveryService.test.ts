import "../../scripts/test/fixtures/test-isolation.mjs";
import { describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DigestMismatch, PRECONDITIONS, SERVICE_PATHS, deactivate, digestChanges, drive, reach, serviceProblems } from "./codexStateRecoveryRecipes.js";

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
    expect(run("stop-start", "start\nstop\n")).toHaveLength(1);
    expect(run("stop-start", "stop\nstart\nstart\n")).toHaveLength(1);
    expect(run("stop-start", "stop\n")).toHaveLength(1);
    expect(run("stop-start", "stop\nsta")).toHaveLength(1);
    expect(run("untouched", "stop\n")).toHaveLength(1);
    expect(run("stop", "")).toHaveLength(1);
    expect(run("start", "stop\n")).toHaveLength(1);
  });
  it("rejects a final activity that differs from the expectation even when the calls match", () => {
    expect(serviceProblems({ before: "active", op: "stop-start" }, seen(["", "stop\nstart\n"], ["active", "inactive"]), "active")).toHaveLength(1);
    expect(serviceProblems({ before: "inactive", op: "untouched" }, seen(["", ""], ["inactive", "active"]), "inactive")).toHaveLength(1);
  });
  it("rejects a log that does not extend the log before the run, whatever its length", () => {
    expect(serviceProblems({ before: "active", op: "stop" }, seen(["stop\nstart\n", "stop\n"], ["active", "inactive"]), "inactive")).toHaveLength(1);
    expect(serviceProblems({ before: "active", op: "stop" }, seen(["start\n", "stop\nstop\n"], ["active", "inactive"]), "inactive")).toHaveLength(1);
    expect(serviceProblems({ before: "active", op: "untouched" }, seen(["stop\n", ""], ["active", "active"]), "active")).toHaveLength(1);
  });
  it("rejects a wrong initial activity and an unknown operation", () => {
    expect(serviceProblems({ before: "inactive", op: "untouched" }, seen(["", ""], ["active", "active"]), "active")).toHaveLength(1);
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

describe("service observation: the zero-mutation digest", () => {
  const entries = (active: string, calls: string, env = "e1") => [`active f 600 6 ${active}`, `calls f 600 5 ${calls}`, `config d 700`, `config/runner.env f 600 9 ${env}`];
  it("leaves out only the named paths", () => {
    expect(digestChanges(entries("a", "c"), entries("b", "d"), SERVICE_PATHS)).toEqual([]);
    expect(digestChanges(entries("a", "c"), entries("b", "d"), ["calls"])).toEqual(["active"]);
    expect(digestChanges(entries("a", "c"), entries("b", "d"), ["active"])).toEqual(["calls"]);
    expect(digestChanges(entries("a", "c"), entries("a", "c", "e2"), SERVICE_PATHS)).toEqual(["config/runner.env"]);
    expect(digestChanges(entries("a", "c"), entries("a", "c"), SERVICE_PATHS)).toEqual([]);
    expect(SERVICE_PATHS).toEqual(["active", "calls"]);
  });
  it("sees an entry that appears or disappears", () => {
    expect(digestChanges(entries("a", "c"), entries("a", "c").slice(0, 3), SERVICE_PATHS)).toEqual(["config/runner.env"]);
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
