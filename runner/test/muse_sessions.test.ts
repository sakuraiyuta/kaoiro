import "../../scripts/test/fixtures/test-isolation.mjs";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { MuseProbeAborted } from "../src/muse_acp_probe.js";
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

const discoveryExchange = () => [
  { argv: ["acp"], jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: 1, clientCapabilities: {} } },
  { argv: ["acp"], jsonrpc: "2.0", id: 2, method: "session/list",
    params: { cwd: CWD } },
];

const entry = (sessionId: string, cwd = CWD, extra: Record<string, unknown> = {}) =>
  ({ sessionId, cwd, title: `title ${sessionId}`, updatedAt: "2026-11-25T00:00:00Z", ...extra });

describe("muse session discovery over session/list", () => {
  it("waits for a stubborn Muse probe during runner shutdown", async () => {
    const root = mkdtempSync(join(tmpdir(), "kaoiro-muse-shutdown-"));
    dirs.push(root);
    const bin = join(root, "muse");
    const scenario = join(root, "scenario.json");
    const pids = join(root, "pids");
    const configPath = join(root, "runner.config.json");
    writeFileSync(bin, readFileSync(FAKE), { mode: 0o755 });
    writeFileSync(scenario, JSON.stringify({ hang: true, stubbornChild: true }));
    writeFileSync(configPath, JSON.stringify({ host_id: "muse-test",
      server_url: "ws://runner.invalid/runner", cwd_allowlist: [root],
      capabilities: ["muse"] }));
    const driverPath = fileURLToPath(new URL("./fixtures/muse-sessions-shutdown.ts", import.meta.url));
    const driver = spawn(process.execPath, ["--import", "tsx", driverPath], {
      cwd: fileURLToPath(new URL("..", import.meta.url)), stdio: "ignore",
      env: { ...process.env, PATH: `${root}:${process.env.PATH}`, OWN_CONFIG: configPath,
        OWN_CWD: root, FAKE_MUSE_SCENARIO: scenario, FAKE_MUSE_PIDS: pids },
    });
    let leader = 0;
    const timer = setTimeout(() => driver.kill("SIGKILL"), 10_000);
    try {
      const code = await new Promise<number | null>((resolve) => driver.once("exit", resolve));
      expect(code).toBe(0);
      const values = readFileSync(pids, "utf8").trim().split(" ").map(Number);
      leader = values[0]!;
      expect(leader).toBeGreaterThan(1);
      expect(values[1]).toBeGreaterThan(1);
      expect(() => process.kill(-leader, 0)).toThrow();
    } finally {
      clearTimeout(timer);
      if (!leader && existsSync(pids)) leader = Number(readFileSync(pids, "utf8").split(" ")[0]);
      if (Number.isSafeInteger(leader) && leader > 1) {
        try { process.kill(-leader, "SIGKILL"); } catch { /* already gone */ }
      }
      if (driver.exitCode === null && driver.signalCode === null) driver.kill("SIGKILL");
    }
  }, 15_000);

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
    expect(requests()).toEqual(discoveryExchange());
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
    expect(requests()).toEqual([...discoveryExchange(), ...discoveryExchange()]);
    const before = requests().length;
    await expect(museSessionExists(CWD, "bad id!", { executable: FAKE, env })).resolves.toBe(false);
    expect(requests().length).toBe(before);
  });

  it("propagates a pre-aborted listing", async () => {
    await expect(listMuseSessions(CWD, { signal: AbortSignal.abort() }))
      .rejects.toBeInstanceOf(MuseProbeAborted);
  });

  it("propagates a pre-aborted existence check for a valid id", async () => {
    const options = { signal: AbortSignal.abort() };
    await expect(museSessionExists(CWD, "sess-1", options))
      .rejects.toBeInstanceOf(MuseProbeAborted);
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
