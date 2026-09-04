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
});
