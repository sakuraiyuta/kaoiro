import "../../scripts/test/fixtures/test-isolation.mjs";
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RECORD_VARIABLE, createStateFixture, systemctlFrontScript } from "./codexStateFixture.js";
import { runScript } from "./releaseFixture.js";

// The fixture's fake systemctl is a Node script; the shell front answers the
// read-only queries without starting Node (issue 797). These tests pin that the
// front answers exactly like the script, takes the fast path where it should,
// and hands everything else to the script before any side effect.

const SERVICE = "kogane468-test.service";
const PRODUCT_PROPERTIES = ["Transient", "ExecStart", "ExecStartPre", "ExecStartPost", "EnvironmentFiles", "PassEnvironment", "RootDirectory", "RootImage", "KillMode", "Environment", "UnsetEnvironment", "Id", "MainPID", "ActiveState", "ControlGroup"];
const MAINPID = '{"pid":4242,"start":"1"}';
const show = (property: string) => ["--user", "show", `--property=${property}`, "--value", SERVICE];

// Forms the product does not issue today but whose answer the front decides.
const SPEC_FORMS: string[][] = [
  ["--user", "show", "-p", "KillMode", "--value", SERVICE],
  ["--user", "show", "-p", "ExecStart", "--value", SERVICE],
  ["--user", "show", "--property=", "--value", SERVICE],
  ["--user", "show", "--property=KillMode", "--property=MainPID", "--value", SERVICE],
  ["--user", "show", "--property=MainPID", "--property=KillMode", "--value", SERVICE],
  show("FragmentPath"), show("constructor"), show("toString"), show("Unknown"), show("Kill\nMode"),
  ["--user", "show", "--property=KillMode", "--value", "show"],
  ["--user", "show-environment", "show"],
  ["--user", "show", "--property=MainPID"],
  ["--user", "*show*", "--property=KillMode"], ["--user", "show\n", "--property=KillMode"], ["--user", "showx", "--property=KillMode"],
  ["--user", "reset-failed", SERVICE],
];
const MUTATING = (argv: string[]) => argv.includes("stop") || argv.includes("start");

function parseRecords(text: string) {
  return text.split("\x1e\n").filter(record => record !== "").map(record => record.split("\x1f").slice(0, -1));
}

describe.skipIf(process.platform !== "linux")("fixture systemctl front: equals the Node script", { timeout: 240_000 }, () => {
  it("answers the argv recorded from a real forward and restore, and the spec forms, like the script in every state", async () => {
    expect(process.env[RECORD_VARIABLE], `unset ${RECORD_VARIABLE} before running this test`).toBeUndefined();
    const h = await createStateFixture();
    const scratch = mkdtempSync(join(tmpdir(), "fixture-systemctl-"));
    try {
      const record = join(scratch, "record");
      const recording = { ...h.env(), [RECORD_VARIABLE]: record };
      expect(h.env()).not.toHaveProperty(RECORD_VARIABLE);
      const forward = runScript(h.updater, ["--install-dir", h.root, "--service", "kogane468-test", "--tarball", h.tarball(), "--codex-home", h.home, "--codex-backup-dir", join(h.dir, "backup")], recording);
      expect(forward.status, forward.stderr).toBe(0);
      const restore = runScript(h.updater, ["--install-dir", h.root, "--service", "kogane468-test", "--restore-codex-backup", join(h.dir, "backup"), "--codex-home", h.home], recording);
      expect(restore.status, restore.stderr).toBe(0);

      const recorded = new Map<string, string[]>();
      for (const argv of parseRecords(readFileSync(record, "utf8"))) recorded.set(JSON.stringify(argv), argv);
      const names = [...recorded.values()].map(argv => argv.find(a => a.startsWith("--property="))?.slice(11) ?? argv.join(" "));
      for (const property of PRODUCT_PROPERTIES) expect(names, `product query ${property} was not recorded`).toContain(property);
      expect(names).toContain("--user show-environment");
      expect(names.some(name => name.includes("stop")) && names.some(name => name.includes("start"))).toBe(true);

      const argvs = [...new Map([...recorded.values(), ...SPEC_FORMS].map(argv => [JSON.stringify(argv), argv])).values()].filter(argv => !MUTATING(argv));
      expect(argvs.length).toBeGreaterThan(PRODUCT_PROPERTIES.length);

      const path = (name: string) => join(h.dir, name);
      const original = { active: readFileSync(path("active"), "utf8"), mainpid: readFileSync(path("mainpid"), "utf8"), ctl: readFileSync(h.ctl, "utf8") };
      expect(original.mainpid).toMatch(/^\{"pid":[1-9][0-9]*,"start":"[0-9]+"\}$/);
      const baseEnv = h.env();
      expect(baseEnv).not.toHaveProperty(RECORD_VARIABLE);
      const reset = () => {
        writeFileSync(path("active"), "active"); writeFileSync(path("mainpid"), original.mainpid); writeFileSync(h.ctl, original.ctl);
        for (const name of ["activity-fault", "manager-extra", "queries", "activity-count"]) rmSync(path(name), { force: true });
      };
      const states: { name: string; set: () => void; env?: Record<string, string | undefined>; repeat?: number }[] = [
        { name: "base", set: () => {} },
        { name: "inactive", set: () => writeFileSync(path("active"), "inactive") },
        { name: "other active text", set: () => writeFileSync(path("active"), "weird") },
        { name: "active with a newline", set: () => writeFileSync(path("active"), "active\n") },
        { name: "empty active", set: () => writeFileSync(path("active"), "") },
        { name: "pid 0", set: () => writeFileSync(path("mainpid"), '{"pid":0,"start":"1"}') },
        { name: "pid with a leading zero", set: () => writeFileSync(path("mainpid"), '{"pid":05,"start":"1"}') },
        { name: "mainpid with spaces", set: () => writeFileSync(path("mainpid"), '{ "pid": 5, "start": "1" }') },
        { name: "pid over 15 digits", set: () => writeFileSync(path("mainpid"), '{"pid":1234567890123456,"start":"1"}') },
        { name: "duplicate pid key", set: () => writeFileSync(path("mainpid"), '{"pid":5,"pid":9,"start":"1"}') },
        { name: "activity-fault window", set: () => writeFileSync(path("activity-fault"), JSON.stringify({ from: 2, to: 3 })), repeat: 3 },
        { name: "manager-extra", set: () => writeFileSync(path("manager-extra"), "FOO=bar") },
        { name: "rewritten script", set: () => writeFileSync(h.ctl, original.ctl.replace("MainPID:active?String(ownerPid):'0'", "MainPID:'4242'")) },
        { name: "caller environment differs", set: () => {}, env: { HOME: "/nonexistent-caller-home", KAOIRO_RUNNER_DIR: "/nonexistent-caller-runner-dir" } },
      ];
      expect(states.length).toBe(14);
      const run = (bin: string, argv: string[], env: Record<string, string | undefined>, repeat: number) => {
        for (const name of ["queries", "activity-count"]) rmSync(path(name), { force: true });
        const outcomes = [];
        for (let i = 0; i < repeat; i++) {
          const result = spawnSync(bin, argv, { env: env as NodeJS.ProcessEnv, encoding: "utf8" });
          outcomes.push([result.status, result.stdout, result.stderr.split("\n")[0]?.replaceAll(h.dir, "<dir>")]);
        }
        const side = (name: string) => (existsSync(path(name)) ? readFileSync(path(name), "utf8") : null);
        return JSON.stringify([outcomes, side("queries"), side("activity-count")]);
      };
      const differences: string[] = [];
      let compared = 0;
      for (const state of states) {
        const env = { ...baseEnv, ...state.env };
        for (const argv of argvs) {
          reset(); state.set();
          const expected = run(h.ctl, argv, env, state.repeat ?? 1);
          reset(); state.set();
          const actual = run(h.systemctl, argv, env, state.repeat ?? 1);
          compared++;
          if (actual !== expected) differences.push(`${state.name}: ${JSON.stringify(argv)}\n  script ${expected}\n  front  ${actual}`);
        }
      }
      reset();
      expect(compared).toBe(states.length * argvs.length);
      expect(differences, `${differences.length} of ${compared} differ`).toEqual([]);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
      await h.close();
    }
  });

  it("does not hand the recording variable to calls that do not set it", async () => {
    const before = process.env[RECORD_VARIABLE];
    process.env[RECORD_VARIABLE] = "/nonexistent/recording";
    try {
      const h = await createStateFixture();
      try {
        expect(h.env()).not.toHaveProperty(RECORD_VARIABLE);
      } finally { await h.close(); }
    } finally {
      if (before === undefined) delete process.env[RECORD_VARIABLE]; else process.env[RECORD_VARIABLE] = before;
    }
  });
});

describe.skipIf(process.platform !== "linux")("fixture systemctl front: fast path and delegation", { timeout: 60_000 }, () => {
  // The script behind the front is a stub that names its arguments, so the
  // test sees which calls the front handed over and with which arguments.
  const setup = () => {
    const dir = mkdtempSync(join(tmpdir(), "fixture-systemctl-stub-"));
    const stub = join(dir, "systemctl.mjs"), front = join(dir, "front.sh");
    writeFileSync(stub, "#!/bin/sh\nprintf 'DELEGATED'\nfor a in \"$@\"; do printf ' [%s]' \"$a\"; done\nprintf '\\n'\n", { mode: 0o755 });
    writeFileSync(join(dir, "systemctl.pristine"), readFileSync(stub));
    writeFileSync(join(dir, "active"), "active"); writeFileSync(join(dir, "mainpid"), MAINPID);
    writeFileSync(front, systemctlFrontScript({ dir, impl: stub, shim: "/s/current/deploy/kaoiro-runner-launch.sh", conf: "/c", ordinary: "/o" }), { mode: 0o755 });
    chmodSync(front, 0o755);
    const call = (argv: string[], env: Record<string, string> = {}) => {
      rmSync(join(dir, "queries"), { force: true });
      const result = spawnSync(front, argv, { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env }, encoding: "utf8" });
      return { status: result.status, stdout: result.stdout, stderr: result.stderr, queries: existsSync(join(dir, "queries")) ? readFileSync(join(dir, "queries"), "utf8") : null };
    };
    return { dir, stub, call, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  };
  const shim = "/s/current/deploy/kaoiro-runner-launch.sh";
  const delegated = (argv: string[]) => `DELEGATED${argv.map(a => ` [${a}]`).join("")}\n`;
  const answers: Record<string, string> = {
    Transient: "no", ExecStart: `{ path=${shim} ; argv[]=${shim} ; ignore_errors=no }`, KillMode: "control-group", Id: SERVICE,
    MainPID: "4242", ActiveState: "active", ControlGroup: "/kaoiro-test",
    ExecStartPre: "", ExecStartPost: "", EnvironmentFiles: "", PassEnvironment: "", RootDirectory: "", RootImage: "", Environment: "", UnsetEnvironment: "",
  };

  it("answers every product property in the shell, writing only the query line", () => {
    const s = setup();
    try {
      for (const property of PRODUCT_PROPERTIES) {
        const result = s.call(show(property));
        expect(result, property).toMatchObject({ status: 0, stdout: `${answers[property]}\n`, stderr: "", queries: `${property}\n` });
      }
      expect(s.call(["--user", "show", "-p", "KillMode", "--value", SERVICE])).toMatchObject({ stdout: `${answers.ExecStart}\n`, queries: "ExecStart\n" });
      expect(s.call(["--user", "show", "--property=", "--value", SERVICE])).toMatchObject({ stdout: `${answers.ExecStart}\n`, queries: "ExecStart\n" });
      expect(s.call(["--user", "show", "--property=KillMode", "--property=MainPID", SERVICE])).toMatchObject({ stdout: "control-group\n", queries: "KillMode\n" });
      expect(s.call(["--user", "show", "--property=KillMode", "--value", "show"])).toMatchObject({ stdout: "control-group\n" });
      expect(s.call(["--user", "show-environment"])).toMatchObject({ status: 0, stdout: "HOME=/o\nKAOIRO_RUNNER_DIR=/c\n", queries: "show-environment\n" });
      expect(s.call(["--user", "show-environment", "show"])).toMatchObject({ stdout: "HOME=/o\nKAOIRO_RUNNER_DIR=/c\n", queries: "show-environment\n" });
      writeFileSync(join(s.dir, "active"), "inactive");
      expect(s.call(show("MainPID"))).toMatchObject({ stdout: "0\n" });
      expect(s.call(show("ActiveState"))).toMatchObject({ stdout: "inactive\n" });
    } finally { s.cleanup(); }
  });

  it("hands the original arguments to the script, with no side effect first, for everything else", () => {
    const s = setup();
    try {
      const cases: { name: string; argv: string[]; set?: () => void; env?: Record<string, string> }[] = [
        { name: "stop", argv: ["--user", "stop", SERVICE] },
        { name: "start", argv: ["--user", "start", SERVICE] },
        { name: "start beside a property", argv: ["--user", "show", "--property=KillMode", "start"] },
        { name: "stop beside show-environment", argv: ["--user", "show-environment", "stop"] },
        { name: "FragmentPath", argv: show("FragmentPath") },
        { name: "an inherited object property", argv: show("constructor") },
        { name: "an unknown property", argv: show("Unknown") },
        { name: "a property name with a newline", argv: show("Kill\nMode") },
        { name: "no verb", argv: ["--user", "reset-failed", SERVICE] },
        { name: "a glob-like element", argv: ["--user", "*show*", "--property=KillMode"] },
        { name: "show with a newline", argv: ["--user", "show\n", "--property=KillMode"] },
        { name: "a longer word", argv: ["--user", "showx", "--property=KillMode"] },
        { name: "an active file with a newline", argv: show("MainPID"), set: () => writeFileSync(join(s.dir, "active"), "active\n") },
        { name: "a missing active file", argv: show("MainPID"), set: () => rmSync(join(s.dir, "active")) },
        { name: "a missing mainpid file", argv: show("MainPID"), set: () => rmSync(join(s.dir, "mainpid")) },
        { name: "pid 0", argv: show("MainPID"), set: () => writeFileSync(join(s.dir, "mainpid"), '{"pid":0,"start":"1"}') },
        { name: "a leading zero", argv: show("MainPID"), set: () => writeFileSync(join(s.dir, "mainpid"), '{"pid":05,"start":"1"}') },
        { name: "spaces in mainpid", argv: show("MainPID"), set: () => writeFileSync(join(s.dir, "mainpid"), '{ "pid": 5, "start": "1" }') },
        { name: "a pid over 15 digits", argv: show("MainPID"), set: () => writeFileSync(join(s.dir, "mainpid"), '{"pid":1234567890123456,"start":"1"}') },
        { name: "a duplicate pid key", argv: show("MainPID"), set: () => writeFileSync(join(s.dir, "mainpid"), '{"pid":5,"pid":9,"start":"1"}') },
        { name: "an activity-fault window on ActiveState", argv: show("ActiveState"), set: () => writeFileSync(join(s.dir, "activity-fault"), "{}") },
        { name: "manager-extra on show-environment", argv: ["--user", "show-environment"], set: () => writeFileSync(join(s.dir, "manager-extra"), "X=1") },
        { name: "a rewritten script", argv: show("KillMode"), set: () => writeFileSync(s.stub, `${readFileSync(s.stub, "utf8")}# edited\n`) },
        { name: "no cmp on PATH", argv: show("KillMode"), env: { PATH: "/nonexistent" } },
      ];
      for (const { name, argv, set, env } of cases) {
        for (const file of ["active", "mainpid"]) writeFileSync(join(s.dir, file), file === "active" ? "active" : MAINPID);
        for (const file of ["activity-fault", "manager-extra"]) rmSync(join(s.dir, file), { force: true });
        writeFileSync(s.stub, readFileSync(join(s.dir, "systemctl.pristine")));
        set?.();
        const result = s.call(argv, env);
        expect(result, name).toMatchObject({ status: 0, stdout: delegated(argv), stderr: "", queries: null });
      }
      // The activity-fault window leaves other properties on the fast path.
      writeFileSync(join(s.dir, "activity-fault"), "{}");
      expect(s.call(show("KillMode"))).toMatchObject({ stdout: "control-group\n" });
    } finally { s.cleanup(); }
  });

  it("records the argv without changing the answer, and survives an unwritable record", () => {
    const s = setup();
    try {
      const file = join(s.dir, "recorded");
      const plain = s.call(show("KillMode"));
      const withRecord = s.call(show("KillMode"), { [RECORD_VARIABLE]: file });
      expect(withRecord).toEqual(plain);
      expect(parseRecords(readFileSync(file, "utf8"))).toEqual([show("KillMode")]);
      s.call(["--user", "stop", SERVICE], { [RECORD_VARIABLE]: file });
      expect(parseRecords(readFileSync(file, "utf8"))).toEqual([show("KillMode"), ["--user", "stop", SERVICE]]);
      expect(s.call(show("KillMode"), { [RECORD_VARIABLE]: join(s.dir, "no", "such", "directory", "record") })).toEqual(plain);
    } finally { s.cleanup(); }
  });
});
