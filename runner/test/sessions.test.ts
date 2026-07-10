import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  encodeCwd,
  isValidSessionId,
  codexSessionExistsIn,
  listCodexSessionsIn,
  listSessionsIn,
  projectsDir,
  sessionExistsIn,
} from "../src/sessions.js";

describe("encodeCwd", () => {
  it("非英数字を '-' に置換する", () => {
    expect(encodeCwd("/home/user/git/kaoiro")).toBe("-home-user-git-kaoiro");
  });
  it("'/.claude' は '--claude' になる(/ と . の両方)", () => {
    expect(encodeCwd("/a/.claude/b")).toBe("-a--claude-b");
  });
});

describe("projectsDir", () => {
  it("~/.claude/projects/<encoded> を指す", () => {
    expect(projectsDir("/home/user/git/kaoiro")).toMatch(
      /\.claude\/projects\/-home-user-git-kaoiro$/,
    );
  });
});

describe("isValidSessionId", () => {
  it("UUID 形式を許可する", () => {
    expect(isValidSessionId("18e5c092-3d60-48f8-a1ac-1112a35ed428")).toBe(true);
  });
  it("path 区切り・ドットを弾く(path 安全性)", () => {
    expect(isValidSessionId("../evil")).toBe(false);
    expect(isValidSessionId("a/b")).toBe(false);
    expect(isValidSessionId("a.b")).toBe(false);
    expect(isValidSessionId("")).toBe(false);
  });
});

describe("listSessionsIn / sessionExistsIn", () => {
  const dir = mkdtempSync(join(tmpdir(), "kaoiro-sessions-test-"));
  const id = "11111111-2222-3333-4444-555555555555";
  writeFileSync(join(dir, `${id}.jsonl`), "{}\n");
  writeFileSync(join(dir, "not-a-session.txt"), "x"); // 非 jsonl は除外
  writeFileSync(join(dir, "bad..id.jsonl"), "x"); // 不正 charset は除外

  it("有効な jsonl のみを session として返す", () => {
    const sessions = listSessionsIn(dir);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.session_id).toBe(id);
    expect(typeof sessions[0]?.mtime).toBe("string");
  });

  it("存在しないディレクトリは空配列", () => {
    expect(listSessionsIn(join(dir, "nope"))).toEqual([]);
  });

  it("sessionExistsIn は存在する session に true", () => {
    expect(sessionExistsIn(dir, id)).toBe(true);
  });

  it("sessionExistsIn は不在・不正 id に false", () => {
    expect(sessionExistsIn(dir, "99999999-0000-0000-0000-000000000000")).toBe(
      false,
    );
    expect(sessionExistsIn(dir, "../evil")).toBe(false);
  });
});

describe("listSessionsIn — summary (#73)", () => {
  const dir = mkdtempSync(join(tmpdir(), "kaoiro-summary-test-"));
  const ids = {
    title: "aaaaaaaa-2222-3333-4444-555555555555",
    user: "bbbbbbbb-2222-3333-4444-555555555555",
    prefer: "cccccccc-2222-3333-4444-555555555555",
    none: "dddddddd-2222-3333-4444-555555555555",
    long: "eeeeeeee-2222-3333-4444-555555555555",
  };
  const jsonl = (lines: object[]): string =>
    `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`;

  writeFileSync(
    join(dir, `${ids.title}.jsonl`),
    jsonl([
      { type: "user", message: { role: "user", content: "最初の質問" } },
      { type: "ai-title", aiTitle: "セッションのタイトル" },
    ]),
  );
  writeFileSync(
    join(dir, `${ids.user}.jsonl`),
    jsonl([
      { type: "file-history-snapshot", snapshot: {} },
      { type: "user", message: { role: "user", content: "ユーザの最初の指示" } },
    ]),
  );
  writeFileSync(
    join(dir, `${ids.prefer}.jsonl`),
    jsonl([
      { type: "user", message: { role: "user", content: "user が先" } },
      { type: "ai-title", aiTitle: "タイトルを優先" },
    ]),
  );
  writeFileSync(
    join(dir, `${ids.none}.jsonl`),
    jsonl([
      { type: "system", subtype: "init" },
      { type: "user", isMeta: true, message: { role: "user", content: "<reminder>" } },
      {
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t", content: "x" }],
        },
      },
    ]),
  );
  writeFileSync(
    join(dir, `${ids.long}.jsonl`),
    jsonl([{ type: "user", message: { role: "user", content: "あ".repeat(200) } }]),
  );

  const byId = (): Record<string, { summary?: string }> =>
    Object.fromEntries(listSessionsIn(dir).map((s) => [s.session_id, s]));

  it("ai-title を summary に使う", () => {
    expect(byId()[ids.title]?.summary).toBe("セッションのタイトル");
  });
  it("ai-title が無ければ先頭 user 指示を使う", () => {
    expect(byId()[ids.user]?.summary).toBe("ユーザの最初の指示");
  });
  it("ai-title を user 指示より優先する", () => {
    expect(byId()[ids.prefer]?.summary).toBe("タイトルを優先");
  });
  it("title も user 指示も無ければ summary 無し", () => {
    expect(byId()[ids.none]?.summary).toBeUndefined();
  });
  it("長い summary は 100 字に切り詰める", () => {
    const s = byId()[ids.long]?.summary;
    expect(s).toBeDefined();
    expect(s?.length).toBe(100);
    expect(s?.endsWith("...")).toBe(true);
  });
});

describe("codex rollouts (ADR-0032 F8)", () => {
  const root = mkdtempSync(join(tmpdir(), "kaoiro-codex-sessions-test-"));
  const day = join(root, "2026", "07", "10");
  mkdirSync(day, { recursive: true });
  const uuid = "019f4bdb-d821-7631-aee1-ec7982060311";
  const meta = (cwd: string): string =>
    `${JSON.stringify({
      timestamp: "2026-07-10T11:48:46.817Z",
      type: "session_meta",
      payload: { id: uuid, cwd },
    })}\n`;
  writeFileSync(
    join(day, `rollout-2026-07-10T20-48-46-${uuid}.jsonl`),
    meta("/repo/a"),
  );
  const other = "019f4bdb-d821-7631-aee1-ec7982060399";
  writeFileSync(
    join(day, `rollout-2026-07-10T21-00-00-${other}.jsonl`),
    meta("/repo/b"),
  );
  writeFileSync(join(day, "not-a-rollout.txt"), "x");

  it("listCodexSessionsIn は session_meta.cwd の一致分のみ返す", () => {
    const sessions = listCodexSessionsIn(root, "/repo/a");
    expect(sessions.map((s) => s.session_id)).toEqual([uuid]);
    expect(sessions[0]?.mtime).toBeDefined();
  });

  it("codexSessionExistsIn は cwd 一致の T3 チェックを行う", () => {
    expect(codexSessionExistsIn(root, "/repo/a", uuid)).toBe(true);
    expect(codexSessionExistsIn(root, "/repo/b", uuid)).toBe(false);
    expect(codexSessionExistsIn(root, "/repo/a", "../etc")).toBe(false);
    expect(codexSessionExistsIn(root, "/repo/a", other)).toBe(false);
  });

  it("root 不在は空を返す", () => {
    expect(listCodexSessionsIn(join(root, "nope"), "/repo/a")).toEqual([]);
  });
});
