// Self-check of the read-only ownership tag the SIGTERM integration tests
// rely on: it must see exactly the tagged process, skip what it cannot
// read, and never signal anything. The sleepers are children this file
// started; each is stopped once, by its own pid, after 'spawn' reported it.
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import {
  OWNER_TAG_ENV,
  newOwnerTag,
  processHasTag,
  taggedProcesses,
  waitForNoTagged,
} from "./owner_tag.js";
import { forceKillIfTagged } from "./tagged_kill.js";

const isLinux = process.platform === "linux";
const started: ChildProcess[] = [];

async function startSleeper(
  extraEnv: Record<string, string>,
): Promise<{ child: ChildProcess; pid: number }> {
  const env = { ...process.env, ...extraEnv } as Record<string, string>;
  const child = spawn("sleep", ["60"], { env, stdio: "ignore" });
  const pid = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("spawn", () => {
      if (typeof child.pid === "number" && child.pid > 0) resolve(child.pid);
      else reject(new Error("spawned child has no usable pid"));
    });
  });
  started.push(child);
  return { child, pid };
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGKILL");
  await exited;
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const child of started.splice(0)) await stop(child);
});

it.skipIf(!isLinux)(
  "sees only the process whose environ holds the exact tag entry",
  async () => {
    const tag = newOwnerTag();
    const tagged = await startSleeper({ [OWNER_TAG_ENV]: tag });
    const untagged = await startSleeper({});
    const otherTag = await startSleeper({ [OWNER_TAG_ENV]: newOwnerTag() });
    const otherName = await startSleeper({ [`NOT_${OWNER_TAG_ENV}`]: tag });
    const prefix = await startSleeper({ [OWNER_TAG_ENV]: tag.slice(0, -1) });
    const longer = await startSleeper({ [OWNER_TAG_ENV]: `${tag}x` });

    expect(processHasTag(tagged.pid, tag)).toBe(true);
    for (const other of [untagged, otherTag, otherName, prefix, longer]) {
      expect(processHasTag(other.pid, tag)).toBe(false);
    }
    expect(taggedProcesses(tag).map((p) => p.pid)).toEqual([tagged.pid]);
    expect(taggedProcesses(tag)[0]!.args).toBe("sleep 60");
  },
);

it.skipIf(!isLinux)(
  "does not count pids it cannot inspect",
  async () => {
    const tag = newOwnerTag();
    const gone = await startSleeper({ [OWNER_TAG_ENV]: tag });
    await stop(gone.child);

    // pid 1 is unreadable for a non-root user and untagged for root.
    for (const pid of [gone.pid, 1, 0, -1, Number.NaN, 1.5]) {
      expect(processHasTag(pid, tag)).toBe(false);
    }
    expect(taggedProcesses(tag)).toEqual([]);
  },
);

it.skipIf(!isLinux)(
  "waitForNoTagged lists survivors with pid / ppid / args, then passes once they are gone",
  async () => {
    const tag = newOwnerTag();
    const { child, pid } = await startSleeper({ [OWNER_TAG_ENV]: tag });

    const failure = await waitForNoTagged(tag, 300, 50).then(
      () => null,
      (error: Error) => error.message,
    );
    expect(failure).toContain(`pid=${pid} ppid=${process.pid} args=sleep 60`);

    await stop(child);
    await waitForNoTagged(tag, 2_000, 50);
  },
);

it.skipIf(!isLinux)(
  "forceKillIfTagged signals a pid that carries the tag and never one that does not",
  async () => {
    const tag = newOwnerTag();
    const tagged = await startSleeper({ [OWNER_TAG_ENV]: tag });
    const untagged = await startSleeper({});
    const spy = vi.spyOn(process, "kill").mockImplementation(() => true);

    forceKillIfTagged(untagged.pid, tag);
    forceKillIfTagged(tagged.pid, newOwnerTag());
    forceKillIfTagged(undefined, tag);
    expect(spy).not.toHaveBeenCalled();

    forceKillIfTagged(tagged.pid, tag);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(tagged.pid, "SIGKILL");
  },
);

it("owner_tag.ts itself never calls kill", () => {
  const callsKill = /\.kill\b|\bkill\s*\(|\bpkill\b|\bkillpg\b/;
  // The check must be able to fail: it matches a kill call.
  expect("process.kill(pid, 0)").toMatch(callsKill);
  const source = readFileSync(new URL("./owner_tag.ts", import.meta.url), "utf8");
  expect(source).not.toMatch(callsKill);
});
