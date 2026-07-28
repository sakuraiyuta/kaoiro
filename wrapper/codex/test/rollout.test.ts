import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  codexModelFromRolloutIn,
  codexRateLimitsFromRolloutIn,
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

describe("codexRateLimitsFromRolloutIn", () => {
  it("token_count.rate_limits を window_minutes で routing し utilization を 0-1 に正規化", () => {
    const root = mkdtempSync(join(tmpdir(), "kaoiro-codex-rl-"));
    const id = "uuid-both";
    writeFileSync(
      join(root, `rollout-${id}.jsonl`),
      [
        JSON.stringify({ type: "session_meta", payload: {} }),
        JSON.stringify({
          type: "event_msg",
          payload: {
            type: "token_count",
            rate_limits: {
              primary: {
                used_percent: 42.5,
                window_minutes: 300,
                resets_at: 1785090000,
              },
              secondary: {
                used_percent: 7,
                window_minutes: 10080,
                resets_at: 1785693232,
              },
            },
          },
        }),
        "",
      ].join("\n"),
    );

    const out = codexRateLimitsFromRolloutIn(root, id);
    expect(out.get("five_hour")).toEqual({
      utilization: 0.425,
      resets_at: 1785090000,
    });
    expect(out.get("seven_day")).toEqual({
      utilization: 0.07,
      resets_at: 1785693232,
    });
  });

  it("最新の token_count のみを採用し古い値は無視", () => {
    const root = mkdtempSync(join(tmpdir(), "kaoiro-codex-rl-"));
    const id = "uuid-latest";
    writeFileSync(
      join(root, `rollout-${id}.jsonl`),
      [
        JSON.stringify({
          type: "event_msg",
          payload: {
            type: "token_count",
            rate_limits: {
              primary: { used_percent: 10, window_minutes: 300, resets_at: 1 },
              secondary: null,
            },
          },
        }),
        JSON.stringify({
          type: "event_msg",
          payload: {
            type: "token_count",
            rate_limits: {
              primary: { used_percent: 55, window_minutes: 300, resets_at: 2 },
              secondary: null,
            },
          },
        }),
        "",
      ].join("\n"),
    );

    const out = codexRateLimitsFromRolloutIn(root, id);
    expect(out.get("five_hour")).toEqual({ utilization: 0.55, resets_at: 2 });
    expect(out.has("seven_day")).toBe(false);
  });

  it("window ごとに最新の token_count を集め、片方しかない最新 event でも 7day を落とさない", () => {
    const root = mkdtempSync(join(tmpdir(), "kaoiro-codex-rl-"));
    const id = "uuid-split-windows";
    writeFileSync(
      join(root, `rollout-${id}.jsonl`),
      [
        JSON.stringify({
          type: "event_msg",
          payload: {
            type: "token_count",
            rate_limits: {
              primary: { used_percent: 17, window_minutes: 10080, resets_at: 7 },
              secondary: null,
            },
          },
        }),
        JSON.stringify({
          type: "event_msg",
          payload: {
            type: "token_count",
            rate_limits: {
              primary: { used_percent: 55, window_minutes: 300, resets_at: 2 },
              secondary: null,
            },
          },
        }),
        "",
      ].join("\n"),
    );

    const out = codexRateLimitsFromRolloutIn(root, id);
    expect(out.get("five_hour")).toEqual({ utilization: 0.55, resets_at: 2 });
    expect(out.get("seven_day")).toEqual({ utilization: 0.17, resets_at: 7 });
  });

  it("rate_limits なし・不正パス・secondary null は空 Map", () => {
    const root = mkdtempSync(join(tmpdir(), "kaoiro-codex-rl-"));
    const noRateLimits = "uuid-none";
    writeFileSync(
      join(root, `rollout-${noRateLimits}.jsonl`),
      [
        JSON.stringify({ type: "turn_context", payload: { model: "x" } }),
        JSON.stringify({
          type: "event_msg",
          payload: { type: "token_count", rate_limits: null },
        }),
        "",
      ].join("\n"),
    );

    expect(codexRateLimitsFromRolloutIn(root, noRateLimits).size).toBe(0);
    expect(codexRateLimitsFromRolloutIn(root, "../escape").size).toBe(0);
    expect(codexRateLimitsFromRolloutIn(root, "missing-id").size).toBe(0);
  });

  it("同一 session への 2 回目呼び出しでも最新の rate_limits を返す (cache が staleness を持ち込まない)", () => {
    const root = mkdtempSync(join(tmpdir(), "kaoiro-codex-rl-fresh-"));
    const id = "uuid-fresh";
    const path = join(root, `rollout-${id}.jsonl`);
    writeFileSync(
      path,
      `${JSON.stringify({
        type: "event_msg",
        payload: {
          type: "token_count",
          rate_limits: {
            primary: { used_percent: 3, window_minutes: 300, resets_at: 1 },
            secondary: null,
          },
        },
      })}\n`,
    );
    expect(codexRateLimitsFromRolloutIn(root, id).get("five_hour")).toEqual({
      utilization: 0.03,
      resets_at: 1,
    });
    // rolloutPathCache は path しか記憶しない (content ではない)。ファイルが
    // 更新されたら 2 回目呼び出しでも新しい値が返る必要がある — cache が
    // stale な rate_limits を保持しないことの保証。
    writeFileSync(
      path,
      `${JSON.stringify({
        type: "event_msg",
        payload: {
          type: "token_count",
          rate_limits: {
            primary: { used_percent: 88, window_minutes: 300, resets_at: 2 },
            secondary: null,
          },
        },
      })}\n`,
    );
    expect(codexRateLimitsFromRolloutIn(root, id).get("five_hour")).toEqual({
      utilization: 0.88,
      resets_at: 2,
    });
  });

  it("未知の window_minutes 値は無視", () => {
    const root = mkdtempSync(join(tmpdir(), "kaoiro-codex-rl-"));
    const id = "uuid-unknown";
    writeFileSync(
      join(root, `rollout-${id}.jsonl`),
      `${JSON.stringify({
        type: "event_msg",
        payload: {
          type: "token_count",
          rate_limits: {
            primary: { used_percent: 5, window_minutes: 999, resets_at: 1 },
            secondary: null,
          },
        },
      })}\n`,
    );

    expect(codexRateLimitsFromRolloutIn(root, id).size).toBe(0);
  });
});
