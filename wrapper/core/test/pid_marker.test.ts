import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { embeddedPidMarkerWriter, publishPidMarker, readPidMarker } from "./pid_marker.js";

describe("PID marker protocol", () => {
  it("publishes the complete PID through a same-directory temporary file and rename", () => {
    const events: string[] = [];
    publishPidMarker("/tmp/test/fixture.pid", 42, {
      writeFileSync(path, content) { events.push(`write:${path}:${content}`); },
      renameSync(from, to) { events.push(`rename:${from}:${to}`); },
    });

    expect(events).toEqual([
      "write:/tmp/test/fixture.pid.tmp-42:42",
      "rename:/tmp/test/fixture.pid.tmp-42:/tmp/test/fixture.pid",
    ]);
    expect(dirname(events[0]!.split(":")[1]!)).toBe(dirname("/tmp/test/fixture.pid"));
    expect(embeddedPidMarkerWriter()).toContain("files.renameSync(temporaryPath, path)");
  });

  it("waits through an empty marker before parsing the published PID", async () => {
    let reads = 0;
    let time = 0;
    const pid = await readPidMarker(
      "/tmp/test/fixture.pid",
      100,
      {
        exists: () => true,
        read: () => reads++ === 0 ? "  \n" : "42\n",
      },
      async (ms) => { time += ms; },
      () => time,
    );

    expect(pid).toBe(42);
    expect(reads).toBe(2);
  });

  it("waits for the final marker path to exist before reading it", async () => {
    let existenceChecks = 0;
    let reads = 0;
    let time = 0;
    await expect(readPidMarker(
      "/tmp/test/fixture.pid",
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

  it("fails on a non-empty invalid marker instead of polling or accepting it", async () => {
    let time = 0;
    await expect(readPidMarker(
      "/tmp/test/fixture.pid",
      100,
      { exists: () => true, read: () => "0" },
      async (ms) => { time += ms; },
      () => time,
    )).rejects.toThrow(RangeError);
    expect(time).toBe(0);
  });
});
