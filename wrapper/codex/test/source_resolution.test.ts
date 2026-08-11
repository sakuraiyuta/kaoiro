import { describe, expect, it } from "vitest";
import type { WrapperConfig } from "@kaoiro/protocol";
import { makeLog } from "@kaoiro/agent-common";
import { CodexHost } from "../src/host.js";
import {
  applyEnvDefaultModel,
  resolveCodexSources,
} from "../src/source_resolution.js";

const baseConfig: WrapperConfig = {
  agent_id: "test.agent",
  persona: { id: "p", name: "P", sprite_set: "p" },
  server_url: "ws://localhost:4000/wrapper",
};

describe("resolveCodexSources (phase-23 P1 pair-aware, 藤 R3 unit)", () => {
  it("resume 由来 config.model_source (explicit Case 3) を preserve", () => {
    const out = resolveCodexSources(
      { ...baseConfig, model: "gpt-5.6-sol", model_source: "launch" },
      undefined,
    );
    expect(out.modelSource).toBe("launch");
  });

  it("config.model set / model_source なし (Case 4 legacy or fresh spawn) → 'config'", () => {
    const out = resolveCodexSources(
      { ...baseConfig, model: "gpt-5.5" },
      undefined,
    );
    expect(out.modelSource).toBe("config");
  });

  it("config.model なし / env default 有 → 'env'", () => {
    const out = resolveCodexSources(baseConfig, "gpt-5.4-mini");
    expect(out.modelSource).toBe("env");
  });

  it("config.model / env とも無し → undefined (host が default stamp)", () => {
    const out = resolveCodexSources(baseConfig, undefined);
    expect(out.modelSource).toBeUndefined();
  });

  it("config.effort_source (Case 3) を preserve", () => {
    const out = resolveCodexSources(
      { ...baseConfig, effort: "high", effort_source: "launch" },
      undefined,
    );
    expect(out.effortSource).toBe("launch");
  });

  it("config.effort set / effort_source なし → 'config'", () => {
    const out = resolveCodexSources(
      { ...baseConfig, effort: "medium" },
      undefined,
    );
    expect(out.effortSource).toBe("config");
  });

  it("config.effort なし → effortSource undefined", () => {
    const out = resolveCodexSources(baseConfig, undefined);
    expect(out.effortSource).toBeUndefined();
  });

  it("env が model_source を上書きしない (config.model_source が最優先)", () => {
    // Case 3 の pair rule: resume 由来 launch を env 経由の 'env' で上書きしない。
    const out = resolveCodexSources(
      { ...baseConfig, model: "gpt-5.6-sol", model_source: "launch" },
      "gpt-5.4-mini",
    );
    expect(out.modelSource).toBe("launch");
  });
});

describe("applyEnvDefaultModel (issue #197 段階3, ふじ MF-1 レビュー指摘)", () => {
  it("config.model 未設定 + env 設定済みなら同一オブジェクトを in-place で書き換える", () => {
    const config: WrapperConfig = { ...baseConfig };
    applyEnvDefaultModel(config, "gpt-5.4-mini");
    expect(config.model).toBe("gpt-5.4-mini");
  });

  it("config.model が既に設定済みなら上書きしない", () => {
    const config: WrapperConfig = { ...baseConfig, model: "gpt-5.6-sol" };
    applyEnvDefaultModel(config, "gpt-5.4-mini");
    expect(config.model).toBe("gpt-5.6-sol");
  });

  it("env 未設定なら何もしない", () => {
    const config: WrapperConfig = { ...baseConfig };
    applyEnvDefaultModel(config, undefined);
    expect(config.model).toBeUndefined();
  });

  // MF-1 の核心: 「{ ...config, model }」の shallow clone を作らず同一
  // object を返す (というより mutate する) ことで、CodexHost と他の
  // producer (ここでは makeLog) が同じ config 参照を共有し続け、
  // rename が両方に見えることを実測で固定する。旧実装 (shallow clone)
  // だと、CodexHost 側は clone を経由するので rename が見えるが、
  // makeLog 側は clone 前の元 config を使っていたため rename が
  // 一切見えなかった (env-default が効いた場合に限り分裂する、という
  // ふじ指摘のシナリオそのもの)。
  it("rename 後、CodexHost と別の producer (makeLog) が同じ新しい persona.name を見る (MF-1 再発防止)", () => {
    const config: WrapperConfig = { ...baseConfig };
    applyEnvDefaultModel(config, "gpt-5.4-mini");
    expect(config.model).toBe("gpt-5.4-mini");

    const envs: Array<{ persona: { name: string } }> = [];
    const host = new CodexHost(config, {
      onState: (e) => envs.push(e),
      appendSystemPrompt: "p",
      now: () => "T",
    });

    host.renamePersona("P(改名)", 1);

    // producer 1: CodexHost 自身が発行した state_change。
    expect(envs.at(-1)?.persona.name).toBe("P(改名)");
    // producer 2: cli.ts の onInstruction 相当、CodexHost とは独立に
    // config を直接読んで envelope を組み立てる呼び出し。
    const logEnvelope = makeLog(config, "waiting_input", "T", {
      kind: "user",
      text: "hi",
    });
    expect(logEnvelope.persona.name).toBe("P(改名)");
  });
});
