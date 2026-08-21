import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  codexModelFromRolloutIn,
  codexRateLimitsFromRolloutIn,
  resolveCodexModel,
  codexSidecarPath,
  isRolloutCorruptionDetail,
  verifyRolloutCorruption,
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

describe("codexSidecarPath (ADR-0051 D3-2)", () => {
  it("rollout ファイルと同じディレクトリの <session-id>.ia.jsonl を返す", () => {
    const root = mkdtempSync(join(tmpdir(), "kaoiro-codex-sidecar-"));
    const day = join(root, "2026", "08", "08");
    mkdirSync(day, { recursive: true });
    writeFileSync(join(day, "rollout-2026-08-08T00-00-00-uuid-1.jsonl"), "");

    expect(codexSidecarPath("uuid-1", root)).toBe(
      join(day, "uuid-1.ia.jsonl"),
    );
  });

  it("rollout 未生成なら null (pending journal のまま待つ)", () => {
    const root = mkdtempSync(join(tmpdir(), "kaoiro-codex-sidecar-none-"));
    expect(codexSidecarPath("uuid-missing", root)).toBeNull();
    expect(codexSidecarPath("../escape", root)).toBeNull();
  });
});

// issue #263: 2026-08-17 の ENOSPC 事故 (issue #255 comment 3338) と同じ
// 物理的な壊れ方 — 書き込み途中でファイルが切断される — を rollout に
// 再現する fixture。tailRollout 系の既存ロバスト性 (不正な最終行は
// catch { continue } で黙って読み飛ばす) を実データで再確認しつつ、
// fixture 自体が本当に壊れていることも検証する。
describe("issue #263: rollout 破損パターンの実データ再現", () => {
  it("行途中で UTF-8 マルチバイト文字が切断された rollout でも tailRollout 系は黙ってスキップし、直前の有効行を使う", () => {
    const root = mkdtempSync(join(tmpdir(), "kaoiro-codex-corrupt-utf8-"));
    const id = "uuid-corrupt-utf8";
    const validLine = JSON.stringify({
      type: "turn_context",
      payload: { model: "gpt-before-corruption" },
    });
    // "あ" (U+3042、UTF-8 で E3 81 82 の3バイト) の最後の1バイトを欠いた
    // まま行が終わる — ENOSPC がマルチバイト文字の書き込み途中で
    // ディスクを使い切ったときの壊れ方そのもの。
    const corruptLine = Buffer.concat([
      Buffer.from(
        '{"type":"event_msg","payload":{"type":"agent_message","message":"',
        "utf8",
      ),
      Buffer.from([0xe3, 0x81]),
    ]);
    writeFileSync(
      join(root, `rollout-${id}.jsonl`),
      Buffer.concat([Buffer.from(`${validLine}\n`, "utf8"), corruptLine]),
    );

    expect(codexModelFromRolloutIn(root, id)).toBe("gpt-before-corruption");

    // fixture 自体が本当に不正な UTF-8 であることの検証。
    const raw = readFileSync(join(root, `rollout-${id}.jsonl`));
    const decoder = new TextDecoder("utf-8", { fatal: true });
    expect(() => decoder.decode(raw)).toThrow();

    // ふじ should-fix 3: mkdtemp fixture の後始末。
    rmSync(root, { recursive: true, force: true });
  });

  it("JSON 構造が閉じる前に途切れた rollout でも tailRollout 系は黙ってスキップし、直前の有効行を使う", () => {
    const root = mkdtempSync(join(tmpdir(), "kaoiro-codex-corrupt-json-"));
    const id = "uuid-corrupt-json";
    const validLine = JSON.stringify({
      type: "turn_context",
      payload: { model: "gpt-before-corruption" },
    });
    // rate_limits オブジェクトの数値を書いている途中でディスクが尽きた形。
    const corruptLine =
      '{"type":"event_msg","payload":{"type":"token_count","rate_limits":{"primary":{"used_percent":42.5,"window_minutes":300,"resets_at":178509';

    writeFileSync(
      join(root, `rollout-${id}.jsonl`),
      `${validLine}\n${corruptLine}`,
    );

    expect(codexModelFromRolloutIn(root, id)).toBe("gpt-before-corruption");

    const raw = readFileSync(join(root, `rollout-${id}.jsonl`), "utf8");
    const lastLine = raw.split("\n").at(-1)!;
    expect(() => JSON.parse(lastLine)).toThrow();

    // ふじ should-fix 3: mkdtemp fixture の後始末。
    rmSync(root, { recursive: true, force: true });
  });
});

describe("isRolloutCorruptionDetail (issue #263)", () => {
  it("実測された UTF-8 破損エラー文言にマッチする (issue #255 comment 3338)", () => {
    expect(
      isRolloutCorruptionDetail(
        "Codex Exec exited with code 1: stream did not contain valid UTF-8 (code -32603)",
      ),
    ).toBe(true);
    expect(
      isRolloutCorruptionDetail("stream did not contain valid utf-8"),
    ).toBe(true);
  });

  it("serde_json 慣習の EOF while parsing 文言にマッチする (未確認、保守的に含める)", () => {
    expect(
      isRolloutCorruptionDetail("EOF while parsing a string at line 1 column 42"),
    ).toBe(true);
  });

  it("未知のエラー文言にはマッチせず、呼び出し側は従来の扱いへ fall back する", () => {
    expect(isRolloutCorruptionDetail("network timeout")).toBe(false);
    expect(isRolloutCorruptionDetail("authentication failed")).toBe(false);
    expect(isRolloutCorruptionDetail("rate limit exceeded")).toBe(false);
    expect(isRolloutCorruptionDetail("")).toBe(false);
  });
});

// issue #263 code-review round 2 advisory: verifyRolloutCorruption の2つの
// 独立した失敗経路 (fatal UTF-8 decode / JSON.parse) のうち、host.test.ts
// の統合テストは fatal decode 経路しか踏んでいなかった (corrupted 判定は
// ファイル全体を1回でデコードしてから行単位の JSON.parse に進むため、
// 不正 UTF-8 バイトが1つでもあると decode 側で先に corrupted 確定し、
// JSON.parse 分岐に到達しない)。ここで両分岐と clean/unknown を関数単体で
// 直接 pin する。
describe("verifyRolloutCorruption (issue #263, ふじ MF-1)", () => {
  it("fatal UTF-8 decode 失敗で corrupted と確定する", () => {
    const root = mkdtempSync(join(tmpdir(), "kaoiro-codex-verify-utf8-"));
    const id = "uuid-verify-utf8-truncated";
    const validLine = JSON.stringify({ type: "turn_context", payload: {} });
    // "あ" (E3 81 82) の最終バイトを欠いたまま行が終わる。
    const corruptLine = Buffer.concat([
      Buffer.from('{"type":"event_msg","payload":{"message":"', "utf8"),
      Buffer.from([0xe3, 0x81]),
    ]);
    writeFileSync(
      join(root, `rollout-${id}.jsonl`),
      Buffer.concat([Buffer.from(`${validLine}\n`, "utf8"), corruptLine]),
    );

    expect(verifyRolloutCorruption(id, root)).toBe("corrupted");

    rmSync(root, { recursive: true, force: true });
  });

  it("UTF-8 としては有効だが JSON 構造が不完全な行で corrupted と確定する (JSON.parse 分岐)", () => {
    const root = mkdtempSync(join(tmpdir(), "kaoiro-codex-verify-json-"));
    const id = "uuid-verify-json-truncated";
    const validLine = JSON.stringify({ type: "turn_context", payload: {} });
    // 全て ASCII で有効な UTF-8 だが、JSON としては構造が閉じる前に
    // 切れている — fatal decode は通り、JSON.parse だけが落ちる経路。
    const corruptLine =
      '{"type":"event_msg","payload":{"type":"token_count","rate_limits":{"primary":{"used_percent":42.5,"window_minutes":300,"resets_at":178509';
    writeFileSync(
      join(root, `rollout-${id}.jsonl`),
      `${validLine}\n${corruptLine}`,
    );

    // fixture 自体が JSON.parse 分岐を狙い撃ちしていること (fatal decode
    // では落ちないこと) の確認。
    const raw = readFileSync(join(root, `rollout-${id}.jsonl`));
    expect(() =>
      new TextDecoder("utf-8", { fatal: true }).decode(raw),
    ).not.toThrow();

    expect(verifyRolloutCorruption(id, root)).toBe("corrupted");

    rmSync(root, { recursive: true, force: true });
  });

  it("全行が有効な rollout は clean と判定する", () => {
    const root = mkdtempSync(join(tmpdir(), "kaoiro-codex-verify-clean-"));
    const id = "uuid-verify-clean";
    writeFileSync(
      join(root, `rollout-${id}.jsonl`),
      `${JSON.stringify({ type: "turn_context", payload: {} })}\n`,
    );

    expect(verifyRolloutCorruption(id, root)).toBe("clean");

    rmSync(root, { recursive: true, force: true });
  });

  it("session id に対応する rollout が無ければ unknown と判定する (呼び出し側は clean と同様 fallback する)", () => {
    const root = mkdtempSync(join(tmpdir(), "kaoiro-codex-verify-unknown-"));

    expect(verifyRolloutCorruption("uuid-no-such-session", root)).toBe(
      "unknown",
    );

    rmSync(root, { recursive: true, force: true });
  });
});
