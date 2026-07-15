import { describe, expect, it, vi } from "vitest";
import type {
  EngineCatalogResult,
  EngineModelInfo,
  RunnerRegister,
} from "@kaoiro/protocol";
import { ClaudeCatalogCache } from "../src/claude_catalog_cache.js";
import { makeRefreshEngineCatalogHandler } from "../src/engine_catalog_refresh.js";
import type { ProbeOutcome } from "../src/claude_probe.js";
import type { RunnerConfig } from "../src/config.js";
import type { CodexAuthMode } from "../src/codex-auth.js";

const CONFIG: RunnerConfig = {
  host_id: "lab-pc-1",
  server_url: "ws://localhost:4000/runner",
  cwd_allowlist: ["/tmp/x"],
  capabilities: ["claude-code", "codex"],
};

const MODELS: EngineModelInfo[] = [
  { value: "default", display_name: "Default", description: "" },
  { value: "opus[1m]", display_name: "Opus 1M", description: "" },
];

/** Build a handler wired to fresh spies so each test starts from a clean
 *  slate. Returns the handler plus the recorders callers can assert on. */
function makeHarness(
  probeImpl: () => Promise<ProbeOutcome> = async () => ({
    ok: true,
    models: MODELS,
    elapsed_ms: 12,
    source: "init",
  }),
) {
  const cache = new ClaudeCatalogCache({ ttlMs: 60_000 });
  const registers: RunnerRegister[] = [];
  const results: EngineCatalogResult[] = [];
  const codexAuthMode: CodexAuthMode = "unknown";
  const handler = makeRefreshEngineCatalogHandler({
    getHostId: () => "lab-pc-1",
    cache,
    getCurrentConfig: () => CONFIG,
    getCodexAuthMode: () => codexAuthMode,
    updateRegister: (r) => registers.push(r),
    sendCatalogResult: (r) => results.push(r),
    probe: probeImpl,
  });
  return { handler, registers, results, cache };
}

describe("makeRefreshEngineCatalogHandler", () => {
  it("有効な payload で probe が成功したら updateRegister + ok=true を送る", async () => {
    const h = makeHarness();
    h.handler({
      version: "0",
      engine: "claude-code",
      request_id: "req-1",
    });
    await new Promise((r) => setImmediate(r));
    expect(h.registers).toHaveLength(1);
    const claudeEntry = h.registers[0]!.engines?.find(
      (e) => e.id === "claude-code",
    );
    expect(claudeEntry?.models).toEqual(MODELS);
    expect(h.results).toEqual([
      {
        version: "0",
        host_id: "lab-pc-1",
        engine: "claude-code",
        request_id: "req-1",
        ok: true,
        models_count: 2,
      },
    ]);
  });

  it("probe が失敗したら updateRegister を呼ばず ok=false + reason を送る", async () => {
    const h = makeHarness(async () => ({
      ok: false,
      reason: "auth_failed",
      elapsed_ms: 5,
    }));
    h.handler({
      version: "0",
      engine: "claude-code",
      request_id: "req-2",
    });
    await new Promise((r) => setImmediate(r));
    expect(h.registers).toHaveLength(0);
    expect(h.results[0]).toEqual({
      version: "0",
      host_id: "lab-pc-1",
      engine: "claude-code",
      request_id: "req-2",
      ok: false,
      reason: "auth_failed",
    });
  });

  it("engine=codex は unsupported_engine で即失敗を返す (probe は呼ばない)", async () => {
    const probe = vi.fn<() => Promise<ProbeOutcome>>();
    const h = makeHarness(probe);
    h.handler({
      version: "0",
      engine: "codex",
      request_id: "req-3",
    });
    await new Promise((r) => setImmediate(r));
    expect(probe).not.toHaveBeenCalled();
    expect(h.results[0]).toMatchObject({
      engine: "codex",
      ok: false,
      reason: "unsupported_engine",
    });
  });

  it("engine / request_id 欠落の malformed payload は無応答 (silently drop)", async () => {
    const h = makeHarness();
    h.handler({ version: "0", request_id: "no-engine" });
    h.handler({ engine: "claude-code" });
    h.handler(null);
    h.handler("string");
    await new Promise((r) => setImmediate(r));
    expect(h.results).toHaveLength(0);
    expect(h.registers).toHaveLength(0);
  });

  it("force=false 時は runner cache が fresh なら probe を skip する", async () => {
    let probeCalls = 0;
    const h = makeHarness(async () => {
      probeCalls++;
      return { ok: true, models: MODELS, elapsed_ms: 10, source: "init" };
    });
    h.handler({
      version: "0",
      engine: "claude-code",
      request_id: "req-a",
    });
    await new Promise((r) => setImmediate(r));
    h.handler({
      version: "0",
      engine: "claude-code",
      request_id: "req-b",
    });
    await new Promise((r) => setImmediate(r));
    expect(probeCalls).toBe(1);
    // 2 回とも ok=true 応答が返る
    expect(h.results.map((r) => r.request_id)).toEqual(["req-a", "req-b"]);
  });

  it("cache-hit / dedup fan-out は updateRegister を追加で呼ばない (医 medium)", async () => {
    let resolveProbe: (o: ProbeOutcome) => void = () => {};
    let probeCalls = 0;
    const h = makeHarness(
      () =>
        new Promise<ProbeOutcome>((resolve) => {
          probeCalls++;
          resolveProbe = resolve;
        }),
    );
    // 3 リクエストを同時 (dedup 発火)
    h.handler({ version: "0", engine: "claude-code", request_id: "req-1" });
    h.handler({ version: "0", engine: "claude-code", request_id: "req-2" });
    h.handler({ version: "0", engine: "claude-code", request_id: "req-3" });
    // 1 probe だけ走る
    expect(probeCalls).toBe(1);
    resolveProbe({ ok: true, models: MODELS, elapsed_ms: 5, source: "init" });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    // updateRegister は 1 回のみ (dedup 待機側 2 件は source:"cache" で抑制)
    expect(h.registers).toHaveLength(1);
    // 3 リクエスト全てに ok=true 応答
    expect(h.results.map((r) => r.request_id).sort()).toEqual([
      "req-1",
      "req-2",
      "req-3",
    ]);
    // 追加の cache-hit refresh は updateRegister を呼ばない
    h.handler({ version: "0", engine: "claude-code", request_id: "req-4" });
    await new Promise((r) => setImmediate(r));
    expect(h.registers).toHaveLength(1);
  });

  it("getHostId は live getter として呼ばれ、変更後の値が catalog_result に載る (must-fix 2)", async () => {
    const cache = new ClaudeCatalogCache({ ttlMs: 60_000 });
    let currentHostId = "lab-pc-1";
    const results: EngineCatalogResult[] = [];
    const handler = makeRefreshEngineCatalogHandler({
      getHostId: () => currentHostId,
      cache,
      getCurrentConfig: () => CONFIG,
      getCodexAuthMode: () => "unknown",
      updateRegister: () => {},
      sendCatalogResult: (r) => results.push(r),
      probe: async () => ({
        ok: true,
        models: MODELS,
        elapsed_ms: 5,
        source: "init",
      }),
    });
    handler({ version: "0", engine: "claude-code", request_id: "req-old" });
    await new Promise((r) => setImmediate(r));
    currentHostId = "lab-pc-2";
    handler({ version: "0", engine: "claude-code", request_id: "req-new" });
    await new Promise((r) => setImmediate(r));
    const byId = Object.fromEntries(results.map((r) => [r.request_id, r]));
    expect(byId["req-old"]!.host_id).toBe("lab-pc-1");
    expect(byId["req-new"]!.host_id).toBe("lab-pc-2");
  });
});
