import "../../scripts/test/fixtures/test-isolation.mjs";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { makeLauncher } from "../src/spawn.js";
import { Supervisor, type ManagedChild } from "../src/supervisor.js";
import type { SessionResetResult, SpawnResult } from "@kaoiro/protocol";

const live = (session_id: string) => ({ state: "live", session_id });
const cases = [
  { name: "crash-live", plan: [{ rec: live("S1"), code: 1 }, { hold: true }], count: 2, target: "S1" },
  ...(["new", "clear"] as const).map(mode => ({ name: `reset-${mode}-live`, mode, plan: [{ hold: true, rec: live("OLD") }, { rec: live("AFTER"), code: 1 }, { hold: true }], count: 3, target: "AFTER" })),
  { name: "reset-candidate", mode: "clear", plan: [{ hold: true }, { rec: { state: "unbound", candidate_id: "CAND" }, code: 137 }, { hold: true }], count: 3, target: "CAND", kind: "candidate" },
  { name: "wrapper-79", plan: [{ rec: live("STALE"), code: 79 }], count: 1 },
  { name: "restart-live", restart: true, plan: [{ hold: true, rec: live("R1") }, { hold: true }], count: 2, target: "R1" },
  { name: "restart-blocked", restart: true, plan: [{ hold: true, rec: { state: "blocked", reason: "watchdog" } }], count: 1 },
  { name: "reset-then-restart", mode: "new", restart: true, plan: [{ hold: true }, { hold: true, rec: live("AFTER2") }, { hold: true }], count: 3, target: "AFTER2" },
] as const;
let launcher: ReturnType<typeof makeLauncher> | undefined;

it.each(cases)("composes real Supervisor and launcher: $name", async scenario => {
  const root = mkdtempSync(join(tmpdir(), "kaoiro-recovery-compose-"));
  const previous = { options: process.env.NODE_OPTIONS, dir: process.env.KAOIRO_TEST_RECOVERY_DIR, plan: process.env.KAOIRO_TEST_RECOVERY_PLAN };
  const children: ManagedChild[] = [], exited = new Set<ManagedChild>();
  const results: SpawnResult[] = [], resets: SessionResetResult[] = [];
  const actual = launcher ??= makeLauncher();
  process.env.NODE_OPTIONS = `${previous.options ?? ""} --require=${fileURLToPath(new URL("./fixtures/recovery-wrapper.cjs", import.meta.url))}`;
  process.env.KAOIRO_TEST_RECOVERY_DIR = root;
  process.env.KAOIRO_TEST_RECOVERY_PLAN = JSON.stringify(scenario.plan);
  const sup = new Supervisor({ hostId: "fixture", cwdAllowlist: [root], wrapperServerUrl: "ws://127.0.0.1:1/wrapper",
    launch: (...args) => { const child = actual(...args); children.push(child); child.on("exit", () => exited.add(child)); return child; },
    sendResult: r => results.push(r), sendSessions: () => {}, sendResetResult: r => resets.push(r), sendStopAgent: () => {}, listSessions: () => [], sessionExists: () => true });
  const message = { version: "0", agent_id: "fixture.agent", persona: { id: "p", name: "P", sprite_set: "p" }, cwd: root, server_url: "ws://127.0.0.1:1/wrapper", token: "fixture" };
  const launches = () => readdirSync(root).filter(name => /^launch-\d+$/.test(name)).sort((a,b) => Number(a.slice(7))-Number(b.slice(7))).map(name => JSON.parse(readFileSync(join(root,name),"utf8")) as { resume: string | null; kind: string | null; hasPath: boolean });
  const wait = (predicate: () => boolean) => vi.waitFor(() => expect(predicate()).toBe(true), { timeout: 8000, interval: 10 });
  try {
    sup.handleSpawn(message); await wait(() => launches().length >= 1);
    if ("mode" in scenario) {
      sup.handleResetSession({ agent_id: message.agent_id, request_id: "reset", mode: scenario.mode, previous_session_id: "OLD" });
      await wait(() => launches().length >= 2);
      expect(launches()[1]?.resume).toBeNull(); expect(launches()[1]?.kind).toBeNull();
      expect(resets).toContainEqual(expect.objectContaining({ ok: true, request_id: "reset" }));
    }
    if ("restart" in scenario) sup.handleRestart({ agent_id: message.agent_id, request_id: "restart" });
    if (scenario.name === "wrapper-79") await wait(() => exited.has(children[0]!));
    else if (scenario.name === "restart-blocked") {
      expect(results.at(-1)).toMatchObject({ ok: false, request_id: "restart", reason: "error" });
      expect(exited.has(children[0]!)).toBe(false);
    } else await wait(() => launches().length >= scenario.count);
    expect(launches()).toHaveLength(scenario.count);
    expect(children).toHaveLength(scenario.count);
    expect(launches().every(row => row.hasPath)).toBe(true);
    if ("target" in scenario) {
      expect(launches().at(-1)?.resume).toBe(scenario.target);
      expect(launches().at(-1)?.kind).toBe("kind" in scenario ? scenario.kind : null);
    }
  } finally {
    sup.stopAll(); await wait(() => children.every(child => exited.has(child)));
    for (const [key,value] of [["NODE_OPTIONS",previous.options],["KAOIRO_TEST_RECOVERY_DIR",previous.dir],["KAOIRO_TEST_RECOVERY_PLAN",previous.plan]] as const) { if(value===undefined)delete process.env[key];else process.env[key]=value; }
    rmSync(root,{recursive:true,force:true});
  }
}, 20000);
