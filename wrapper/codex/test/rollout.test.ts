import "../../../scripts/test/fixtures/test-isolation.mjs";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  captureCodexPermissionRolloutCursor,
  codexPermissionContextAfter,
  codexRateLimitsFromRolloutIn,
  codexSidecarPath,
} from "../src/rollout.js";

function permissionTurnContext(
  turnId: string,
  sandbox: "read-only" | "workspace-write" | "danger-full-access",
  networkAccess = false,
): string {
  const sandbox_policy = sandbox === "workspace-write"
    ? { type: sandbox, network_access: networkAccess }
    : { type: sandbox };
  return JSON.stringify({
    type: "turn_context",
    payload: {
      turn_id: turnId,
      approval_policy: "never",
      sandbox_policy,
    },
  });
}

describe("Codex permission rollout cursor", () => {
  it("reads exactly one complete turn_context appended after the execution boundary", () => {
    const root = mkdtempSync(join(tmpdir(), "kaoiro-codex-permission-"));
    const id = "permission-boundary";
    const path = join(root, `rollout-${id}.jsonl`);
    writeFileSync(path, `${permissionTurnContext("old-turn", "read-only")}\n`);
    const captured = captureCodexPermissionRolloutCursor(root, id);
    const cursor = { ...captured, knownTurnIds: new Set<string>() };

    writeFileSync(
      path,
      `${permissionTurnContext("old-turn", "read-only")}\n${permissionTurnContext("new-turn", "workspace-write", true)}\n`,
    );

    expect(codexPermissionContextAfter(cursor, id)).toEqual({
      sessionId: id,
      turnId: "new-turn",
      sandbox: "workspace-write",
      networkAccess: true,
      approvalPolicy: "never",
    });
  });

  it("does not promote a pre-bound record, a partial write, or another session", () => {
    const root = mkdtempSync(join(tmpdir(), "kaoiro-codex-permission-"));
    const id = "permission-unconfirmed";
    const path = join(root, `rollout-${id}.jsonl`);
    writeFileSync(path, `${permissionTurnContext("old-turn", "read-only")}\n`);
    const cursor = captureCodexPermissionRolloutCursor(root, id);

    expect(codexPermissionContextAfter(cursor, id)).toBeNull();
    expect(codexPermissionContextAfter(cursor, "other-session")).toBeNull();

    writeFileSync(
      path,
      `${permissionTurnContext("old-turn", "read-only")}\n${permissionTurnContext("new-turn", "workspace-write", true)}`,
    );
    expect(codexPermissionContextAfter(cursor, id)).toBeNull();
  });

  it("does not treat a later-visible resumed rollout as a fresh execution boundary", () => {
    const root = mkdtempSync(join(tmpdir(), "kaoiro-codex-permission-"));
    const id = "permission-missing-resume-baseline";
    const hidden = join(root, "hidden-rollout.jsonl");
    const path = join(root, `rollout-${id}.jsonl`);
    writeFileSync(hidden, `${permissionTurnContext("old-turn", "read-only")}\n`);

    const cursor = captureCodexPermissionRolloutCursor(root, id);
    expect(cursor.resumeBaselineUnavailable).toBe(true);
    renameSync(hidden, path);

    expect(codexPermissionContextAfter(cursor, id)).toBeNull();
    rmSync(root, { recursive: true, force: true });
  });

  it("does not trust a resumed boundary when known-turn reading was unavailable", () => {
    const root = mkdtempSync(join(tmpdir(), "kaoiro-codex-permission-"));
    const id = "permission-unreadable-resume-baseline";
    const path = join(root, `rollout-${id}.jsonl`);
    writeFileSync(path, `${permissionTurnContext("old-turn", "read-only")}\n`);
    try {
      chmodSync(path, 0o000);
      const cursor = captureCodexPermissionRolloutCursor(root, id);
      expect(cursor.resumeBaselineUnavailable).toBe(true);
      chmodSync(path, 0o600);
      writeFileSync(
        path,
        `${permissionTurnContext("old-turn", "read-only")}\n`,
        { flag: "a" },
      );
      expect(codexPermissionContextAfter(cursor, id)).toBeNull();
    } finally {
      chmodSync(path, 0o600);
      rmSync(root, { recursive: true, force: true });
    }
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
      type: "event_msg",
      payload: {
        type: "token_count",
        rate_limits: {
          primary: {
            used_percent: 12.5,
            window_minutes: 300,
            resets_at: 1700000000,
          },
          secondary: null,
        },
      },
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

    expect(codexRateLimitsFromRolloutIn(root, id).get("five_hour")).toEqual({
      utilization: 0.125,
      resets_at: 1700000000,
    });

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
      type: "event_msg",
      payload: {
        type: "token_count",
        rate_limits: {
          primary: {
            used_percent: 12.5,
            window_minutes: 300,
            resets_at: 1700000000,
          },
          secondary: null,
        },
      },
    });
    // rate_limits オブジェクトの数値を書いている途中でディスクが尽きた形。
    const corruptLine =
      '{"type":"event_msg","payload":{"type":"token_count","rate_limits":{"primary":{"used_percent":42.5,"window_minutes":300,"resets_at":178509';

    writeFileSync(
      join(root, `rollout-${id}.jsonl`),
      `${validLine}\n${corruptLine}`,
    );

    expect(codexRateLimitsFromRolloutIn(root, id).get("five_hour")).toEqual({
      utilization: 0.125,
      resets_at: 1700000000,
    });

    const raw = readFileSync(join(root, `rollout-${id}.jsonl`), "utf8");
    const lastLine = raw.split("\n").at(-1)!;
    expect(() => JSON.parse(lastLine)).toThrow();

    // ふじ should-fix 3: mkdtemp fixture の後始末。
    rmSync(root, { recursive: true, force: true });
  });
});
