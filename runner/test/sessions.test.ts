import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  encodeCwd,
  isValidSessionId,
  antigravitySessionExistsIn,
  codexSessionExistsIn,
  listCodexSessionsIn,
  listSessions,
  listAntigravitySessionsFrom,
  listSessionsIn,
  projectsDir,
  sessionExists,
  sessionExistsIn,
} from "../src/sessions.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

describe("encodeCwd", () => {
  it("非英数字を '-' に置換する", () => {
    expect(encodeCwd("/home/user/git/kaoiro")).toBe("-home-user-git-kaoiro");
  });
  it("'/.claude' は '--claude' になる(/ と . の両方)", () => {
    expect(encodeCwd("/a/.claude/b")).toBe("-a--claude-b");
  });
});

describe("antigravity conversation summary index (issue #386)", () => {
  const root = mkdtempSync(join(tmpdir(), "kaoiro-antigravity-sessions-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const dbPath = join(root, "conversation_summaries.db");
  const cwd = join(root, "workspace");
  const otherCwd = join(root, "other-workspace");
  mkdirSync(cwd);
  mkdirSync(otherCwd);
  const ids = {
    older: "11111111-1111-4111-8111-111111111111",
    newer: "22222222-2222-4222-8222-222222222222",
    other: "33333333-3333-4333-8333-333333333333",
    nested: "44444444-4444-4444-8444-444444444444",
    killed: "55555555-5555-4555-8555-555555555555",
    malformed: "66666666-6666-4666-8666-666666666666",
    missing: "77777777-7777-4777-8777-777777777777",
  };
  const missingCwd = join(root, "not-created-workspace");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA user_version = 3;
    CREATE TABLE conversation_summaries (
      conversation_id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      last_modified_time datetime NOT NULL,
      workspace_uris TEXT NOT NULL,
      nesting_depth INTEGER NOT NULL DEFAULT 0,
      killed numeric NOT NULL DEFAULT false
    );
  `);
  const insert = db.prepare(`
    INSERT INTO conversation_summaries
      (conversation_id, title, last_modified_time, workspace_uris, nesting_depth, killed)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const uris = (...paths: string[]): string => JSON.stringify(paths.map((path) => pathToFileURL(path).href));
  insert.run(ids.older, "older title", "2026-09-26 10:00:00.123456789+00:00", uris(cwd), 0, 0);
  insert.run(ids.newer, "newer title", "2026-09-26 11:00:00.987654321+00:00", uris(cwd), 0, 0);
  insert.run(ids.other, "other", "2026-09-26 12:00:00.000000000+00:00", uris(otherCwd), 0, 0);
  insert.run(ids.nested, "nested", "2026-09-26 13:00:00.000000000+00:00", uris(cwd), 1, 0);
  insert.run(ids.killed, "killed", "2026-09-26 14:00:00.000000000+00:00", uris(cwd), 0, 1);
  insert.run(ids.malformed, "malformed", "2026-09-26 15:00:00.000000000+00:00", "not-json", 0, 0);
  insert.run(ids.missing, "missing path", "2026-09-26 09:00:00.000000000+00:00", uris(missingCwd), 0, 0);
  db.close();

  it("lists newest matching workspace rows, excludes nested rows, and retains killed rows", () => {
    const warnings: string[] = [];
    const sessions = listAntigravitySessionsFrom(dbPath, cwd, { warn: (warning) => warnings.push(warning) });
    expect(sessions.map((session) => session.session_id)).toEqual([ids.killed, ids.newer, ids.older]);
    expect(sessions[1]).toMatchObject({ summary: "newer title", mtime: "2026-09-26T11:00:00.988Z" });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("invalid_workspace");
  });

  it("checks exact IDs against the same workspace while allowing nested and killed known rows", () => {
    expect(antigravitySessionExistsIn(dbPath, cwd, ids.newer)).toBe(true);
    expect(antigravitySessionExistsIn(dbPath, cwd, ids.nested)).toBe(true);
    expect(antigravitySessionExistsIn(dbPath, cwd, ids.killed)).toBe(true);
    expect(antigravitySessionExistsIn(dbPath, cwd, ids.other)).toBe(false);
    expect(antigravitySessionExistsIn(dbPath, cwd, "../bad")).toBe(false);
    expect(antigravitySessionExistsIn(dbPath, cwd, "77777777-7777-4777-8777-777777777777")).toBe(false);
  });

  it("matches a nonexistent cwd only by its normalized literal path", () => {
    expect(listAntigravitySessionsFrom(dbPath, missingCwd).map((session) => session.session_id)).toEqual([ids.missing]);
    expect(listAntigravitySessionsFrom(dbPath, `${missingCwd}-child`)).toEqual([]);
  });

  it("matches percent-encoded paths, realpaths symlink cwd, and rejects non-file authorities", () => {
    const unicode = join(root, "テスト space");
    mkdirSync(unicode);
    const symlink = join(root, "workspace-link");
    symlinkSync(cwd, symlink, "dir");

    const pathFor = (id: string, workspace: string): void => {
      const writer = new DatabaseSync(dbPath);
      writer.prepare(`
        INSERT INTO conversation_summaries
          (conversation_id, title, last_modified_time, workspace_uris, nesting_depth, killed)
        VALUES (?, '', '2026-09-26 16:00:00.000000000+00:00', ?, 0, 0)
      `).run(id, workspace);
      writer.close();
    };
    const encodedId = "88888888-8888-4888-8888-888888888888";
    pathFor(encodedId, JSON.stringify([pathToFileURL(unicode).href]));
    const hostId = "99999999-9999-4999-8999-999999999999";
    pathFor(hostId, JSON.stringify(["file://host/path", pathToFileURL(cwd).href]));
    const trailingSlashId = "10101010-1010-4010-8010-101010101010";
    pathFor(trailingSlashId, JSON.stringify([`${pathToFileURL(cwd).href}/`]));
    const schemeId = "12121212-1212-4212-8212-121212121212";
    pathFor(schemeId, JSON.stringify(["https://host/path", pathToFileURL(cwd).href]));
    const warnings: string[] = [];
    expect(listAntigravitySessionsFrom(dbPath, symlink, { warn: (warning) => warnings.push(warning) })
      .some((session) => session.session_id === ids.newer)).toBe(true);
    expect(listAntigravitySessionsFrom(dbPath, unicode, { warn: (warning) => warnings.push(warning) })
      .some((session) => session.session_id === encodedId)).toBe(true);
    expect(listAntigravitySessionsFrom(dbPath, cwd, { warn: (warning) => warnings.push(warning) })
      .some((session) => session.session_id === hostId)).toBe(false);
    expect(listAntigravitySessionsFrom(dbPath, cwd, { warn: (warning) => warnings.push(warning) })
      .some((session) => session.session_id === trailingSlashId)).toBe(false);
    expect(listAntigravitySessionsFrom(dbPath, cwd, { warn: (warning) => warnings.push(warning) })
      .some((session) => session.session_id === schemeId)).toBe(true);
    expect(warnings.some((warning) => warning.includes("authority"))).toBe(true);
  });

  it("warns on mixed UTC offsets without failing listing or existence", () => {
    const singlePath = join(root, "single-offset.db");
    const single = new DatabaseSync(singlePath);
    single.exec(`
      PRAGMA user_version = 3;
      CREATE TABLE conversation_summaries (
        conversation_id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '',
        last_modified_time datetime NOT NULL, workspace_uris TEXT NOT NULL,
        nesting_depth INTEGER NOT NULL DEFAULT 0, killed numeric NOT NULL DEFAULT false
      );
    `);
    single.prepare(`
      INSERT INTO conversation_summaries
        (conversation_id, title, last_modified_time, workspace_uris, nesting_depth, killed)
      VALUES (?, '', '2026-09-26 10:00:00.000000000+00:00', ?, 0, 0)
    `).run("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", uris(cwd));
    single.close();
    const singleWarnings: string[] = [];
    expect(listAntigravitySessionsFrom(singlePath, cwd, { warn: (warning) => singleWarnings.push(warning) })).toHaveLength(1);
    expect(singleWarnings).toEqual([]);

    const mixedPath = join(root, "mixed.db");
    const mixed = new DatabaseSync(mixedPath);
    mixed.exec(`
      PRAGMA user_version = 3;
      CREATE TABLE conversation_summaries (
        conversation_id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '',
        last_modified_time datetime NOT NULL, workspace_uris TEXT NOT NULL,
        nesting_depth INTEGER NOT NULL DEFAULT 0, killed numeric NOT NULL DEFAULT false
      );
    `);
    const idA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const idB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const mixedInsert = mixed.prepare(`
      INSERT INTO conversation_summaries
        (conversation_id, title, last_modified_time, workspace_uris, nesting_depth, killed)
      VALUES (?, '', ?, ?, 0, 0)
    `);
    mixedInsert.run(idA, "2026-09-26 10:00:00.000000000+00:00", uris(cwd));
    mixedInsert.run(idB, "2026-09-26 11:00:00.000000000+01:00", uris(cwd));
    mixed.close();
    const warnings: string[] = [];
    expect(listAntigravitySessionsFrom(mixedPath, cwd, { warn: (warning) => warnings.push(warning) })).toHaveLength(2);
    expect(warnings).toEqual([expect.stringContaining("mixed UTC offsets; picker order may be wrong")]);
    expect(antigravitySessionExistsIn(mixedPath, cwd, idA)).toBe(true);

    const noMatchWarnings: string[] = [];
    expect(listAntigravitySessionsFrom(mixedPath, otherCwd, { warn: (warning) => noMatchWarnings.push(warning) })).toEqual([]);
    expect(noMatchWarnings).toEqual([expect.stringContaining("mixed UTC offsets; picker order may be wrong")]);
  });

  it("rejects unsupported runtimes and unavailable SQLite only for Antigravity", async () => {
    const warnings: string[] = [];
    let loaderCalls = 0;
    const options = {
      nodeVersion: "22.15.0",
      loadSqlite: () => { loaderCalls += 1; throw new Error("unavailable"); },
      warn: (warning: string) => warnings.push(warning),
    };
    expect(listAntigravitySessionsFrom(dbPath, `${cwd}-unsupported`, options)).toEqual([]);
    expect(antigravitySessionExistsIn(dbPath, `${cwd}-unsupported`, ids.newer, options)).toBe(false);
    expect(loaderCalls).toBe(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("unsupported_runtime");
    expect(listSessions(cwd, "claude-code")).toBeDefined();
    expect(sessionExistsIn(join(root, "claude"), ids.newer)).toBe(false);
    await expect(listCodexSessionsIn(join(root, "codex"), cwd)).resolves.toEqual([]);
    await expect(codexSessionExistsIn(join(root, "codex"), cwd, ids.newer)).resolves.toBe(false);
  });

  it("fails closed and rate limits a loader failure", () => {
    const warnings: string[] = [];
    const options = {
      nodeVersion: "24.3.0",
      loadSqlite: () => { throw new Error("injected missing module"); },
      warn: (warning: string) => warnings.push(warning),
    };
    const failureCwd = `${cwd}-missing-module`;
    expect(listAntigravitySessionsFrom(dbPath, failureCwd, options)).toEqual([]);
    expect(listAntigravitySessionsFrom(dbPath, failureCwd, options)).toEqual([]);
    expect(antigravitySessionExistsIn(dbPath, failureCwd, ids.newer, options)).toBe(false);
    expect(warnings).toHaveLength(1);
  });

  it("fails closed for schema mismatch with observed version and missing columns", () => {
    const mismatchPath = join(root, "mismatch.db");
    const mismatch = new DatabaseSync(mismatchPath);
    mismatch.exec("PRAGMA user_version = 2; CREATE TABLE conversation_summaries (conversation_id TEXT);");
    mismatch.close();
    const warnings: string[] = [];
    expect(listAntigravitySessionsFrom(mismatchPath, `${cwd}-schema`, { warn: (warning) => warnings.push(warning) })).toEqual([]);
    expect(warnings[0]).toContain("user_version=2");
    expect(warnings[0]).toContain("missing columns=");
    expect(warnings[0]).toContain("nesting_depth");
  });

  it("the default database path does not create a missing database", () => {
    const previousHome = process.env.HOME;
    const home = join(root, "empty-home");
    mkdirSync(home);
    process.env.HOME = home;
    try {
      expect(listSessions(cwd, "antigravity")).toEqual([]);
      expect(sessionExistsIn(join(root, "empty-claude"), ids.newer)).toBe(false);
      expect(existsSync(join(home, ".gemini", "antigravity-cli", "conversation_summaries.db"))).toBe(false);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });

  it("dispatches Antigravity list and existence calls to the measured index", async () => {
    const previousHome = process.env.HOME;
    const home = join(root, "dispatch-home");
    const defaultDirectory = join(home, ".gemini", "antigravity-cli");
    mkdirSync(defaultDirectory, { recursive: true });
    copyFileSync(dbPath, join(defaultDirectory, "conversation_summaries.db"));
    process.env.HOME = home;
    try {
      const sessions = await Promise.resolve(listSessions(cwd, "antigravity"));
      expect(sessions.map((session) => session.session_id)).toContain(ids.newer);
      await expect(Promise.resolve(sessionExists(cwd, ids.newer, "antigravity"))).resolves.toBe(true);
      await expect(Promise.resolve(sessionExists(cwd, ids.other, "antigravity"))).resolves.toBe(false);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });

  it("opens copied-file fixtures read-only and closes connections without changing the database", () => {
    const before = readFileSync(dbPath);
    expect(listAntigravitySessionsFrom(dbPath, cwd)).not.toEqual([]);
    expect(readFileSync(dbPath)).toEqual(before);
    const readonly = new DatabaseSync(dbPath, { readOnly: true, timeout: 100 });
    expect(() => readonly.exec("UPDATE conversation_summaries SET title = 'changed'")).toThrow();
    readonly.close();
  });

  it("waits only for the configured timeout on an exclusive lock, then fails closed", () => {
    const lockPath = join(root, "locked.db");
    const initialize = new DatabaseSync(lockPath);
    initialize.exec(`
      PRAGMA user_version = 3;
      CREATE TABLE conversation_summaries (
        conversation_id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '',
        last_modified_time datetime NOT NULL, workspace_uris TEXT NOT NULL,
        nesting_depth INTEGER NOT NULL DEFAULT 0, killed numeric NOT NULL DEFAULT false
      );
    `);
    initialize.close();
    const lock = new DatabaseSync(lockPath);
    lock.exec("BEGIN EXCLUSIVE");
    const warnings: string[] = [];
    const started = performance.now();
    try {
      expect(listAntigravitySessionsFrom(lockPath, `${cwd}-locked`, { warn: (warning) => warnings.push(warning) })).toEqual([]);
      expect(performance.now() - started).toBeGreaterThanOrEqual(70);
      expect(performance.now() - started).toBeLessThan(1000);
      expect(warnings).toHaveLength(1);
    } finally {
      lock.exec("ROLLBACK");
      lock.close();
    }
  });

  it("reads a sidecar-free WAL database read-only and leaves it writable afterward", () => {
    const walPath = join(root, "sidecar-free.db");
    const initial = new DatabaseSync(walPath);
    initial.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA user_version = 3;
      CREATE TABLE conversation_summaries (
        conversation_id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '',
        last_modified_time datetime NOT NULL, workspace_uris TEXT NOT NULL,
        nesting_depth INTEGER NOT NULL DEFAULT 0, killed numeric NOT NULL DEFAULT false
      );
    `);
    initial.prepare(`
      INSERT INTO conversation_summaries
        (conversation_id, title, last_modified_time, workspace_uris, nesting_depth, killed)
      VALUES (?, 'wal row', '2026-09-26 10:00:00.000000000+00:00', ?, 0, 0)
    `).run("cccccccc-cccc-4ccc-8ccc-cccccccccccc", uris(cwd));
    initial.close();
    expect(existsSync(`${walPath}-wal`)).toBe(false);
    expect(existsSync(`${walPath}-shm`)).toBe(false);
    const before = createHash("sha256").update(readFileSync(walPath)).digest("hex");
    expect(listAntigravitySessionsFrom(walPath, cwd)).toHaveLength(1);
    const after = createHash("sha256").update(readFileSync(walPath)).digest("hex");
    expect(after).toBe(before);
    expect(existsSync(`${walPath}-wal`)).toBe(true);
    expect(existsSync(`${walPath}-shm`)).toBe(true);
    const writer = new DatabaseSync(walPath);
    writer.prepare(`
      INSERT INTO conversation_summaries
        (conversation_id, title, last_modified_time, workspace_uris, nesting_depth, killed)
      VALUES (?, 'writer row', '2026-09-26 11:00:00.000000000+00:00', ?, 0, 0)
    `).run("dddddddd-dddd-4ddd-8ddd-dddddddddddd", uris(cwd));
    expect(writer.prepare("SELECT COUNT(*) AS count FROM conversation_summaries").get()).toMatchObject({ count: 2 });
    writer.close();
    rmSync(`${walPath}-wal`, { force: true });
    rmSync(`${walPath}-shm`, { force: true });
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
      {
        type: "user",
        message: { role: "user", content: "ユーザの最初の指示" },
      },
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
      {
        type: "user",
        isMeta: true,
        message: { role: "user", content: "<reminder>" },
      },
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
    jsonl([
      { type: "user", message: { role: "user", content: "あ".repeat(200) } },
    ]),
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

  it("listCodexSessionsIn は session_meta.cwd の一致分のみ返す", async () => {
    const sessions = await listCodexSessionsIn(root, "/repo/a");
    expect(sessions.map((s) => s.session_id)).toEqual([uuid]);
    expect(sessions[0]?.mtime).toBeDefined();
  });

  it("codexSessionExistsIn は cwd 一致の T3 チェックを行う", async () => {
    await expect(codexSessionExistsIn(root, "/repo/a", uuid)).resolves.toBe(
      true,
    );
    await expect(codexSessionExistsIn(root, "/repo/b", uuid)).resolves.toBe(
      false,
    );
    await expect(codexSessionExistsIn(root, "/repo/a", "../etc")).resolves.toBe(
      false,
    );
    await expect(codexSessionExistsIn(root, "/repo/a", other)).resolves.toBe(
      false,
    );
  });

  it("root 不在は空を返す", async () => {
    await expect(
      listCodexSessionsIn(join(root, "nope"), "/repo/a"),
    ).resolves.toEqual([]);
  });
});

describe("codex rollouts — 同一 session_id が複数 rollout に分散 (#101)", () => {
  // resume で新規 rollout が作られると同一 UUID が別日 dir に並ぶ。走査順で
  // 先頭が cwd 不一致だと codexSessionExistsIn が list 側と非対称に false
  // 決着していた回帰を固定する。
  const root = mkdtempSync(join(tmpdir(), "kaoiro-codex-104-test-"));
  const dayOld = join(root, "2026", "07", "10");
  const dayNew = join(root, "2026", "07", "12");
  mkdirSync(dayOld, { recursive: true });
  mkdirSync(dayNew, { recursive: true });
  const uuid = "019f4bdb-d821-7631-aee1-ec7982060311";
  const meta = (cwd: string, id = uuid): string =>
    `${JSON.stringify({
      timestamp: "2026-07-12T00:00:00.000Z",
      type: "session_meta",
      payload: { id, cwd },
    })}\n`;
  writeFileSync(
    join(dayOld, `rollout-2026-07-10T20-48-46-${uuid}.jsonl`),
    meta("/repo/a"),
  );
  writeFileSync(
    join(dayNew, `rollout-2026-07-12T09-00-00-${uuid}.jsonl`),
    meta("/repo/other"),
  );
  const newestUuid = "019f4bdb-d821-7631-aee1-ec7982060444";
  writeFileSync(
    join(dayNew, `rollout-2026-07-12T10-00-00-${newestUuid}.jsonl`),
    meta("/repo/a", newestUuid),
  );

  it("codexSessionExistsIn は先頭 rollout の cwd 不一致で打切らず一致を見つける", async () => {
    await expect(codexSessionExistsIn(root, "/repo/a", uuid)).resolves.toBe(
      true,
    );
  });

  it("listCodexSessionsIn と対称: 同 UUID の cwd 一致 rollout を反映する", async () => {
    const sessions = await listCodexSessionsIn(root, "/repo/a");
    expect(sessions.some((s) => s.session_id === uuid)).toBe(true);
  });

  it("date tree を新しい rollout から列挙する", async () => {
    const sessions = await listCodexSessionsIn(root, "/repo/a");
    expect(sessions.map((session) => session.session_id)).toEqual([
      newestUuid,
      uuid,
    ]);
  });
});
