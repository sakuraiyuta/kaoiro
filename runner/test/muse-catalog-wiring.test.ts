import "../../scripts/test/fixtures/test-isolation.mjs";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import type { RunnerRegister } from "@kaoiro/protocol";
import { acpProbesSettled } from "../src/acp_probe.js";
import { runRunnerCli } from "../src/runner-cli.js";
import type { RunnerLinkOptions } from "../src/transport.js";

const fixture = fileURLToPath(
  new URL("./fixtures/fake-muse-model-list.mjs", import.meta.url),
);
const models = (register: RunnerRegister, engine: string) =>
  register.engines?.find((row) => row.id === engine)?.models.map((m) => m.value);
async function start(
  scenario = "ok", capabilities = ["muse"], deadlineMs = 7_000,
) {
  const cwd = mkdtempSync(join(tmpdir(), "kaoiro-muse-catalog-"));
  const config = join(cwd, "runner.config.json");
  writeFileSync(config, JSON.stringify({
    host_id: "muse-catalog-fixture", server_url: "ws://runner.invalid/runner",
    cwd_allowlist: [cwd], capabilities,
  }));
  function lane(name: string) {
    const LOG = join(cwd, name);
    const GATE = join(cwd, name + "-gate");
    return {
      options: { cwd, executable: fixture, deadlineMs,
        env: { ...process.env, CASE: scenario, GATE, LOG } },
      release: () => writeFileSync(GATE, ""),
      transcript: (): Record<string, unknown>[] =>
        existsSync(LOG) ? readFileSync(LOG, "utf8").trim().split("\n")
          .map((line) => JSON.parse(line)) : [],
    };
  }
  const muse = lane("muse");
  const grok = lane("grok");
  const publications: RunnerRegister[] = [];
  let control!: RunnerLinkOptions;
  const launch = vi.fn(() => { throw new Error("fixture stops at launch"); });
  const sendSpawnResult = vi.fn();
  const runner = await runRunnerCli({
    installSignalHandlers: false,
    museCatalogProbe: muse.options,
    grokCatalogProbe: grok.options,
    makeLauncher: () => launch,
    catalogProbe: async () => ({ ok: true, source: "init", elapsed_ms: 1,
      models: [{ value: "claude-fixture", display_name: "Claude" }] }),
    createRunnerLink: (_url, _host, options) => {
      control = options;
      publications.push(options.register);
      return {
        updateRegister: (r) => publications.push(r), close() {}, sendSpawnResult,
        sendSessions() {}, sendResetResult() {}, sendStopAgent() {},
        sendCatalogResult() {},
      };
    },
  }, [config]);
  return {
    muse, grok, publications, launch, sendSpawnResult,
    close: () => runner?.close(),
    async dispose() {
      runner?.close();
      await acpProbesSettled(10_000);
      rmSync(cwd, { recursive: true, force: true });
    },
    refreshClaude: (request_id: string) => control.onRefreshEngineCatalog!({
      version: "0", engine: "claude-code", request_id, force: true,
    }),
    spawn: (model: string, effort: string) => control.onSpawn!({
      agent_id: "muse-fixture", request_id: "request", engine: "muse", cwd,
      persona: { id: "p", name: "P", sprite_set: "p" }, model, effort,
    }),
  };
}

it.each(["muse", "grok"] as const)(
  "preserves all catalogs with %s completing first", async (first) => {
    const h = await start("ok", ["muse", "grok", "claude-code"]);
    try {
      expect(models(h.publications[0]!, "muse")).toEqual(["default"]);
      h.spawn("muse-spark-1.2", "low");
      h[first].release();
      await vi.waitFor(() => expect(h.publications).toHaveLength(2));
      h.refreshClaude("first");
      await vi.waitFor(() => expect(h.publications).toHaveLength(3));
      h[first === "muse" ? "grok" : "muse"].release();
      await vi.waitFor(() => expect(h.publications).toHaveLength(4));
      h.refreshClaude("second");
      await vi.waitFor(() => expect(h.publications).toHaveLength(5));
      for (const r of h.publications.slice(3)) {
        expect(models(r, "claude-code")).toEqual(["claude-fixture"]);
        expect(models(r, "grok")).toEqual(["default", "grok-fixture"]);
        expect(r.engines?.find((row) => row.id === "muse")?.models).toEqual([
          { value: "default", display_name: "Account default" },
          { value: "muse-spark-1.2", display_name: "muse-spark-1.2",
            effort_levels: ["low", "high"] },
          { value: "muse-ember-1.0", display_name: "muse-ember-1.0" },
        ]);
      }
      const argv = ["serve", "--disable-shell", "--disable-write", "--no-session-log"];
      expect(h.muse.transcript().map(({ pid: _pid, ...entry }) => entry)).toEqual([
        { argv, jsonrpc: "2.0", id: 1, method: "initialize",
          params: { clientInfo: { name: "kaoiro", version: "1" } } },
        { argv, jsonrpc: "2.0", method: "initialized" },
        { argv, jsonrpc: "2.0", id: 2, method: "model/list", params: {} },
      ]);
      for (const [model, effort] of [
        ["muse-spark-1.2", "max"], ["muse-ember-1.0", "low"],
        ["unknown", "low"], ["default", "low"],
      ] as const) h.spawn(model, effort);
      expect(h.sendSpawnResult).toHaveBeenCalledTimes(5);
      for (const [result] of h.sendSpawnResult.mock.calls) {
        expect(result).toMatchObject({ ok: false, reason: "error" });
      }
      expect(h.launch).not.toHaveBeenCalled();
    } finally {
      await h.dispose();
    }
  }, 12_000,
);

it("launches a Muse model and effort from the published catalog", async () => {
  const h = await start();
  try {
    h.muse.release();
    await vi.waitFor(() => expect(models(h.publications.at(-1)!, "muse"))
      .toContain("muse-spark-1.2"));
    h.spawn("muse-spark-1.2", "low");
    expect(h.launch).toHaveBeenCalledTimes(1);
    expect(h.launch).toHaveBeenCalledWith(
      "muse-fixture",
      expect.objectContaining({ model: "muse-spark-1.2", effort: "low" }),
      expect.any(String), undefined, undefined, "muse",
    );
  } finally {
    await h.dispose();
  }
});

it.each([
  ["empty", "empty or invalid model list"],
  ["malformed", "invalid or duplicate model id"],
  ["source", "unsupported catalog source"],
  ["exit", "exit"],
  ["hang", "deadline"],
])("keeps Default on %s catalog failure", async (scenario, reason) => {
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const h = await start(scenario, ["muse"], 2_500);
  try {
    h.muse.release();
    await vi.waitFor(() => expect(stderr.mock.calls.flat().join(""))
      .toContain(reason + "); using Default only"), { timeout: 5_000 });
    expect(models(h.publications[0]!, "muse")).toEqual(["default"]);
    expect(h.publications).toHaveLength(1);
  } finally {
    await h.dispose();
    stderr.mockRestore();
  }
}, 10_000);

it("does not probe a disabled Muse capability", async () => {
  const h = await start("ok", ["claude-code"]);
  try {
    expect(await acpProbesSettled()).toBe(true);
    expect(h.muse.transcript()).toEqual([]);
    expect(models(h.publications[0]!, "muse")).toBeUndefined();
  } finally {
    await h.dispose();
  }
});

it("aborts an in-flight Muse probe on close", async () => {
  const h = await start("hang");
  try {
    await vi.waitFor(() => expect(h.muse.transcript().at(-1)?.method)
      .toBe("model/list"));
    const pid = Number(h.muse.transcript()[0]?.pid);
    expect(pid).toBeGreaterThan(1);
    h.close();
    expect(await acpProbesSettled()).toBe(true);
    expect(() => process.kill(pid, 0)).toThrow();
    expect(h.publications).toHaveLength(1);
  } finally {
    await h.dispose();
  }
}, 12_000);

it("drops a result whose successful child is still closing at shutdown", async () => {
  const h = await start("slow-exit");
  try {
    h.muse.release();
    await vi.waitFor(() => expect(h.muse.transcript().at(-1)?.method)
      .toBe("terminating"));
    h.close();
    expect(await acpProbesSettled()).toBe(true);
    expect(h.publications).toHaveLength(1);
  } finally {
    await h.dispose();
  }
});
