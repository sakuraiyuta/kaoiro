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
});
