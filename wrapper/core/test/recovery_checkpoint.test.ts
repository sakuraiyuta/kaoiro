import "../../../scripts/test/fixtures/test-isolation.mjs";
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readRecoveryCheckpoint, RecoveryReporter, writeRecoveryCheckpoint } from "../src/recovery_checkpoint.js";
import type { WrapperConfig } from "@kaoiro/protocol";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(kind?: "candidate") {
  const root = mkdtempSync(join(tmpdir(), "kaoiro-recovery-test-")); roots.push(root);
  const path = join(root, "checkpoint");
  writeRecoveryCheckpoint(path, { version: 1, state: "initial" });
  expect(readRecoveryCheckpoint(path)).toEqual({ ok: true, record: { version: 1, state: "initial" } });
  const failures: number[] = [];
  const config = { recovery_checkpoint_path: path, ...(kind ? { recovery_resume_kind: kind } : {}) } as WrapperConfig;
  const reporter = new RecoveryReporter(config, "requested", failure => failures.push(failure.exitCode));
  return { path, reporter, failures, read: () => readRecoveryCheckpoint(path) };
}
describe("launch recovery checkpoint", () => {
  it("distinguishes launcher initial from wrapper unbound and uses private files", () => {
    const { path, read } = fixture();
    expect(read()).toEqual({ ok: true, record: { version: 1, state: "unbound" } });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
  it("records the first-turn candidate before any successful terminal and confirms attach", () => {
    const { reporter, read } = fixture();
    expect(reporter.observe("first-turn")).toBe(true);
    expect(read()).toEqual({ ok: true, record: { version: 1, state: "unbound", candidate_id: "first-turn" } });
    expect(reporter.accept("first-turn", "first-turn")).toBe(true);
    expect(read()).toEqual({ ok: true, record: { version: 1, state: "live", session_id: "first-turn" } });
    reporter.observe("rebind");
    expect(reporter.confirm("first-turn")).toBe(false);
    expect(read()).toEqual({ ok: true, record: { version: 1, state: "unbound", candidate_id: "rebind" } });
  });
  it("retains the attempted candidate through initialization, but clears a refusal", () => {
    const { reporter, read, failures } = fixture("candidate");
    expect(read()).toEqual({ ok: true, record: { version: 1, state: "unbound", candidate_id: "requested" } });
    reporter.refuseLaunch();
    expect(read()).toEqual({ ok: true, record: { version: 1, state: "unbound" } });
    expect(failures).toEqual([1]);
    expect(reporter.observe("late")).toBe(false);
    reporter.stop("session_binding"); expect(failures).toEqual([1]);
  });
  it.each([undefined, "candidate"] as const)("handles mismatching attach for kind %s", kind => {
    const { reporter, read, failures } = fixture(kind);
    expect(reporter.accept("silently-new", "requested")).toBe(false);
    expect(read()).toEqual({ ok: true, record: kind ? { version: 1, state: "unbound" } : { version: 1, state: "blocked", reason: "session_binding" } });
    expect(failures).toEqual([1]);
  });
  it("keeps a block monotonic against late id/terminal callbacks", () => {
    const { reporter, read } = fixture();
    reporter.observe("id"); reporter.confirm("id"); reporter.block("watchdog");
    expect(reporter.observe("late")).toBe(false); expect(reporter.confirm("id")).toBe(false);
    expect(read()).toEqual({ ok: true, record: { version: 1, state: "blocked", reason: "watchdog", session_id: "id" } });
  });
  it("reports 79 independently when a block write leaves old live readable", () => {
    const { reporter, read, path, failures } = fixture();
    reporter.confirm("old"); mkdirSync(`${path}.tmp`);
    reporter.block("watchdog");
    expect(read()).toEqual({ ok: true, record: { version: 1, state: "live", session_id: "old" } });
    expect(failures).toEqual([79]);
    reporter.refuseLaunch(); expect(reporter.failure?.exitCode).toBe(79);
  });
  it("does not rewrite unchanged live observations", () => {
    const { reporter, path } = fixture(); reporter.confirm("live");
    mkdirSync(`${path}.tmp`);
    expect(reporter.observe("live")).toBe(true);
    expect(reporter.confirm("live")).toBe(true);
    expect(reporter.failure).toBeUndefined();
  });
  it.each(["null", "[]", '{"version":1,"state":"unbound","candidate_id":0}', '{"version":1,"state":"unbound","candidate_id":""}', '{"version":1,"state":"blocked","reason":"other"}', '{"version":1,"state":"blocked","reason":"watchdog","session_id":0}', "{}", '{"version":2,"state":"initial"}', '{"version":1,"state":"other"}', '{"version":1,"state":"live","session_id":""}', "{"])("refuses invalid record %s", raw => {
    const { path } = fixture(); writeFileSync(path, raw);
    expect(readRecoveryCheckpoint(path)).toEqual({ ok: false, reason: "invalid" });
  });
  it("distinguishes unreadable from invalid", () => {
    const { path } = fixture(); rmSync(path);
    expect(readRecoveryCheckpoint(path)).toEqual({ ok: false, reason: "unreadable" });
  });
});

it.each(["watchdog", "session_binding", "resume_rejected", "session_unusable", "checkpoint_unavailable"] as const)("reads the finite block reason %s", reason => {
  const { path } = fixture(); writeRecoveryCheckpoint(path, { version: 1, state: "blocked", reason });
  expect(readRecoveryCheckpoint(path)).toEqual({ ok: true, record: { version: 1, state: "blocked", reason } });
});
it("keeps standalone reporting inert without a checkpoint path", () => {
  const failures: number[] = []; const reporter = new RecoveryReporter({} as WrapperConfig, "expected", f => failures.push(f.exitCode));
  reporter.block("watchdog"); reporter.stop("session_binding"); reporter.refuseLaunch();
  expect(reporter.accept("other", "expected")).toBe(true); expect(reporter.observe("other")).toBe(true);
  expect(reporter.confirm("other")).toBe(true); expect(failures).toEqual([]);
});
