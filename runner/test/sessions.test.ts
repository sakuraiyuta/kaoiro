import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  encodeCwd,
  isValidSessionId,
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
