import { describe, expect, it } from "vitest";
import type { RunnerConfig } from "../src/config.js";
import { changedFields } from "../src/config-diff.js";

const base: RunnerConfig = {
  host_id: "lab-pc-1",
  server_url: "ws://localhost:4000/runner",
  cwd_allowlist: ["/home/user/git/kaoiro"],
};

describe("changedFields", () => {
  it.each([
    [
      "追加",
      base,
      { ...base, context_work_budget_percent: 60 },
    ],
    [
      "変更",
      { ...base, context_work_budget_percent: 60 },
      { ...base, context_work_budget_percent: 80 },
    ],
    [
      "削除",
      { ...base, context_work_budget_percent: 60 },
      base,
    ],
  ] as const)("作業予算率だけの %s を hot reload 対象にする", (_kind, prev, next) => {
    expect(changedFields(prev, next)).toEqual(["context_work_budget_percent"]);
  });

  // issue #292 MF-2: codex / antigravity are whole-object compares, so a
  // change buried inside extra_models must still surface as one entry
  // rather than being silently missed by a shallow per-field diff.
  it("codex.extra_models だけの変更を codex ブロックとして hot reload 対象にする", () => {
    const prev: RunnerConfig = {
      ...base,
      codex: { extra_models: [{ value: "gpt-6-astra", display_name: "Astra" }] },
    };
    const next: RunnerConfig = {
      ...base,
      codex: {
        extra_models: [{ value: "gpt-6-astra", display_name: "overridden" }],
      },
    };
    expect(changedFields(prev, next)).toEqual(["codex"]);
  });

  it("antigravity.extra_models だけの変更を antigravity ブロックとして hot reload 対象にする", () => {
    const prev: RunnerConfig = { ...base };
    const next: RunnerConfig = {
      ...base,
      antigravity: {
        extra_models: [{ value: "gemini-4-nova", display_name: "Gemini 4 Nova" }],
      },
    };
    expect(changedFields(prev, next)).toEqual(["antigravity"]);
  });

  it("claude_code だけの変更を claude_code ブロックとして hot reload 対象にする", () => {
    const next: RunnerConfig = { ...base, claude_code: { folds_per_turn: 5 } };
    expect(changedFields(base, next)).toEqual(["claude_code"]);
    expect(
      changedFields(next, { ...base, claude_code: { folds_per_turn: 6 } }),
    ).toEqual(["claude_code"]);
    expect(changedFields(next, next)).toEqual([]);
  });

  // issue #469: a key missing from the diff makes applyReload return early and
  // the change is never applied. The fixture below must list every key of
  // RunnerConfig (typed Required<>), and each is mutated in turn.
  it("RunnerConfig の全 top-level key の変更を差分に含める", () => {
    const full: Required<RunnerConfig> = {
      host_id: "h",
      server_url: "ws://a/runner",
      personas: [{ id: "p", name: "P", sprite_set: "p" }],
      allowed_personas: ["p"],
      blocked_personas: ["q"],
      cwd_allowlist: ["/a"],
      context_work_budget_percent: 60,
      capabilities: ["codex"],
      codex: { backend: "exec" },
      antigravity: { probe_timeout_ms: 2000 },
      claude_code: { folds_per_turn: 3 },
      permission_timeout_ms: 1000,
    };
    const changed: Required<RunnerConfig> = {
      host_id: "h2",
      server_url: "ws://b/runner",
      personas: [{ id: "p2", name: "P", sprite_set: "p" }],
      allowed_personas: ["p2"],
      blocked_personas: ["q2"],
      cwd_allowlist: ["/b"],
      context_work_budget_percent: 70,
      capabilities: ["claude-code"],
      codex: { backend: "app-server" },
      antigravity: { probe_timeout_ms: 3000 },
      claude_code: { folds_per_turn: 4 },
      permission_timeout_ms: 2000,
    };
    for (const key of Object.keys(full) as (keyof RunnerConfig)[]) {
      expect(
        changedFields(full, { ...full, [key]: changed[key] }),
        key,
      ).toEqual([key]);
    }
  });
});
