import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { requirePositiveSafePid } from "@kaoiro/wrapper-core";
import { embeddedPidMarkerWriter, publishPidMarker, readPidMarker, signalPidIfStartMatches } from "./pid_marker.js";

describe("runner PID marker protocol", () => {
  it("publishes through a same-directory temporary file and rename", () => {
    const events: string[] = [];
    publishPidMarker("/tmp/test/runner.pid", 42, {
      writeFileSync(path, content) { events.push(`write:${path}:${content}`); },
      renameSync(from, to) { events.push(`rename:${from}:${to}`); },
    });
    expect(events).toEqual([
      "write:/tmp/test/runner.pid.tmp-42:42",
      "rename:/tmp/test/runner.pid.tmp-42:/tmp/test/runner.pid",
    ]);
    expect(dirname(events[0]!.split(":")[1]!)).toBe(dirname("/tmp/test/runner.pid"));
    expect(embeddedPidMarkerWriter()).toContain("files.renameSync(temporaryPath, path)");
  });

  it("waits through an empty marker before parsing its PID", async () => {
    let reads = 0;
    let time = 0;
    await expect(readPidMarker(
      "/tmp/test/runner.pid",
      100,
      { exists: () => true, read: () => reads++ === 0 ? "" : "42" },
      async (ms) => { time += ms; },
      () => time,
    )).resolves.toBe(42);
    expect(reads).toBe(2);
  });

  it("waits for the final marker path before reading it", async () => {
    let existenceChecks = 0;
    let reads = 0;
    let time = 0;
    await expect(readPidMarker(
      "/tmp/test/runner.pid",
      100,
      {
        exists: () => ++existenceChecks > 1,
        read: () => { reads += 1; return "42"; },
      },
      async (ms) => { time += ms; },
      () => time,
    )).resolves.toBe(42);
    expect(existenceChecks).toBe(2);
    expect(reads).toBe(1);
  });

  it("fails immediately on a non-empty invalid marker", async () => {
    let time = 0;
    await expect(readPidMarker(
      "/tmp/test/runner.pid",
      100,
      { exists: () => true, read: () => "0" },
      async (ms) => { time += ms; },
      () => time,
    )).rejects.toThrow(RangeError);
    expect(time).toBe(0);
  });
});

describe("owned PID signal contract", () => {
  it("rejects invalid PIDs before reading or signaling and preserves self/init and start-time guards", () => {
    const events: string[] = [];
    const readStat = (pid: number) => {
      events.push(`read:${pid}`);
      return `42 (fixture) S ${Array.from({ length: 18 }, () => "0").join(" ")} 777`;
    };
    const signal = (pid: number, value: NodeJS.Signals) => { events.push(`signal:${pid}:${value}`); };
    for (const invalid of ["", "  ", "0", "-1", "1.5", "NaN", "Infinity", "1e3", "9007199254740992", 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => signalPidIfStartMatches(invalid, "777", requirePositiveSafePid, readStat, signal)).toThrow(RangeError);
      expect(events).toEqual([]);
    }
    expect(signalPidIfStartMatches(1, "777", requirePositiveSafePid, readStat, signal)).toBe(false);
    expect(signalPidIfStartMatches(process.pid, "777", requirePositiveSafePid, readStat, signal)).toBe(false);
    expect(signalPidIfStartMatches(42, "778", requirePositiveSafePid, readStat, signal)).toBe(false);
    expect(events).toEqual(["read:42"]);
    expect(signalPidIfStartMatches(42, "777", requirePositiveSafePid, readStat, signal)).toBe(true);
    expect(events).toEqual(["read:42", "read:42", "signal:42:SIGTERM"]);
  });
});
