import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  codexModelFromRolloutIn,
  resolveCodexModel,
} from "../src/rollout.js";

describe("codexModelFromRolloutIn", () => {
  it("turn_context の最新 model を返す", () => {
    const root = mkdtempSync(join(tmpdir(), "kaoiro-codex-rollout-"));
    const day = join(root, "2026", "07", "12");
    mkdirSync(day, { recursive: true });
    const id = "019f55d8-88c5-7823-8d3a-4d0b0c8d74dc";
    writeFileSync(
      join(day, `rollout-2026-07-12T00-00-00-${id}.jsonl`),
      [
        JSON.stringify({ type: "session_meta", payload: { cwd: "/repo" } }),
        JSON.stringify({ type: "turn_context", payload: { model: "gpt-old" } }),
        JSON.stringify({ type: "response_item", payload: {} }),
        JSON.stringify({ type: "turn_context", payload: { model: "gpt-current" } }),
        "",
      ].join("\n"),
    );

    expect(codexModelFromRolloutIn(root, id)).toBe("gpt-current");
  });

  it("書きかけの最終行を無視して直前の model を返す", () => {
    const root = mkdtempSync(join(tmpdir(), "kaoiro-codex-rollout-"));
    const id = "uuid-partial";
    writeFileSync(
      join(root, `rollout-${id}.jsonl`),
      `${JSON.stringify({ type: "turn_context", payload: { model: "gpt-ok" } })}\n{"type":"turn_context"`,
    );

    expect(codexModelFromRolloutIn(root, id)).toBe("gpt-ok");
  });

  it("不正 session id・未作成 rollout は null", () => {
    const root = mkdtempSync(join(tmpdir(), "kaoiro-codex-rollout-"));
    expect(codexModelFromRolloutIn(root, "../escape")).toBeNull();
    expect(codexModelFromRolloutIn(root, "missing-id")).toBeNull();
  });

  it("rollout の作成 race を再試行して解決する", async () => {
    const root = mkdtempSync(join(tmpdir(), "kaoiro-codex-rollout-"));
    const id = "uuid-race";
    setTimeout(() => {
      writeFileSync(
        join(root, `rollout-${id}.jsonl`),
        `${JSON.stringify({ type: "turn_context", payload: { model: "gpt-race" } })}\n`,
      );
    }, 30);

    await expect(resolveCodexModel(id, root)).resolves.toBe("gpt-race");
  });
});
