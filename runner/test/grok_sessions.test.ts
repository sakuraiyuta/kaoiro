import "../../scripts/test/fixtures/test-isolation.mjs";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  GrokProbeAborted, GrokProbeError, killProbeGroup, probeGroupAlive, runGrokProbe,
} from "../src/grok_acp_probe.js";
import { grokSessionExists, listGrokSessions } from "../src/grok_sessions.js";
import { listSessions, sessionExists } from "../src/sessions.js";

const FAKE = fileURLToPath(new URL("./fixtures/fake-grok-acp.mjs", import.meta.url));
// Grok is spawned in the cwd it lists, so the cwd must exist.
const CWD = mkdtempSync(join(tmpdir(), "kaoiro-grok-cwd-"));
const dirs: string[] = [];

afterAll(() => rmSync(CWD, { force: true, recursive: true }));

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { force: true, recursive: true });
});

function fake(scenario: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), "kaoiro-grok-probe-"));
  dirs.push(dir);
  const scenarioPath = join(dir, "scenario.json");
  writeFileSync(scenarioPath, JSON.stringify(scenario));
  const log = join(dir, "requests.jsonl");
  const pids = join(dir, "pids");
  return {
    dir,
    env: { ...process.env, FAKE_GROK_SCENARIO: scenarioPath, FAKE_GROK_LOG: log, FAKE_GROK_PIDS: pids },
    requests: (): { method: string; params: Record<string, unknown> }[] =>
      existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [],
    pids: async (): Promise<number[]> => {
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline) {
        if (existsSync(pids)) return readFileSync(pids, "utf8").trim().split(" ").map(Number);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error("fake grok wrote no pid marker");
    },
  };
}

const entry = (sessionId: string, cwd = CWD, extra: Record<string, unknown> = {}) =>
  ({ sessionId, cwd, title: `title ${sessionId}`, updatedAt: "2026-10-15T00:00:00Z", ...extra });

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function gone(pid: number, timeoutMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return !alive(pid);
}

describe("grok session discovery over session/list", () => {
  it("ships the fixture as an executable with a shebang", () => {
    expect(readFileSync(FAKE, "utf8").startsWith("#!/usr/bin/env node\n")).toBe(true);
    expect(statSync(FAKE).mode & 0o111).not.toBe(0);
  });

  it("lists every page under the cwd and maps the entries", async () => {
    const f = fake({ pages: {
      __first__: { sessions: [entry("a-1"), entry("other", "/elsewhere")], nextCursor: "c2" },
      c2: { sessions: [entry("a-2", CWD, { title: "" })], nextCursor: "c3" },
      c3: { sessions: [entry("a-3")] },
    } });
    const sessions = await listGrokSessions(CWD, { executable: FAKE, env: f.env });
    expect(sessions).toEqual([
      { session_id: "a-1", summary: "title a-1", mtime: "2026-10-15T00:00:00Z" },
      { session_id: "a-2", mtime: "2026-10-15T00:00:00Z" },
      { session_id: "a-3", summary: "title a-3", mtime: "2026-10-15T00:00:00Z" },
    ]);
    expect(f.requests().filter((r) => r.method === "session/list").map((r) => r.params))
      .toEqual([{ cwd: CWD }, { cwd: CWD, cursor: "c2" }, { cwd: CWD, cursor: "c3" }]);
  });

  it("skips ids that could not ride a --resume argument", async () => {
    const f = fake({ pages: { __first__: { sessions: [entry("../x"), entry("ok-1")] } } });
    expect((await listGrokSessions(CWD, { executable: FAKE, env: f.env })).map((s) => s.session_id))
      .toEqual(["ok-1"]);
  });

  it.each([
    ["a page without a sessions array", { __first__: { sessions: [entry("a-1")], nextCursor: "c2" }, c2: { items: [] } }],
    ["an entry without a cwd", { __first__: { sessions: [entry("a-1")], nextCursor: "c2" }, c2: { sessions: [{ sessionId: "b" }] } }],
    ["an empty cursor", { __first__: { sessions: [entry("a-1")], nextCursor: "" } }],
    ["a JSON-RPC error on a later page", { __first__: { sessions: [entry("a-1")], nextCursor: "c2" }, c2: { error: -32603 } }],
  ])("returns no list, never a partial one, for %s", async (_name, pages) => {
    const f = fake({ pages });
    expect(await listGrokSessions(CWD, { executable: FAKE, env: f.env })).toEqual([]);
  });

  it("gives up after the page limit", async () => {
    const pages: Record<string, unknown> = {};
    for (let i = 0; i < 21; i += 1) {
      pages[i === 0 ? "__first__" : `c${i}`] = {
        sessions: [entry(`s-${i}`)],
        nextCursor: `c${i + 1}`,
      };
    }
    const f = fake({ pages });
    expect(await listGrokSessions(CWD, { executable: FAKE, env: f.env })).toEqual([]);
    expect(f.requests().filter((r) => r.method === "session/list"))
      .toHaveLength(20);
  });

  it("finds an id on a later page and stops there", async () => {
    const f = fake({ pages: {
      __first__: { sessions: [entry("a-1")], nextCursor: "c2" },
      c2: { sessions: [entry("a-2")], nextCursor: "c3" },
      c3: { sessions: [entry("a-3")] },
    } });
    expect(await grokSessionExists(CWD, "a-2", { executable: FAKE, env: f.env })).toBe(true);
    expect(f.requests().filter((r) => r.method === "session/list")).toHaveLength(2);
  });

  it("is false for an id that is absent or listed under another cwd", async () => {
    const f = fake({ pages: { __first__: { sessions: [entry("a-1"), entry("b-1", "/elsewhere")] } } });
    expect(await grokSessionExists(CWD, "zz-1", { executable: FAKE, env: f.env })).toBe(false);
    expect(await grokSessionExists(CWD, "b-1", { executable: FAKE, env: f.env })).toBe(false);
  });

  it("rejects a malformed id without starting grok", async () => {
    const f = fake({ pages: {} });
    expect(await grokSessionExists(CWD, "../a", { executable: FAKE, env: f.env })).toBe(false);
    expect(f.requests()).toEqual([]);
  });

  it.each([
    ["initialize fails", { initError: -32603, pages: {} }],
    ["grok exits before answering", { exitOnList: true, pages: {} }],
  ])("fails closed when %s", async (_name, scenario) => {
    const f = fake(scenario);
    expect(await listGrokSessions(CWD, { executable: FAKE, env: f.env })).toEqual([]);
    expect(await grokSessionExists(CWD, "a-1", { executable: FAKE, env: f.env })).toBe(false);
  });

  it("fails closed when the executable is missing", async () => {
    const missing = join(tmpdir(), "kaoiro-no-such-grok");
    expect(await listGrokSessions(CWD, { executable: missing })).toEqual([]);
    expect(await grokSessionExists(CWD, "a-1", { executable: missing })).toBe(false);
  });

  it("fails closed at the deadline and kills the whole process group", async () => {
    const f = fake({ hang: true, spawnChild: true, pages: {} });
    const started = Date.now();
    expect(await listGrokSessions(CWD, { executable: FAKE, env: f.env, deadlineMs: 400 })).toEqual([]);
    expect(Date.now() - started).toBeLessThan(3_000);
    const [leader, child] = await f.pids();
    expect(child).toBeGreaterThan(0);
    expect(await gone(leader!)).toBe(true);
    expect(await gone(child!)).toBe(true);
  }, 10_000);

  it("rejects on abort and kills the whole process group", async () => {
    const f = fake({ hang: true, spawnChild: true, pages: {} });
    const abort = new AbortController();
    const listing = listGrokSessions(CWD, { executable: FAKE, env: f.env, signal: abort.signal });
    const [leader, child] = await f.pids();
    abort.abort();
    await expect(listing).rejects.toBeInstanceOf(GrokProbeAborted);
    expect(await gone(leader!)).toBe(true);
    expect(await gone(child!)).toBe(true);
    const checked = grokSessionExists(CWD, "a-1", { executable: FAKE, env: f.env, signal: abort.signal });
    await expect(checked).rejects.toBeInstanceOf(GrokProbeAborted);
  }, 10_000);

  it("reaches grok through the engine dispatch", async () => {
    const f = fake({ pages: { __first__: { sessions: [entry("a-1")] } } });
    const bin = mkdtempSync(join(tmpdir(), "kaoiro-grok-bin-"));
    dirs.push(bin);
    writeFileSync(join(bin, "grok"), `#!/bin/sh\nexec node ${JSON.stringify(FAKE)} "$@"\n`, { mode: 0o755 });
    for (const [key, value] of Object.entries(f.env)) if (key.startsWith("FAKE_GROK_")) vi.stubEnv(key, value!);
    vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
    expect(await listSessions(CWD, "grok")).toEqual([
      { session_id: "a-1", summary: "title a-1", mtime: "2026-10-15T00:00:00Z" },
    ]);
    expect(await sessionExists(CWD, "a-1", "grok")).toBe(true);
  }, 10_000);
});

// Whether anything, a zombie included, is left in the group, read at once:
// a probe must not settle while a member it started is still there.
function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("probe teardown when the leader exits first", () => {
  // The fake's child ignores SIGTERM and the fake itself exits on it, so only
  // a teardown that outlasts the leader ends the child. Signals in finally
  // go only to the group the fake recorded.
  async function settledWithGroupGone(f: ReturnType<typeof fake>, settle: () => Promise<unknown>) {
    let leader = 0;
    try {
      await settle();
      leader = (await f.pids())[0] ?? 0;
      expect(leader).toBeGreaterThan(1);
      expect(groupAlive(leader)).toBe(false);
    } finally {
      if (!leader && existsSync(join(f.dir, "pids"))) leader = (await f.pids())[0] ?? 0;
      if (Number.isSafeInteger(leader) && leader > 1) {
        try { process.kill(-leader, "SIGKILL"); } catch { /* already gone */ }
      }
    }
  }

  it("on a normal finish", async () => {
    const f = fake({ stubbornChild: true, pages: { __first__: { sessions: [entry("a-1")] } } });
    await settledWithGroupGone(f, () => runGrokProbe({ cwd: CWD, executable: FAKE, env: f.env }, async (call) => {
      await f.pids();
      return call("session/list", { cwd: CWD });
    }));
  }, 10_000);

  it("at the deadline", async () => {
    const f = fake({ hang: true, stubbornChild: true, pages: {} });
    await settledWithGroupGone(f, async () => {
      const listing = listGrokSessions(CWD, { executable: FAKE, env: f.env, deadlineMs: 1_000 });
      await f.pids();
      expect(await listing).toEqual([]);
    });
  }, 10_000);

  it("on abort", async () => {
    const f = fake({ hang: true, stubbornChild: true, pages: {} });
    await settledWithGroupGone(f, async () => {
      const abort = new AbortController();
      const listing = listGrokSessions(CWD, { executable: FAKE, env: f.env, signal: abort.signal });
      await f.pids();
      abort.abort();
      await expect(listing).rejects.toBeInstanceOf(GrokProbeAborted);
    });
  }, 10_000);
});

describe("malformed responses", () => {
  const listed = (listReply: unknown) => {
    const f = fake({ listReply });
    return runGrokProbe({ cwd: CWD, executable: FAKE, env: f.env }, (call) => call("session/list", { cwd: CWD }));
  };

  it.each([["null", null], ["a string", "refused"], ["a number", 7], ["an array", []]])(
    "rejects an error of %s as a protocol failure", async (_label, error) => {
    const failure = await listed({ error }).catch((caught: unknown) => caught);
    expect(failure).toBeInstanceOf(GrokProbeError);
    expect((failure as GrokProbeError).reason).toBe("protocol");
  }, 10_000);

  it("keeps an error object's code", async () => {
    const failure = await listed({ error: { code: -32603, message: "no" } }).catch((caught: unknown) => caught);
    expect(failure).toMatchObject({ reason: "rpc", code: -32603 });
  }, 10_000);

  it("fails discovery closed on an error of null", async () => {
    const f = fake({ listReply: { error: null } });
    expect(await listGrokSessions(CWD, { executable: FAKE, env: f.env })).toEqual([]);
    expect(await grokSessionExists(CWD, "a-1", { executable: FAKE, env: f.env })).toBe(false);
  }, 10_000);
});

describe("probeGroupAlive", () => {
  const failing = (code: string) => vi.fn(() => {
    throw Object.assign(new Error(code), { code });
  });

  it("is false only when the group is gone", () => {
    expect(probeGroupAlive(4242, failing("ESRCH"))).toBe(false);
    expect(probeGroupAlive(4242, failing("EPERM"))).toBe(true);
    const kill = vi.fn();
    expect(probeGroupAlive(4242, kill)).toBe(true);
    expect(kill).toHaveBeenCalledWith(-4242, 0);
  });

  it.each([undefined, 0, 1, -1, 1.5])("never signals for pid %s", (pid) => {
    const kill = vi.fn();
    expect(probeGroupAlive(pid, kill)).toBe(false);
    expect(kill).not.toHaveBeenCalled();
  });
});

describe("killProbeGroup", () => {
  it.each([undefined, 0, 1, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "never signals for pid %s", (pid) => {
      const kill = vi.fn();
      expect(killProbeGroup(pid, "SIGTERM", kill)).toBe(false);
      expect(kill).not.toHaveBeenCalled();
    });

  it("signals the negative pid of a positive one", () => {
    const kill = vi.fn();
    expect(killProbeGroup(4242, "SIGTERM", kill)).toBe(true);
    expect(kill).toHaveBeenCalledWith(-4242, "SIGTERM");
  });
});
