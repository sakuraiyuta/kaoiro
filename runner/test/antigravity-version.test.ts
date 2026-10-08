import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { requirePositiveSafePid } from "@kaoiro/wrapper-core";
import { resolveAgyVersion } from "../src/antigravity-version.js";
import { readPidMarker } from "./pid_marker.js";

type SignalBackend = (pid: number, signal: 0) => unknown;

function isAlive(rawPid: unknown, signal: SignalBackend = (pid, value) => process.kill(pid, value)): boolean {
  const pid = requirePositiveSafePid(rawPid);
  try {
    signal(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function shellPidMarkerFixture(pidFile: string): string {
  const shellQuotedPidFile = `'${pidFile.replaceAll("'", "'\\''")}'`;
  return [
    "#!/bin/sh",
    "set -eu",
    `pid_file=${shellQuotedPidFile}`,
    'temporary_file="${pid_file}.tmp-$$"',
    'printf \'%s\\n\' "$$" > "$temporary_file"',
    'mv "$temporary_file" "$pid_file"',
    "exec sleep 60",
    "",
  ].join("\n");
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out after ${timeoutMs}ms`);
}

describe("resolveAgyVersion (issue #387)", () => {
  it("uses a shell fixture that atomically publishes its PID before waiting", () => {
    expect(shellPidMarkerFixture("/tmp/fixture/pid")).toBe(
      [
        "#!/bin/sh",
        "set -eu",
        "pid_file='/tmp/fixture/pid'",
        'temporary_file="${pid_file}.tmp-$$"',
        'printf \'%s\\n\' "$$" > "$temporary_file"',
        'mv "$temporary_file" "$pid_file"',
        "exec sleep 60",
        "",
      ].join("\n"),
    );
  });

  it("成功時は stdout を trim して返す", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kaoiro-agy-version-"));
    const script = join(dir, "agy");
    writeFileSync(script, "#!/bin/sh\nprintf 'agy-cli 1.2.3\\n'\n");
    chmodSync(script, 0o755);

    const version = await resolveAgyVersion({ ok: true, path: script }, 5_000);
    expect(version).toBe("agy-cli 1.2.3");
  });

  it("issue #387 review should2: 非ゼロ終了なら null を返す", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kaoiro-agy-version-"));
    const script = join(dir, "agy");
    writeFileSync(script, "#!/bin/sh\nexit 1\n");
    chmodSync(script, 0o755);

    const version = await resolveAgyVersion({ ok: true, path: script }, 5_000);
    expect(version).toBeNull();
  });

  it(
    "issue #387 review should2: watchdog が期限切れで遅い子を SIGKILL で止める",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "kaoiro-agy-version-"));
      const script = join(dir, "agy");
      const pidFile = join(dir, "pid");
      writeFileSync(script, shellPidMarkerFixture(pidFile));
      chmodSync(script, 0o755);

      const t0 = performance.now();
      const version = await resolveAgyVersion({ ok: true, path: script }, 300);
      const elapsedMs = performance.now() - t0;

      // The caller must be released near the deadline, even though the child
      // would otherwise remain alive for a minute.
      expect(version).toBeNull();
      expect(elapsedMs).toBeLessThan(2_000);

      try {
        const pid = await readPidMarker(pidFile, 2_000);
        await waitFor(() => !isAlive(pid), 3_000);
      } finally {
        rmSync(dir, { force: true, recursive: true });
      }
    },
    10_000,
  );
});

describe("Antigravity PID liveness helper", () => {
  it("rejects invalid observed PIDs before the signal-0 backend is called", () => {
    const calls: Array<[number, 0]> = [];
    const fakeSignal: SignalBackend = (pid, signal) => { calls.push([pid, signal]); };
    for (const invalid of ["", "  ", "0", "-1", "1.5", "NaN", "Infinity", "1e3", "9007199254740992", 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => isAlive(invalid, fakeSignal)).toThrow(RangeError);
      expect(calls).toEqual([]);
    }
    expect(isAlive("42", fakeSignal)).toBe(true);
    expect(calls).toEqual([[42, 0]]);
  });
});
