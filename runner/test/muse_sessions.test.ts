import "../../scripts/test/fixtures/test-isolation.mjs";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { listMuseSessions, museSessionExists } from "../src/muse_sessions.js";
import { listSessions, sessionExists } from "../src/sessions.js";

const FAKE = fileURLToPath(new URL("./fixtures/fake-muse-acp.mjs", import.meta.url));
const CWD = mkdtempSync(join(tmpdir(), "kaoiro-muse-cwd-"));
const dirs: string[] = [];

afterAll(() => rmSync(CWD, { force: true, recursive: true }));
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { force: true, recursive: true });
});

function fake(scenario: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), "kaoiro-muse-probe-"));
  dirs.push(dir);
  const scenarioPath = join(dir, "scenario.json");
  writeFileSync(scenarioPath, JSON.stringify(scenario));
  const log = join(dir, "requests.jsonl");
  return {
    env: { ...process.env, FAKE_MUSE_SCENARIO: scenarioPath, FAKE_MUSE_LOG: log },
    requests: (): { method: string; params: Record<string, unknown> }[] =>
      existsSync(log)
        ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
        : [],
  };
}

const entry = (sessionId: string, cwd = CWD, extra: Record<string, unknown> = {}) =>
  ({ sessionId, cwd, title: `title ${sessionId}`, updatedAt: "2026-11-25T00:00:00Z", ...extra });

describe("muse session discovery over session/list", () => {
  it("lists the sessions bound to the cwd, skipping foreign and malformed ids", async () => {
    const { env, requests } = fake({
      pages: {
        __first__: {
          sessions: [
            entry("sess-1"),
            entry("sess-2", "/somewhere/else"),
            entry("bad id!"),
            { sessionId: "sess-3", cwd: CWD },
          ],
        },
      },
    });
    const sessions = await listMuseSessions(CWD, { executable: FAKE, env });
    expect(sessions).toEqual([
      { session_id: "sess-1", summary: "title sess-1", mtime: "2026-11-25T00:00:00Z" },
      { session_id: "sess-3" },
    ]);
    expect(requests().map((r) => r.method)).toEqual(["initialize", "session/list"]);
  });

  it("pages with the cursor until the last page", async () => {
    const { env } = fake({
      pages: {
        __first__: { sessions: [entry("sess-1")], nextCursor: "p2" },
        p2: { sessions: [entry("sess-2")] },
      },
    });
    const sessions = await listMuseSessions(CWD, { executable: FAKE, env });
    expect(sessions.map((s) => s.session_id)).toEqual(["sess-1", "sess-2"]);
  });

  it("fails closed on a malformed page and on an RPC error", async () => {
    const malformed = fake({ pages: { __first__: { sessions: [{ nope: true }] } } });
    await expect(listMuseSessions(CWD, { executable: FAKE, env: malformed.env }))
      .resolves.toEqual([]);
    const failing = fake({ pages: { __first__: { error: -32603 } } });
    await expect(listMuseSessions(CWD, { executable: FAKE, env: failing.env }))
      .resolves.toEqual([]);
  });

  it("answers existence from the listing and rejects a malformed id without a probe", async () => {
    const { env, requests } = fake({
      pages: { __first__: { sessions: [entry("sess-1"), entry("sess-2")] } },
    });
    await expect(museSessionExists(CWD, "sess-2", { executable: FAKE, env })).resolves.toBe(true);
    await expect(museSessionExists(CWD, "sess-9", { executable: FAKE, env })).resolves.toBe(false);
    const before = requests().length;
    await expect(museSessionExists(CWD, "bad id!", { executable: FAKE, env })).resolves.toBe(false);
    expect(requests().length).toBe(before);
  });

  it("dispatches through sessions.ts for the muse engine", async () => {
    // The dispatch resolves `muse` from PATH, so PATH is routed through a
    // controlled fixture binary: the test must never launch a real `muse`
    // that happens to be installed on the machine running it.
    const { env } = fake({
      pages: { __first__: { sessions: [entry("sess-1")] } },
    });
    const bin = mkdtempSync(join(tmpdir(), "kaoiro-muse-bin-"));
    dirs.push(bin);
    writeFileSync(join(bin, "muse"), readFileSync(FAKE, "utf8"), { mode: 0o755 });
    vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
    vi.stubEnv("FAKE_MUSE_SCENARIO", env.FAKE_MUSE_SCENARIO);
    vi.stubEnv("FAKE_MUSE_LOG", env.FAKE_MUSE_LOG);
    const listed = listSessions(CWD, "muse", new AbortController().signal);
    expect(listed).toBeInstanceOf(Promise);
    await expect(listed).resolves.toEqual([
      { session_id: "sess-1", summary: "title sess-1", mtime: "2026-11-25T00:00:00Z" },
    ]);
    const exists = sessionExists(CWD, "sess-1", "muse", new AbortController().signal);
    expect(exists).toBeInstanceOf(Promise);
    await expect(exists).resolves.toBe(true);
    await expect(
      sessionExists(CWD, "sess-9", "muse", new AbortController().signal),
    ).resolves.toBe(false);
  });
});
