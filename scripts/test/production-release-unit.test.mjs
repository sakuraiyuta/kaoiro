import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { unitSnapshot, unitCommandSnapshot, verifyRetainedUnitCommand } from "../production-release-unit.mjs";

test("typed unit verification distinguishes argv boundaries and requires the actual expansion flag", () => {
  const argv = ["/usr/bin/true", "a b", "literal $BACKUP ${HOME} %h %%"];
  const command = { type: "a(sasasttttuii)", data: [[argv[0], argv, ["no-env-expand"], 0, 0, 0, 0, 0, 0, 0]] };
  assert.equal(verifyRetainedUnitCommand(command, argv[0], argv), true);
  assert.throws(() => verifyRetainedUnitCommand({ ...command, data: [[argv[0], [argv[0], "a", "b", argv[2]], command.data[0][2], 0, 0, 0, 0, 0, 0, 0]] }, argv[0], argv), /argv/);
  assert.throws(() => verifyRetainedUnitCommand({ ...command, data: [[argv[0], argv, [], 0, 0, 0, 0, 0, 0, 0]] }, argv[0], argv), /no-env-expand/);
  assert.throws(() => verifyRetainedUnitCommand({ ...command, type: "plain-ExecStart" }, argv[0], argv), /typed/);
  assert.throws(() => unitSnapshot("--all"), /unit name/);
});

test("the production reader verifies its own real timer-shaped units through ExecStartEx",
  { skip: process.env.KAOIRO_RELEASE_UNIT_PROBE !== "1" }, () => {
  const run = (bin, args) => execFileSync(bin, args, { encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] });
  const argv = ["/usr/bin/true", "a b", "literal $BACKUP ${HOME} %h %%", "a;b", "a}b", "a\\b", 'a"b'];
  for (const expand of [false, true]) {
    const unit = `kaoiro-fuji571-unit-verifier-${randomUUID()}`;
    try {
      run("systemd-run", ["--user", `--unit=${unit}`, "--on-active=1s", "--timer-property=AccuracySec=1s",
        "--property=Type=oneshot", "--property=RemainAfterExit=yes", `--expand-environment=${expand ? "yes" : "no"}`, "--", ...argv]);
      assert.equal(unitSnapshot(`${unit}.service`).LoadState, "loaded");
      const command = unitCommandSnapshot(`${unit}.service`);
      if (expand) assert.throws(() => verifyRetainedUnitCommand(command, argv[0], argv), /no-env-expand/);
      else assert.equal(verifyRetainedUnitCommand(command, argv[0], argv), true);
    } finally {
      run("systemctl", ["--user", "stop", "--", `${unit}.service`, `${unit}.timer`]);
      try { run("systemctl", ["--user", "reset-failed", "--", `${unit}.service`, `${unit}.timer`]); } catch {}
      assert.equal(unitSnapshot(`${unit}.service`).LoadState, "not-found");
      assert.equal(unitSnapshot(`${unit}.timer`).LoadState, "not-found");
    }
  }
});
