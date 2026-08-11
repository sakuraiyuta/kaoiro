import { describe, expect, it } from "vitest";
import type {
  RunnerSessions,
  SessionMeta,
  SessionResetResult,
  SpawnResult,
  WrapperConfig,
} from "@kaoiro/protocol";
import {
  MAX_RESTARTS,
  RESTART_WINDOW_MS,
  Supervisor,
  isCwdAllowed,
  parseSpawn,
  readAgentId,
  resolveWrapperConfig,
} from "../src/supervisor.js";
import type { ManagedChild } from "../src/supervisor.js";

const spawnMsg = {
  version: "0",
  agent_id: "lab-pc-1.claude-a",
  persona: { id: "mio", name: "澪", sprite_set: "mio" },
  cwd: "/home/user/git/kaoiro",
  server_url: "ws://localhost:4000/wrapper",
  token: "tok",
};

const allowlist = ["/home/user/git/kaoiro"];

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A fake child whose exit can be driven and whose kills are counted. */
class FakeChild implements ManagedChild {
  readonly #listeners: Array<() => void> = [];
  kills = 0;
  on(_event: "exit", listener: () => void): void {
    this.#listeners.push(listener);
  }
  kill(): void {
    this.kills += 1;
  }
  exit(): void {
    for (const listener of [...this.#listeners]) listener();
  }
}

function harness(
  opts: {
    cwdAllowlist?: string[];
    sessions?: SessionMeta[] | Promise<SessionMeta[]>;
    exists?: boolean | Promise<boolean>;
    wrapperServerUrl?: string;
    now?: () => number;
    launchThrowsOnCall?: number;
    getClaudeEngineCatalog?: () =>
      | WrapperConfig["claude_engine_catalog"]
      | null
      | undefined;
  } = {},
) {
  const children: FakeChild[] = [];
  const results: SpawnResult[] = [];
  const resetResults: SessionResetResult[] = [];
  const configs: WrapperConfig[] = [];
  const resumes: Array<string | undefined> = [];
  const prompts: Array<string | undefined> = [];
  const sessionsSent: RunnerSessions[] = [];
  let launchCall = 0;
  const sup = new Supervisor({
    hostId: "lab-pc-1",
    cwdAllowlist: opts.cwdAllowlist ?? allowlist,
    wrapperServerUrl: opts.wrapperServerUrl ?? "ws://localhost:4000/wrapper",
    launch: (_agentId, config, _cwd, resumeSessionId, initialPrompt) => {
      launchCall += 1;
      if (opts.launchThrowsOnCall === launchCall) {
        throw new Error(`launch failed on call ${launchCall}`);
      }
      configs.push(config);
      resumes.push(resumeSessionId);
      prompts.push(initialPrompt);
      const child = new FakeChild();
      children.push(child);
      return child;
    },
    sendResult: (r) => results.push(r),
    sendSessions: (s) => sessionsSent.push(s),
    sendResetResult: (r) => resetResults.push(r),
    listSessions: () => opts.sessions ?? [],
    sessionExists: () => opts.exists ?? false,
    ...(opts.getClaudeEngineCatalog === undefined
      ? {}
      : { getClaudeEngineCatalog: opts.getClaudeEngineCatalog }),
    ...(opts.now === undefined ? {} : { now: opts.now }),
  });
  return {
    sup,
    children,
    results,
    resetResults,
    configs,
    resumes,
    prompts,
    sessionsSent,
    last: () => children[children.length - 1]!,
  };
}

describe("readAgentId", () => {
  it("有効な agent_id を返す", () => {
    expect(readAgentId(spawnMsg)).toBe("lab-pc-1.claude-a");
  });
  it("path 区切りを含む agent_id は弾く(temp ファイル名の安全性)", () => {
    expect(readAgentId({ agent_id: "../evil" })).toBeNull();
  });
  it("agent_id 欠落は null", () => {
    expect(readAgentId({})).toBeNull();
  });
});

describe("parseSpawn / resolveWrapperConfig", () => {
  it("有効な spawn を解釈する", () => {
    expect(parseSpawn(spawnMsg)).toEqual({
      persona: spawnMsg.persona,
      cwd: spawnMsg.cwd,
      engine: "claude-code",
      serverUrl: spawnMsg.server_url,
      token: "tok",
    });
  });
  it("persona 欠落は null", () => {
    const { persona: _omit, ...rest } = spawnMsg;
    void _omit;
    expect(parseSpawn(rest)).toBeNull();
  });
  it("wrapper config に server_token を載せ allowed_tools は載せない", () => {
    const parsed = parseSpawn(spawnMsg)!;
    const config = resolveWrapperConfig(
      "lab-pc-1.claude-a",
      parsed,
      "ws://localhost:4000/wrapper",
    );
    expect(config).toEqual({
      agent_id: "lab-pc-1.claude-a",
      persona: spawnMsg.persona,
      // spawnMsg omits display_name (legacy-server fixture) — falls back
      // to persona.name (issue #219 MF-1 migration fallback).
      display_name: spawnMsg.persona.name,
      server_url: spawnMsg.server_url,
      server_token: "tok",
    });
    expect("allowed_tools" in config).toBe(false);
  });

  // issue #219 MF-1: display_name was dropped between server and wrapper —
  // SpawnMessage/ParsedSpawn/parseSpawn/resolveWrapperConfig now carry it
  // through, with a one-time migration fallback for a legacy server that
  // predates the field.
  describe("display_name (issue #219 MF-1)", () => {
    it("spawn の display_name を parseSpawn / resolveWrapperConfig で貫通する", () => {
      const parsed = parseSpawn({
        ...spawnMsg,
        display_name: "澪(改名後)",
      })!;
      expect(parsed.displayName).toBe("澪(改名後)");
      const config = resolveWrapperConfig(
        "lab-pc-1.claude-a",
        parsed,
        "ws://localhost:4000/wrapper",
      );
      // 意図的に canonical persona.name ("澪") と異なる値にした食い違い
      // fixture (issue #219 D27方針) — display_name を persona.name に
      // つぶす conflation バグを検出できる。
      expect(config.display_name).toBe("澪(改名後)");
      expect(config.persona.name).toBe("澪");
    });

    it("display_name 省略 (旧 server) は persona.name へフォールバックする", () => {
      const parsed = parseSpawn(spawnMsg)!;
      expect(parsed.displayName).toBeUndefined();
      const config = resolveWrapperConfig(
        "lab-pc-1.claude-a",
        parsed,
        "ws://localhost:4000/wrapper",
      );
      expect(config.display_name).toBe(spawnMsg.persona.name);
    });

    it("display_name が非 string なら parseSpawn 全体を fail-loud reject する", () => {
      expect(parseSpawn({ ...spawnMsg, display_name: 42 })).toBeNull();
      expect(parseSpawn({ ...spawnMsg, display_name: null })).toBeNull();
    });
  });
  it("Codex auth contextをwrapper configへ載せる", () => {
    const parsed = parseSpawn({ ...spawnMsg, engine: "codex" })!;
    const config = resolveWrapperConfig(
      "lab-pc-1.codex-a",
      parsed,
      "ws://localhost:4000/wrapper",
      "chatgpt",
      "plus",
    );
    expect(config).toMatchObject({
      codex_auth_mode: "chatgpt",
      codex_chatgpt_plan: "plus",
    });
  });
  it("server_url 省略を許す(案A: runner が補完)", () => {
    const { server_url: _omit, ...rest } = spawnMsg;
    void _omit;
    const parsed = parseSpawn(rest)!;
    expect(parsed.serverUrl).toBeUndefined();
  });
  it("server_url 省略時は fallback を wrapper config に載せる", () => {
    const { server_url: _omit, ...rest } = spawnMsg;
    void _omit;
    const parsed = parseSpawn(rest)!;
    const config = resolveWrapperConfig(
      "lab-pc-1.claude-a",
      parsed,
      "ws://localhost:4000/wrapper",
    );
    expect(config.server_url).toBe("ws://localhost:4000/wrapper");
  });
  it("spawn の server_url は fallback より優先する", () => {
    const parsed = parseSpawn(spawnMsg)!;
    const config = resolveWrapperConfig(
      "lab-pc-1.claude-a",
      parsed,
      "ws://other/wrapper",
    );
    expect(config.server_url).toBe(spawnMsg.server_url);
  });
  it("initial_prompt を解釈する", () => {
    const parsed = parseSpawn({ ...spawnMsg, initial_prompt: "やあ" })!;
    expect(parsed.initialPrompt).toBe("やあ");
  });
  it("permission_mode の有効値は ParsedSpawn に載せる (phase-15 15-12)", () => {
    const parsed = parseSpawn({ ...spawnMsg, permission_mode: "plan" })!;
    expect(parsed.permissionMode).toBe("plan");
  });
  it("未知 permission_mode は parseSpawn が null (fail-loud)", () => {
    expect(parseSpawn({ ...spawnMsg, permission_mode: "yolo" })).toBeNull();
  });
  it("permission_mode は wrapper config へ passthrough (phase-15 15-12)", () => {
    const parsed = parseSpawn({ ...spawnMsg, permission_mode: "acceptEdits" })!;
    const config = resolveWrapperConfig(
      "lab-pc-1.claude-a",
      parsed,
      "ws://localhost:4000/wrapper",
    );
    expect(config.permission_mode).toBe("acceptEdits");
  });
  it("permission_mode 未指定なら wrapper config に field なし", () => {
    const parsed = parseSpawn(spawnMsg)!;
    const config = resolveWrapperConfig(
      "lab-pc-1.claude-a",
      parsed,
      "ws://localhost:4000/wrapper",
    );
    expect("permission_mode" in config).toBe(false);
  });

  // ADR-0014 F1 追補 (resume-privilege-restoration 藤 D2 read-side):
  // parseSpawn の sanitize が unknown / malformed field を drop する。
  it("resume_snapshot は sanitize され unknown / malformed field は drop される", () => {
    const parsed = parseSpawn({
      ...spawnMsg,
      resume_snapshot: {
        sandbox: "danger-full-access",
        network_access: true,
        permission_mode: "bypassPermissions",
        // 以下は drop されるべき
        foo: "bar",
        model: "",
      },
    })!;
    expect(parsed.resumeSnapshot).toEqual({
      sandbox: "danger-full-access",
      network_access: true,
      permission_mode: "bypassPermissions",
    });
  });

  it("resume_snapshot が非 object shape なら parseSpawn 全体を fail-loud reject", () => {
    expect(
      parseSpawn({ ...spawnMsg, resume_snapshot: "not-a-map" }),
    ).toBeNull();
    expect(parseSpawn({ ...spawnMsg, resume_snapshot: [1, 2] })).toBeNull();
  });
});

describe("isCwdAllowed", () => {
  it("許可リスト内のみ true", () => {
    expect(isCwdAllowed("/home/user/git/kaoiro", allowlist)).toBe(true);
    expect(isCwdAllowed("/etc", allowlist)).toBe(false);
  });
});

describe("Supervisor.handleSpawn", () => {
  it("正常 spawn で 1 つ起動し ok を返す", () => {
    const h = harness();
    h.sup.handleSpawn(spawnMsg);
    expect(h.children).toHaveLength(1);
    expect(h.results).toEqual([
      {
        version: "0",
        host_id: "lab-pc-1",
        agent_id: spawnMsg.agent_id,
        ok: true,
      },
    ]);
  });

  it("許可外 cwd は cwd_not_found で拒否し起動しない", () => {
    const h = harness();
    h.sup.handleSpawn({ ...spawnMsg, cwd: "/etc" });
    expect(h.children).toHaveLength(0);
    expect(h.results[0]).toMatchObject({ ok: false, reason: "cwd_not_found" });
  });

  it("二重 spawn は already_running で拒否", () => {
    const h = harness();
    h.sup.handleSpawn(spawnMsg);
    h.sup.handleSpawn(spawnMsg);
    expect(h.children).toHaveLength(1);
    expect(h.results[1]).toMatchObject({
      ok: false,
      reason: "already_running",
    });
  });

  it("initial_prompt を launch へ渡す", () => {
    const h = harness();
    h.sup.handleSpawn({ ...spawnMsg, initial_prompt: "最初の指示" });
    expect(h.prompts[0]).toBe("最初の指示");
  });

  it("server_url 省略時は wrapperServerUrl fallback で起動する", () => {
    const { server_url: _omit, ...rest } = spawnMsg;
    void _omit;
    const h = harness({ wrapperServerUrl: "ws://localhost:4000/wrapper" });
    h.sup.handleSpawn(rest);
    expect(h.configs[0]!.server_url).toBe("ws://localhost:4000/wrapper");
  });

  it("同期 launch 失敗を error で報告し slot を残さない", () => {
    const results: SpawnResult[] = [];
    let calls = 0;
    const sup = new Supervisor({
      hostId: "lab-pc-1",
      cwdAllowlist: allowlist,
      wrapperServerUrl: "ws://localhost:4000/wrapper",
      launch: () => {
        calls += 1;
        throw new Error("boom");
      },
      sendResult: (r) => results.push(r),
      sendSessions: () => {},
      sendResetResult: () => {},
    });
    sup.handleSpawn(spawnMsg);
    expect(results[0]).toMatchObject({ ok: false, reason: "error" });
    // slot は残らないので再 spawn でき(already_running にならず)再度起動を試みる
    sup.handleSpawn(spawnMsg);
    expect(calls).toBe(2);
    expect(results[1]).toMatchObject({ ok: false, reason: "error" });
  });
});

describe("Supervisor resume (T3 / F4)", () => {
  const resumeMsg = {
    ...spawnMsg,
    resume_session_id: "11111111-2222-3333-4444-555555555555",
  };

  it("存在する session は起動し --resume を渡す", () => {
    const h = harness({ exists: true });
    h.sup.handleSpawn(resumeMsg);
    expect(h.children).toHaveLength(1);
    expect(h.resumes[0]).toBe(resumeMsg.resume_session_id);
    expect(h.results[0]).toMatchObject({ ok: true });
  });

  it("存在しない session(T3 失敗)は session_not_found で拒否", () => {
    const h = harness({ exists: false });
    h.sup.handleSpawn(resumeMsg);
    expect(h.children).toHaveLength(0);
    expect(h.results[0]).toMatchObject({
      ok: false,
      reason: "session_not_found",
    });
  });

  it("Codex の async T3 中は event handler を返し、完了後に起動する (#100)", async () => {
    const check = deferred<boolean>();
    const h = harness({ exists: check.promise });

    h.sup.handleSpawn({ ...resumeMsg, engine: "codex" });
    expect(h.children).toHaveLength(0);
    expect(h.results).toHaveLength(0);

    check.resolve(true);
    await check.promise;
    await Promise.resolve();

    expect(h.children).toHaveLength(1);
    expect(h.results[0]).toMatchObject({ ok: true });
  });

  it("async T3 中の同一 agent 二重 spawn は pending slot で拒否", async () => {
    const check = deferred<boolean>();
    const h = harness({ exists: check.promise });
    const codexResume = { ...resumeMsg, engine: "codex" };

    h.sup.handleSpawn(codexResume);
    h.sup.handleSpawn(codexResume);
    expect(h.results[0]).toMatchObject({
      ok: false,
      reason: "already_running",
    });

    check.resolve(true);
    await check.promise;
    await Promise.resolve();
    expect(h.children).toHaveLength(1);
    expect(h.results[1]).toMatchObject({ ok: true });
  });

  it("並行 async T3 後も同一 session の F4 lock は一方だけが獲得する", async () => {
    const check = deferred<boolean>();
    const h = harness({ exists: check.promise });
    const codexResume = { ...resumeMsg, engine: "codex" };

    h.sup.handleSpawn({ ...codexResume, agent_id: "lab-pc-1.codex-a" });
    h.sup.handleSpawn({ ...codexResume, agent_id: "lab-pc-1.codex-b" });
    check.resolve(true);
    await check.promise;
    await Promise.resolve();

    expect(h.children).toHaveLength(1);
    expect(h.results).toHaveLength(2);
    expect(h.results.filter((result) => result.ok)).toHaveLength(1);
    expect(h.results.find((result) => !result.ok)).toMatchObject({
      reason: "already_running",
    });
  });

  it("async T3 中の stop は pending spawn を取り消す", async () => {
    const check = deferred<boolean>();
    const h = harness({ exists: check.promise });
    const codexResume = { ...resumeMsg, engine: "codex" };

    h.sup.handleSpawn(codexResume);
    h.sup.handleStop(codexResume);
    check.resolve(true);
    await check.promise;
    await Promise.resolve();

    expect(h.children).toHaveLength(0);
    expect(h.results[0]).toMatchObject({ ok: false, reason: "error" });
  });

  it("同一 session の同時 resume は already_running(F4 ロック)", () => {
    const h = harness({ exists: true });
    h.sup.handleSpawn({ ...resumeMsg, agent_id: "lab-pc-1.claude-a" });
    h.sup.handleSpawn({ ...resumeMsg, agent_id: "lab-pc-1.claude-b" });
    expect(h.children).toHaveLength(1);
    expect(h.results[1]).toMatchObject({
      ok: false,
      reason: "already_running",
    });
  });

  it("stop でロックが解放され同一 session を再 resume できる", () => {
    const h = harness({ exists: true });
    h.sup.handleSpawn(resumeMsg);
    h.sup.handleStop(resumeMsg);
    h.last().exit();
    h.sup.handleSpawn(resumeMsg);
    expect(h.children).toHaveLength(2);
    expect(h.results[1]).toMatchObject({ ok: true });
  });

  it("relaunch の同期失敗でプロセスを落とさずロックを解放する", () => {
    const results: SpawnResult[] = [];
    const children: FakeChild[] = [];
    let calls = 0;
    const sup = new Supervisor({
      hostId: "lab-pc-1",
      cwdAllowlist: allowlist,
      wrapperServerUrl: "ws://localhost:4000/wrapper",
      launch: () => {
        calls += 1;
        if (calls === 1) {
          const child = new FakeChild();
          children.push(child);
          return child;
        }
        throw new Error("relaunch boom");
      },
      sendResult: (r) => results.push(r),
      sendSessions: () => {},
      sendResetResult: () => {},
      sessionExists: () => true,
    });
    sup.handleSpawn(resumeMsg); // ok, lock held
    children[0]!.exit(); // crash -> #relaunch throws (caught) -> lock released
    // ロック解放済みなので再 resume は already_running にならず launch を試みる
    sup.handleSpawn(resumeMsg);
    expect(calls).toBe(3); // 初回 + relaunch 試行 + 再 spawn 試行
    expect(results[results.length - 1]).toMatchObject({
      ok: false,
      reason: "error",
    });
  });
});

describe("Supervisor.handleEnumerate", () => {
  it("許可 cwd の resume 候補を sessions で返す", () => {
    const sessions: SessionMeta[] = [
      { session_id: "s1", mtime: "2026-06-24T00:00:00Z" },
    ];
    const h = harness({ sessions });
    h.sup.handleEnumerate({
      version: "0",
      agent_id: "a",
      cwd: "/home/user/git/kaoiro",
    });
    expect(h.sessionsSent).toEqual([
      {
        version: "0",
        host_id: "lab-pc-1",
        cwd: "/home/user/git/kaoiro",
        sessions,
        engine: "claude-code",
      },
    ]);
  });

  it("許可外 cwd は空 sessions(任意パスを探らせない)", () => {
    const h = harness({ sessions: [{ session_id: "s1" }] });
    h.sup.handleEnumerate({ version: "0", agent_id: "a", cwd: "/etc" });
    expect(h.sessionsSent[0]).toMatchObject({ cwd: "/etc", sessions: [] });
  });

  it("Codex の async 列挙は完了後に sessions を送る (#100)", async () => {
    const listing = deferred<SessionMeta[]>();
    const h = harness({ sessions: listing.promise });

    h.sup.handleEnumerate({
      version: "0",
      cwd: "/home/user/git/kaoiro",
      engine: "codex",
    });
    expect(h.sessionsSent).toHaveLength(0);

    const sessions = [{ session_id: "codex-session" }];
    listing.resolve(sessions);
    await listing.promise;
    await Promise.resolve();

    expect(h.sessionsSent[0]).toMatchObject({
      engine: "codex",
      sessions,
    });
  });

  it("後発 enumerate の結果を、遅れて完了した旧 scan で上書きしない", async () => {
    const first = deferred<SessionMeta[]>();
    let listing: SessionMeta[] | Promise<SessionMeta[]> = first.promise;
    const sent: RunnerSessions[] = [];
    const sup = new Supervisor({
      hostId: "lab-pc-1",
      cwdAllowlist: allowlist,
      wrapperServerUrl: "ws://localhost:4000/wrapper",
      launch: () => new FakeChild(),
      sendResult: () => {},
      sendSessions: (sessions) => sent.push(sessions),
      sendResetResult: () => {},
      listSessions: () => listing,
    });
    sup.handleEnumerate({ cwd: "/home/user/git/kaoiro", engine: "codex" });
    listing = [{ session_id: "newer" }];
    sup.handleEnumerate({ cwd: "/home/user/git/kaoiro", engine: "codex" });

    first.resolve([{ session_id: "stale" }]);
    await first.promise;
    await Promise.resolve();

    expect(sent).toHaveLength(1);
    expect(sent[0]?.sessions).toEqual([{ session_id: "newer" }]);
  });
});

describe("Supervisor restart/stop", () => {
  it("クラッシュ時は再起動する", () => {
    const h = harness();
    h.sup.handleSpawn(spawnMsg);
    h.last().exit();
    expect(h.children).toHaveLength(2);
  });

  it("stop はプロセスを kill し再起動しない", () => {
    const h = harness();
    h.sup.handleSpawn(spawnMsg);
    const child = h.last();
    h.sup.handleStop(spawnMsg);
    expect(child.kills).toBe(1);
    child.exit();
    expect(h.children).toHaveLength(1);
  });

  it("restart は kill して再起動する", () => {
    const h = harness();
    h.sup.handleSpawn(spawnMsg);
    const child = h.last();
    h.sup.handleRestart(spawnMsg);
    expect(child.kills).toBe(1);
    child.exit();
    expect(h.children).toHaveLength(2);
  });

  it("クラッシュが上限を超えたら諦める", () => {
    const h = harness();
    h.sup.handleSpawn(spawnMsg);
    for (let i = 0; i <= MAX_RESTARTS; i += 1) h.last().exit();
    expect(h.children).toHaveLength(MAX_RESTARTS + 1);
    // 諦め後はエントリが消え、再度 spawn できる(already_running にならない)
    h.sup.handleSpawn(spawnMsg);
    expect(h.children).toHaveLength(MAX_RESTARTS + 2);
  });
});

describe("Supervisor 再起動 budget の時間窓 (#73)", () => {
  it("時間窓を超えて散発するクラッシュは budget を使い切らない", () => {
    let clock = 0;
    const h = harness({ now: () => clock });
    h.sup.handleSpawn(spawnMsg);
    for (let i = 0; i < MAX_RESTARTS * 2; i += 1) {
      clock += RESTART_WINDOW_MS + 1; // 各クラッシュは窓外 -> budget リセット
      h.last().exit();
    }
    // 上限を大きく超える回数でも毎回リセットされ、まだ再起動し続ける。
    expect(h.children).toHaveLength(MAX_RESTARTS * 2 + 1);
  });

  it("時間窓内の連続クラッシュは上限で諦める", () => {
    let clock = 0;
    const h = harness({ now: () => clock });
    h.sup.handleSpawn(spawnMsg);
    for (let i = 0; i <= MAX_RESTARTS; i += 1) {
      clock += 1; // 窓内
      h.last().exit();
    }
    expect(h.children).toHaveLength(MAX_RESTARTS + 1); // 上限で諦め
    // エントリは消えるので再 spawn は通る。
    h.sup.handleSpawn(spawnMsg);
    expect(h.children).toHaveLength(MAX_RESTARTS + 2);
  });

  it("明示 restart は budget をリセットし新たに MAX_RESTARTS 回まで許す", () => {
    let clock = 0;
    const h = harness({ now: () => clock });
    h.sup.handleSpawn(spawnMsg);
    // 窓内クラッシュで budget をほぼ使い切る。
    for (let i = 0; i < MAX_RESTARTS; i += 1) {
      clock += 1;
      h.last().exit();
    }
    // 明示 restart で restarts/windowStart をリセット。
    h.sup.handleRestart(spawnMsg);
    h.last().exit(); // restart サイクルの relaunch
    const base = h.children.length;
    // budget が新品なら、窓内クラッシュ MAX_RESTARTS 回は全て再起動される
    // (リセットされていなければ最初の 1 回で cap に達して諦める)。
    for (let i = 0; i < MAX_RESTARTS; i += 1) {
      clock += 1;
      h.last().exit();
    }
    expect(h.children.length).toBe(base + MAX_RESTARTS);
  });
});

describe("Supervisor.handleSwitchSession", () => {
  const resumeMsg = {
    ...spawnMsg,
    resume_session_id: "11111111-2222-3333-4444-555555555555",
  };
  const otherSession = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

  it("agent 未起動なら何もせず fail も返さない", () => {
    const h = harness({ exists: true });
    h.sup.handleSwitchSession({
      agent_id: "lab-pc-1.claude-a",
      resume_session_id: otherSession,
    });
    expect(h.children).toHaveLength(0);
    expect(h.results).toHaveLength(0);
  });

  it("稼働中の resume 先を差替え、kill → relaunch で新 session_id を渡す", () => {
    const h = harness({ exists: true });
    h.sup.handleSpawn(resumeMsg);
    const first = h.last();
    h.sup.handleSwitchSession({
      agent_id: resumeMsg.agent_id,
      resume_session_id: otherSession,
    });
    expect(first.kills).toBe(1);
    first.exit();
    expect(h.children).toHaveLength(2);
    expect(h.resumes[1]).toBe(otherSession);
  });

  it("Codex の async T3 完了までは live child を止めず、成功後に切替える (#100)", async () => {
    let exists: boolean | Promise<boolean> = true;
    const children: FakeChild[] = [];
    const sup = new Supervisor({
      hostId: "lab-pc-1",
      cwdAllowlist: allowlist,
      wrapperServerUrl: "ws://localhost:4000/wrapper",
      launch: () => {
        const child = new FakeChild();
        children.push(child);
        return child;
      },
      sendResult: () => {},
      sendSessions: () => {},
      sendResetResult: () => {},
      sessionExists: () => exists,
    });
    sup.handleSpawn({ ...resumeMsg, engine: "codex" });
    const check = deferred<boolean>();
    exists = check.promise;

    sup.handleSwitchSession({
      agent_id: resumeMsg.agent_id,
      resume_session_id: otherSession,
    });
    expect(children[0]!.kills).toBe(0);

    check.resolve(true);
    await check.promise;
    await Promise.resolve();
    expect(children[0]!.kills).toBe(1);
  });

  it("resume_session_id を欠くと error で拒否", () => {
    const h = harness({ exists: true });
    h.sup.handleSpawn(resumeMsg);
    h.sup.handleSwitchSession({ agent_id: resumeMsg.agent_id });
    expect(h.results[1]).toMatchObject({ ok: false, reason: "error" });
    expect(h.last().kills).toBe(0);
  });

  it("差替先の session が存在しなければ session_not_found (T3)", () => {
    let exists = true;
    const results: SpawnResult[] = [];
    const children: FakeChild[] = [];
    const sup = new Supervisor({
      hostId: "lab-pc-1",
      cwdAllowlist: allowlist,
      wrapperServerUrl: "ws://localhost:4000/wrapper",
      launch: () => {
        const child = new FakeChild();
        children.push(child);
        return child;
      },
      sendResult: (r) => results.push(r),
      sendSessions: () => {},
      sendResetResult: () => {},
      sessionExists: () => exists,
    });
    sup.handleSpawn(resumeMsg);
    exists = false;
    sup.handleSwitchSession({
      agent_id: resumeMsg.agent_id,
      resume_session_id: otherSession,
    });
    expect(results[1]).toMatchObject({
      ok: false,
      reason: "session_not_found",
    });
    expect(children[0]!.kills).toBe(0);
  });

  it("別 agent が既に resume 中の session への切替は already_running", () => {
    const h = harness({ exists: true });
    h.sup.handleSpawn({ ...resumeMsg, agent_id: "lab-pc-1.claude-a" });
    h.sup.handleSpawn({
      ...resumeMsg,
      agent_id: "lab-pc-1.claude-b",
      resume_session_id: otherSession,
    });
    h.sup.handleSwitchSession({
      agent_id: "lab-pc-1.claude-a",
      resume_session_id: otherSession,
    });
    expect(h.results[2]).toMatchObject({
      ok: false,
      reason: "already_running",
    });
    expect(h.children[0]!.kills).toBe(0);
  });

  it("切替後は古い session_id の F4 ロックが解放される", () => {
    const h = harness({ exists: true });
    h.sup.handleSpawn({ ...resumeMsg, agent_id: "lab-pc-1.claude-a" });
    h.sup.handleSwitchSession({
      agent_id: "lab-pc-1.claude-a",
      resume_session_id: otherSession,
    });
    h.children[0]!.exit();
    // 旧 session_id は解放されているので別 agent から resume できる
    h.sup.handleSpawn({
      ...resumeMsg,
      agent_id: "lab-pc-1.claude-c",
    });
    expect(h.results[h.results.length - 1]).toMatchObject({ ok: true });
  });
});

describe("Supervisor.handleResetSession (ADR-0036 F2, phase-17 17-5)", () => {
  const resetMsg = {
    agent_id: "lab-pc-1.claude-a",
    mode: "new",
    request_id: "rs_test123",
    previous_session_id: "sess-old-xyz",
  };

  it("正常 fresh relaunch: kill + fresh child spawn (resume なし) + ok=true / to_session_id=null 報告", () => {
    const h = harness();
    h.sup.handleSpawn(spawnMsg);
    // reset を受けて既存 child を kill、exit イベントで fresh 起動
    h.sup.handleResetSession(resetMsg);
    expect(h.children[0]!.kills).toBe(1);
    h.children[0]!.exit();

    // fresh child が起動された (2 個目、resumeSessionId は undefined)
    expect(h.children).toHaveLength(2);
    expect(h.resumes[1]).toBeUndefined();
    expect(h.prompts[1]).toBeUndefined();

    // sendResetResult は ok=true / to_session_id=null で送出済み
    expect(h.resetResults).toHaveLength(1);
    expect(h.resetResults[0]).toEqual({
      version: "0",
      host_id: "lab-pc-1",
      agent_id: "lab-pc-1.claude-a",
      mode: "new",
      request_id: "rs_test123",
      ok: true,
      to_session_id: null,
    });
  });

  it("fresh 経路は resumeSnapshot を保持して wrapper config へ passthrough する", () => {
    const h = harness();
    // spawn 時に resume_snapshot を載せる
    h.sup.handleSpawn({
      ...spawnMsg,
      resume_snapshot: {
        model: "claude-sonnet-x",
        permission_mode: "acceptEdits",
      },
    });
    h.sup.handleResetSession(resetMsg);
    h.children[0]!.exit();

    // fresh の wrapper config には resume_snapshot が残り、
    // resumeSessionId は undefined (fresh)
    const freshConfig = h.configs[1]!;
    expect(freshConfig.resume_snapshot).toEqual({
      model: "claude-sonnet-x",
      permission_mode: "acceptEdits",
    });
    expect(h.resumes[1]).toBeUndefined();
  });

  it("fresh spawn 失敗 → previous_session_id で rollback resume 成功: ok=false / reason=spawn_failed", () => {
    // 1 回目 launch = 初期 spawn 成功、2 回目 = fresh relaunch で throw、
    // 3 回目 = rollback resume 成功 (sessionExists=true で resume 通過)
    const h = harness({ launchThrowsOnCall: 2, exists: true });
    h.sup.handleSpawn(spawnMsg);
    h.sup.handleResetSession(resetMsg);
    h.children[0]!.exit();

    // rollback の launch (3 回目) が resumeSessionId=previous_session_id で発火
    expect(h.children).toHaveLength(2);
    expect(h.resumes[1]).toBe("sess-old-xyz");

    // sendResetResult は ok=false / spawn_failed
    expect(h.resetResults).toHaveLength(1);
    expect(h.resetResults[0]).toMatchObject({
      ok: false,
      reason: "spawn_failed",
      mode: "new",
      request_id: "rs_test123",
    });
  });

  it("previous_session_id なし + fresh spawn 失敗: 即 rollback_failed + entry drop", () => {
    const h = harness({ launchThrowsOnCall: 2 });
    h.sup.handleSpawn(spawnMsg);
    const { previous_session_id: _omit, ...noPrev } = resetMsg;
    void _omit;
    h.sup.handleResetSession(noPrev);
    h.children[0]!.exit();

    // fresh spawn throw → rollback_failed 経路 (previous_session_id 無し)
    expect(h.resetResults).toHaveLength(1);
    expect(h.resetResults[0]).toMatchObject({
      ok: false,
      reason: "rollback_failed",
    });
    // entry drop 済み → 再 spawn 可能
    h.sup.handleSpawn(spawnMsg);
    expect(h.results[h.results.length - 1]).toMatchObject({ ok: true });
  });

  it("未知 agent は silent drop", () => {
    const h = harness();
    h.sup.handleResetSession({
      agent_id: "lab-pc-1.unknown",
      mode: "new",
      request_id: "rs_x",
    });
    expect(h.resetResults).toHaveLength(0);
    expect(h.children).toHaveLength(0);
  });

  it("invalid mode は silent drop", () => {
    const h = harness();
    h.sup.handleSpawn(spawnMsg);
    h.sup.handleResetSession({ ...resetMsg, mode: "restart" });
    expect(h.children[0]!.kills).toBe(0);
    expect(h.resetResults).toHaveLength(0);
  });

  it("missing request_id は silent drop", () => {
    const h = harness();
    h.sup.handleSpawn(spawnMsg);
    const { request_id: _omit, ...noReq } = resetMsg;
    void _omit;
    h.sup.handleResetSession(noReq);
    expect(h.children[0]!.kills).toBe(0);
    expect(h.resetResults).toHaveLength(0);
  });

  it("clear mode でも fresh relaunch 経路は同じ (display projection は server 側)", () => {
    const h = harness();
    h.sup.handleSpawn(spawnMsg);
    h.sup.handleResetSession({ ...resetMsg, mode: "clear" });
    h.children[0]!.exit();

    expect(h.resetResults[0]!.mode).toBe("clear");
    expect(h.resumes[1]).toBeUndefined();
  });

  it("fresh 成功時に旧 resume session_id の F4 ロックが activeSessions から解放される", () => {
    // Review finding regression: fresh relaunch abandons the old
    // resume id. Without a delete from #activeSessions, the id stays
    // stuck forever and any future spawn / switch onto the same id
    // hits already_running (line 370 / 460 same-session lock).
    const otherAgentSession = "sess-old-xyz";
    const h = harness({ exists: true });
    // 1) resume-spawn locks the id.
    h.sup.handleSpawn({
      ...spawnMsg,
      resume_session_id: otherAgentSession,
    });
    // 2) reset from that resumed session (previous_session_id points
    //    to the same id — the SessionPointer would have recorded it).
    h.sup.handleResetSession({
      agent_id: spawnMsg.agent_id,
      mode: "new",
      request_id: "rs_lock_release",
      previous_session_id: otherAgentSession,
    });
    h.children[0]!.exit();
    expect(h.resetResults[0]).toMatchObject({ ok: true });
    // A different agent can now resume the same session_id — if the
    // F4 lock had leaked, this would fail with already_running.
    h.sup.handleSpawn({
      ...spawnMsg,
      agent_id: "lab-pc-1.claude-b",
      resume_session_id: otherAgentSession,
    });
    expect(h.results[h.results.length - 1]).toMatchObject({ ok: true });
  });

  it("rollback 成功時は rollbackSid の F4 ロックが activeSessions に取り直される", () => {
    // spawn 時 resume なし → oldResumeSessionId は undefined。fresh spawn
    // 失敗 → rollback で previous_session_id を resume。以後の別 agent が
    // 同 session_id へ resume しようとすると already_running で reject
    // されるべき (rollback 側で lock を取り直しているから)。
    const rollbackTarget = "sess-rollback-abc";
    const h = harness({ launchThrowsOnCall: 2, exists: true });
    h.sup.handleSpawn(spawnMsg); // no resume, no lock initially
    h.sup.handleResetSession({
      agent_id: spawnMsg.agent_id,
      mode: "new",
      request_id: "rs_rb",
      previous_session_id: rollbackTarget,
    });
    h.children[0]!.exit();
    expect(h.resetResults[0]).toMatchObject({
      ok: false,
      reason: "spawn_failed",
    });
    // A different agent trying to resume the rollback target now
    // should be blocked (rollback holds the F4 lock on it).
    h.sup.handleSpawn({
      ...spawnMsg,
      agent_id: "lab-pc-1.claude-c",
      resume_session_id: rollbackTarget,
    });
    expect(h.results[h.results.length - 1]).toMatchObject({
      ok: false,
      reason: "already_running",
    });
  });

  it("fresh 成功後の crash は通常 crash restart 経路 (pendingReset 未再入)", () => {
    const h = harness();
    h.sup.handleSpawn(spawnMsg);
    h.sup.handleResetSession(resetMsg);
    h.children[0]!.exit();
    // fresh 起動済み、resetResults に ok=true が 1 件
    expect(h.resetResults).toHaveLength(1);

    // fresh child が unexpected crash → 通常 crash 経路で auto-restart
    // (pendingReset が clear されているので #relaunchForReset には入らない)
    h.children[1]!.exit();
    expect(h.children).toHaveLength(3);
    // sendResetResult に追加なし (crash 経路は reset と無関係)
    expect(h.resetResults).toHaveLength(1);
  });
});

// ADR-0014 F1 追補 (resume-privilege-restoration, 藤 D1/D2). Covers the
// P0 apply paths: initial restore (handleSpawn with resume_session_id),
// live switch_session, reset_session, and the fresh-spawn / crash-restart
// / rollback no-apply invariants.
describe("resume-privilege-restoration apply (藤 D1/D2, P0)", () => {
  const codexSpawn = { ...spawnMsg, engine: "codex" as const };
  const claudeSpawn = spawnMsg;

  describe("initial restore (handleSpawn with resume_session_id)", () => {
    it("Codex: snapshot.sandbox / network_access を wrapper config へ apply", () => {
      const h = harness({ exists: true });
      h.sup.handleSpawn({
        ...codexSpawn,
        resume_session_id: "11111111-2222-3333-4444-555555555555",
        resume_snapshot: {
          sandbox: "danger-full-access",
          network_access: true,
        },
      });
      expect(h.configs[0]!.sandbox).toBe("danger-full-access");
      expect(h.configs[0]!.network_access).toBe(true);
    });

    it("Claude: snapshot.permission_mode を wrapper config へ apply", () => {
      const h = harness({ exists: true });
      h.sup.handleSpawn({
        ...claudeSpawn,
        resume_session_id: "22222222-3333-4444-5555-666666666666",
        resume_snapshot: { permission_mode: "bypassPermissions" },
      });
      expect(h.configs[0]!.permission_mode).toBe("bypassPermissions");
    });

    it("Codex: snapshot.sandbox absent → safe default workspace-write (旧 danger 保持禁止)", () => {
      const h = harness({ exists: true });
      // top-level explicit sandbox = danger だが restore 経路では
      // build_restore_payload が top-level を落とすので普通は届かない。
      // ただし届いたケースでも snapshot が SSOT なので上書きされる契約。
      h.sup.handleSpawn({
        ...codexSpawn,
        sandbox: "danger-full-access",
        network_access: true,
        resume_session_id: "33333333-4444-5555-6666-777777777777",
        resume_snapshot: {},
      });
      expect(h.configs[0]!.sandbox).toBe("workspace-write");
      expect(h.configs[0]!.network_access).toBe(false);
    });

    it("Codex: snapshot.network_access=false explicit は保持 (truthy 判定禁止 pin)", () => {
      const h = harness({ exists: true });
      h.sup.handleSpawn({
        ...codexSpawn,
        resume_session_id: "44444444-5555-6666-7777-888888888888",
        resume_snapshot: {
          sandbox: "workspace-write",
          network_access: false,
        },
      });
      expect(h.configs[0]!.network_access).toBe(false);
    });

    it("resume_session_id はあるが resume_snapshot 不在 → apply 発火せず top-level 値が残る", () => {
      const h = harness({ exists: true });
      h.sup.handleSpawn({
        ...codexSpawn,
        sandbox: "read-only",
        network_access: false,
        resume_session_id: "55555555-6666-7777-8888-999999999999",
      });
      // apply は snapshot null で no-op なので top-level 値がそのまま。
      expect(h.configs[0]!.sandbox).toBe("read-only");
    });
  });

  describe("fresh spawn (resume_session_id 不在) は no-apply", () => {
    it("fresh spawn は resume_snapshot が居ても apply せず top-level 値が残る", () => {
      const h = harness();
      h.sup.handleSpawn({
        ...codexSpawn,
        sandbox: "read-only",
        network_access: false,
        resume_snapshot: {
          sandbox: "danger-full-access",
          network_access: true,
        },
      });
      expect(h.configs[0]!.sandbox).toBe("read-only");
      expect(h.configs[0]!.network_access).toBe(false);
      // ただし snapshot 自体は drift 用に wrapper config へ passthrough される。
      expect(h.configs[0]!.resume_snapshot).toEqual({
        sandbox: "danger-full-access",
        network_access: true,
      });
    });
  });

  // phase-25: fresh-restore 経路 (ADR-0030 D8 追補)。session_id を失った
  // pointer から server が resume_session_id を積まず apply_resume_snapshot
  // だけ立てて fresh spawn を投げてくるケースで、runner が snapshot を
  // engine 軸へ apply することを pin する。
  describe("fresh-restore (apply_resume_snapshot flag、phase-25)", () => {
    it("Codex: apply_resume_snapshot=true + snapshot ありで fresh spawn の sandbox / network が snapshot 由来になる", () => {
      const h = harness();
      h.sup.handleSpawn({
        ...codexSpawn,
        apply_resume_snapshot: true,
        resume_snapshot: {
          sandbox: "danger-full-access",
          network_access: true,
        },
      });
      // fresh: resume_session_id なし = launch には --resume が渡らない。
      expect(h.resumes[0]).toBeUndefined();
      expect(h.configs[0]!.sandbox).toBe("danger-full-access");
      expect(h.configs[0]!.network_access).toBe(true);
    });

    it("Claude: apply_resume_snapshot=true で model/effort/permission_mode が snapshot 由来で launch される", () => {
      const h = harness();
      h.sup.handleSpawn({
        ...claudeSpawn,
        apply_resume_snapshot: true,
        resume_snapshot: {
          model: "claude-opus-4-7",
          model_source: "launch",
          effort: "high",
          effort_source: "launch",
          permission_mode: "bypassPermissions",
        },
      });
      expect(h.resumes[0]).toBeUndefined();
      expect(h.configs[0]!.model).toBe("claude-opus-4-7");
      expect(h.configs[0]!.model_source).toBe("launch");
      expect(h.configs[0]!.effort).toBe("high");
      expect(h.configs[0]!.effort_source).toBe("launch");
      expect(h.configs[0]!.permission_mode).toBe("bypassPermissions");
    });

    it("apply_resume_snapshot なし fresh spawn は resume_snapshot が居ても apply されない (D1 pin 維持)", () => {
      const h = harness();
      // 25-6 の実装で apply_resume_snapshot 未指定時は従来の no-apply
      // semantics を維持することの regression pin。
      h.sup.handleSpawn({
        ...codexSpawn,
        sandbox: "read-only",
        network_access: false,
        resume_snapshot: {
          sandbox: "danger-full-access",
          network_access: true,
        },
      });
      expect(h.configs[0]!.sandbox).toBe("read-only");
      expect(h.configs[0]!.network_access).toBe(false);
    });

    it("apply_resume_snapshot=true + snapshot なしは engine default に降格 (fail-soft)", () => {
      const h = harness();
      h.sup.handleSpawn({
        ...codexSpawn,
        // top-level に何も指定しない状態で fresh-restore 要求
        apply_resume_snapshot: true,
      });
      // applyResumeSnapshot は snapshot undefined で no-op、なので top-level
      // が空なら wrapper config も engine default に落ちる (Codex は
      // sandbox / network_access キー自体を積まない)。
      expect(h.configs[0]!.sandbox).toBeUndefined();
      expect(h.configs[0]!.network_access).toBeUndefined();
    });

    // ふじ advisory A1 (phase-25): fresh-restore で snapshot 由来値が
    // entry.parsed へ確定した後、crash-restart 経路が resume 経路と同様に
    // その値を継承することを pin する。resumes[1] は undefined (fresh 継続、
    // 二度目も --resume なし) であることも同時 pin。
    it("fresh-restore 後の crash-restart は snapshot 適用済み値を継承 (Codex)", () => {
      const h = harness();
      h.sup.handleSpawn({
        ...codexSpawn,
        apply_resume_snapshot: true,
        resume_snapshot: {
          sandbox: "danger-full-access",
          network_access: true,
        },
      });
      expect(h.configs[0]!.sandbox).toBe("danger-full-access");
      // Crash → auto-restart。entry.parsed が snapshot 適用済み state を
      // 保持しているので relaunch の config にも継承される。
      h.children[0]!.exit();
      expect(h.configs[1]!.sandbox).toBe("danger-full-access");
      expect(h.configs[1]!.network_access).toBe(true);
      // fresh-restore は resumeSessionId を持たないため crash-restart も
      // fresh 継続 (--resume なし)。
      expect(h.resumes[1]).toBeUndefined();
    });

    // ふじ advisory A2(a) (phase-25): 型不正な apply_resume_snapshot は
    // parseSpawn が null を返して fail-loud reject する (truthy garbage を
    // 通さない)。
    it("apply_resume_snapshot が boolean 以外 → parseSpawn は null で reject", () => {
      const rejected = parseSpawn({
        ...codexSpawn,
        apply_resume_snapshot: "yes",
      });
      expect(rejected).toBeNull();
    });

    // ふじ advisory A2(b) (phase-25): flag と resume_session_id が同時に
    // 立つ payload は resume 経路が優先 (T3/F4 発火、resume snapshot apply も
    // resume 経路の 1 回だけ)。fresh 分岐の apply_resume_snapshot handling
    // には流れないので二重 apply は起こらない。
    it("apply_resume_snapshot + resume_session_id 両方 set → resume 経路優先で二重 apply なし", () => {
      const h = harness({ exists: true });
      h.sup.handleSpawn({
        ...codexSpawn,
        apply_resume_snapshot: true,
        resume_session_id: "aaaaaaaa-1111-2222-3333-444444444444",
        resume_snapshot: {
          sandbox: "danger-full-access",
          network_access: true,
        },
      });
      // resume path が発火: --resume 付き、snapshot は 1 度だけ apply。
      expect(h.resumes[0]).toBe("aaaaaaaa-1111-2222-3333-444444444444");
      expect(h.configs[0]!.sandbox).toBe("danger-full-access");
      expect(h.configs[0]!.network_access).toBe(true);
    });

    // ふじ advisory A2(c) (phase-25): sparse な snapshot (P0 field 欠け) は
    // 欠けた分だけ engine safe default に落ち、載っている field は snapshot
    // 由来のまま保持される。model は P1 pair rule で載る。
    it("sparse snapshot (P0 欠け) の fresh-restore は missing 分だけ safe default", () => {
      const h = harness();
      h.sup.handleSpawn({
        ...codexSpawn,
        apply_resume_snapshot: true,
        // P1 (model / model_source) だけ載せ、P0 (sandbox / network_access)
        // は完全に欠落させる。
        resume_snapshot: {
          model: "gpt-5",
          model_source: "launch",
        },
      });
      // P0 は safe default (Codex): workspace-write / false。
      expect(h.configs[0]!.sandbox).toBe("workspace-write");
      expect(h.configs[0]!.network_access).toBe(false);
      // P1 は snapshot 由来がそのまま届く。
      expect(h.configs[0]!.model).toBe("gpt-5");
      expect(h.configs[0]!.model_source).toBe("launch");
    });
  });

  describe("handleSwitchSession", () => {
    it("Codex live switch: payload.resume_snapshot の sandbox / network を relaunch config に apply", () => {
      const h = harness({ exists: true });
      h.sup.handleSpawn({
        ...codexSpawn,
        resume_session_id: "aaaaaaaa-1111-1111-1111-111111111111",
        resume_snapshot: {
          sandbox: "workspace-write",
          network_access: false,
        },
      });
      // Live switch は新 snapshot を authoritative に。
      h.sup.handleSwitchSession({
        agent_id: codexSpawn.agent_id,
        resume_session_id: "bbbbbbbb-2222-2222-2222-222222222222",
        resume_snapshot: {
          sandbox: "danger-full-access",
          network_access: true,
        },
      });
      h.children[0]!.exit();
      // Relaunch config = 2 件目。
      expect(h.configs[1]!.sandbox).toBe("danger-full-access");
      expect(h.configs[1]!.network_access).toBe(true);
    });

    it("Claude live switch: payload.resume_snapshot の permission_mode を apply", () => {
      const h = harness({ exists: true });
      h.sup.handleSpawn({
        ...claudeSpawn,
        resume_session_id: "cccccccc-3333-3333-3333-333333333333",
        resume_snapshot: { permission_mode: "plan" },
      });
      h.sup.handleSwitchSession({
        agent_id: claudeSpawn.agent_id,
        resume_session_id: "dddddddd-4444-4444-4444-444444444444",
        resume_snapshot: { permission_mode: "bypassPermissions" },
      });
      h.children[0]!.exit();
      expect(h.configs[1]!.permission_mode).toBe("bypassPermissions");
    });

    it("switch payload.resume_snapshot 不在 → 旧 entry.parsed の snapshot を維持", () => {
      const h = harness({ exists: true });
      h.sup.handleSpawn({
        ...codexSpawn,
        resume_session_id: "eeeeeeee-5555-5555-5555-555555555555",
        resume_snapshot: {
          sandbox: "danger-full-access",
          network_access: true,
        },
      });
      // switch_session に snapshot を付けない → 旧 snapshot 由来値が残る。
      h.sup.handleSwitchSession({
        agent_id: codexSpawn.agent_id,
        resume_session_id: "ffffffff-6666-6666-6666-666666666666",
      });
      h.children[0]!.exit();
      expect(h.configs[1]!.sandbox).toBe("danger-full-access");
      expect(h.configs[1]!.network_access).toBe(true);
    });
  });

  describe("handleResetSession", () => {
    const resetMsg = {
      agent_id: codexSpawn.agent_id,
      mode: "new" as const,
      request_id: "rs_apply_test",
      previous_session_id: "sess-old",
    };

    it("Codex reset: payload.resume_snapshot の sandbox / network を fresh relaunch config に apply", () => {
      const h = harness();
      h.sup.handleSpawn({
        ...codexSpawn,
        sandbox: "read-only",
        network_access: false,
      });
      h.sup.handleResetSession({
        ...resetMsg,
        resume_snapshot: {
          sandbox: "danger-full-access",
          network_access: true,
        },
      });
      h.children[0]!.exit();
      // fresh relaunch = 2 件目、snapshot の privilege 三軸が反映される。
      expect(h.configs[1]!.sandbox).toBe("danger-full-access");
      expect(h.configs[1]!.network_access).toBe(true);
      // 元の spawn 由来の read-only は破棄される (SSOT contract)。
      expect(h.resumes[1]).toBeUndefined(); // fresh: no --resume
    });

    it("Claude reset: payload.resume_snapshot の permission_mode を apply", () => {
      const h = harness();
      h.sup.handleSpawn(claudeSpawn);
      h.sup.handleResetSession({
        ...resetMsg,
        agent_id: claudeSpawn.agent_id,
        resume_snapshot: { permission_mode: "bypassPermissions" },
      });
      h.children[0]!.exit();
      expect(h.configs[1]!.permission_mode).toBe("bypassPermissions");
    });

    it("reset payload.resume_snapshot 不在 → 旧 entry.parsed の snapshot を維持", () => {
      const h = harness();
      h.sup.handleSpawn({
        ...codexSpawn,
        resume_snapshot: {
          sandbox: "danger-full-access",
          network_access: true,
        },
      });
      h.sup.handleResetSession(resetMsg);
      h.children[0]!.exit();
      // reset に snapshot 無し → 旧 entry.parsed.resumeSnapshot 由来値が残る。
      expect(h.configs[1]!.sandbox).toBe("danger-full-access");
    });

    it("reset payload.resume_snapshot に empty {} → safe default に降格", () => {
      const h = harness();
      h.sup.handleSpawn({
        ...codexSpawn,
        resume_snapshot: {
          sandbox: "danger-full-access",
          network_access: true,
        },
      });
      // 明示的に empty snapshot を送ると snapshot SSOT で default 降格。
      h.sup.handleResetSession({ ...resetMsg, resume_snapshot: {} });
      h.children[0]!.exit();
      expect(h.configs[1]!.sandbox).toBe("workspace-write");
      expect(h.configs[1]!.network_access).toBe(false);
    });
  });

  describe("crash-restart / rollback は apply しない (entry.parsed 継承)", () => {
    it("crash-restart は entry.parsed の snapshot 適用済み値を維持", () => {
      const h = harness({ exists: true });
      h.sup.handleSpawn({
        ...codexSpawn,
        resume_session_id: "12121212-3434-5656-7878-909090909090",
        resume_snapshot: {
          sandbox: "danger-full-access",
          network_access: true,
        },
      });
      // Initial restore で snapshot が entry.parsed に反映済み。
      expect(h.configs[0]!.sandbox).toBe("danger-full-access");

      // Crash → auto-restart。entry.parsed の値がそのまま carry over。
      h.children[0]!.exit();
      expect(h.configs[1]!.sandbox).toBe("danger-full-access");
      expect(h.configs[1]!.network_access).toBe(true);
    });

    it("rollback 経路は reset 前に apply 済みの entry.parsed を維持", () => {
      // fresh spawn 失敗 → rollback で旧 session_id で再起動、entry.parsed の
      // snapshot 適用値 (danger-full-access) はそのまま残る。
      const h = harness({ launchThrowsOnCall: 2, exists: true });
      h.sup.handleSpawn({
        ...codexSpawn,
        resume_session_id: "34343434-5656-7878-9090-121212121212",
        resume_snapshot: {
          sandbox: "danger-full-access",
          network_access: true,
        },
      });
      h.sup.handleResetSession({
        agent_id: codexSpawn.agent_id,
        mode: "new",
        request_id: "rs_rollback_pin",
        previous_session_id: "sess-old-rollback",
        resume_snapshot: {},
      });
      h.children[0]!.exit();
      // rollback launch = 3 件目 (2 件目は throw)。
      expect(h.configs.length).toBe(2);
      // reset で {} snapshot により default 降格した値が保持される。
      expect(h.configs[1]!.sandbox).toBe("workspace-write");
      expect(h.configs[1]!.network_access).toBe(false);
    });
  });

  // 藤 R2 追補: switch/reset で payload.resume_snapshot が present だが
  // 非 object (validate=null) の場合、entry.parsed の旧 privileged 値を
  // 決して継承しない (旧 danger 保持禁止)。
  describe("whole-malformed resume_snapshot: switch は fail-loud、reset は safe-default 降格 (藤 R2)", () => {
    it("handleSwitchSession: payload.resume_snapshot が string (non-object) → #fail(error) + kill/relaunch なし + F4 lock 変化なし", () => {
      const h = harness({ exists: true });
      h.sup.handleSpawn({
        ...codexSpawn,
        resume_session_id: "aaaa1111-1111-1111-1111-111111111111",
        resume_snapshot: {
          sandbox: "danger-full-access",
          network_access: true,
        },
      });
      const kills0 = h.children[0]!.kills;

      h.sup.handleSwitchSession({
        agent_id: codexSpawn.agent_id,
        resume_session_id: "bbbb2222-2222-2222-2222-222222222222",
        resume_snapshot: "not-a-map",
      });

      // #fail(error) が sendResult に届く。子 process は kill されない
      // (旧 danger を継承した fresh を絶対に起動しない)。
      expect(h.results.at(-1)).toMatchObject({
        ok: false,
        reason: "error",
        agent_id: codexSpawn.agent_id,
      });
      expect(h.children[0]!.kills).toBe(kills0);
      expect(h.children.length).toBe(1);
    });

    it("handleSwitchSession: payload.resume_snapshot が array (non-object) → 同様に fail-loud", () => {
      const h = harness({ exists: true });
      h.sup.handleSpawn({
        ...codexSpawn,
        resume_session_id: "aaaa3333-3333-3333-3333-333333333333",
        resume_snapshot: {
          sandbox: "danger-full-access",
          network_access: true,
        },
      });

      h.sup.handleSwitchSession({
        agent_id: codexSpawn.agent_id,
        resume_session_id: "bbbb4444-4444-4444-4444-444444444444",
        resume_snapshot: [1, 2],
      });

      expect(h.results.at(-1)).toMatchObject({
        ok: false,
        reason: "error",
      });
      expect(h.children.length).toBe(1);
    });

    it("handleResetSession: payload.resume_snapshot が非 object → safe-default relaunch (旧 danger を継承しない)", () => {
      const h = harness();
      h.sup.handleSpawn({
        ...codexSpawn,
        resume_snapshot: {
          sandbox: "danger-full-access",
          network_access: true,
        },
      });

      h.sup.handleResetSession({
        agent_id: codexSpawn.agent_id,
        mode: "new",
        request_id: "rs_malformed_reset",
        previous_session_id: "sess-prev",
        resume_snapshot: "not-a-map",
      });
      h.children[0]!.exit();

      // fresh relaunch 発火 (=2 件目)、safe engine default (旧 danger 破棄)。
      expect(h.configs.length).toBe(2);
      expect(h.configs[1]!.sandbox).toBe("workspace-write");
      expect(h.configs[1]!.network_access).toBe(false);
    });

    it("handleResetSession: individual field malformed の integration も safe-default 降格を pin (藤 R3)", () => {
      // Whole-malformed でなく個別 field malformed (sanitize が {} を返す)
      // 場合も同じ経路。resume_snapshot.ts の pure helper 側でも pin 済みだが、
      // handler 経由の integration でも pin する。
      const h = harness();
      h.sup.handleSpawn({
        ...codexSpawn,
        resume_snapshot: {
          sandbox: "danger-full-access",
          network_access: true,
        },
      });

      h.sup.handleResetSession({
        agent_id: codexSpawn.agent_id,
        mode: "new",
        request_id: "rs_indiv_malformed",
        previous_session_id: "sess-prev",
        resume_snapshot: {
          sandbox: "hacked", // enum 不一致 → drop
          network_access: "yes", // boolean 不一致 → drop
        },
      });
      h.children[0]!.exit();

      expect(h.configs.length).toBe(2);
      expect(h.configs[1]!.sandbox).toBe("workspace-write");
      expect(h.configs[1]!.network_access).toBe(false);
    });
  });
});

describe("Supervisor.updateRuntimeConfig (config hot-reload)", () => {
  it("新 cwdAllowlist を適用し、旧 cwd の spawn は cwd_not_found で拒否する", () => {
    const h = harness({ cwdAllowlist: ["/old/path"] });
    h.sup.updateRuntimeConfig({
      cwdAllowlist: ["/new/path"],
      wrapperServerUrl: "ws://localhost:4000/wrapper",
      codexAuthMode: undefined,
      codexChatgptPlan: undefined,
      codexInternalSubagents: undefined,
      getClaudeEngineCatalog: undefined,
    });
    h.sup.handleSpawn({ ...spawnMsg, cwd: "/old/path" });
    expect(h.results.at(-1)).toEqual({
      version: "0",
      host_id: "lab-pc-1",
      agent_id: spawnMsg.agent_id,
      ok: false,
      reason: "cwd_not_found",
    });
    h.sup.handleSpawn({
      ...spawnMsg,
      agent_id: "lab-pc-1.claude-b",
      cwd: "/new/path",
    });
    expect(h.results.at(-1)?.ok).toBe(true);
  });

  it("新 wrapperServerUrl を fallback として次の spawn の WrapperConfig に流し込む", () => {
    const h = harness({
      cwdAllowlist: ["/cwd"],
      wrapperServerUrl: "ws://old:4000/wrapper",
    });
    h.sup.updateRuntimeConfig({
      cwdAllowlist: ["/cwd"],
      wrapperServerUrl: "ws://new:5000/wrapper",
      codexAuthMode: undefined,
      codexChatgptPlan: undefined,
      codexInternalSubagents: undefined,
      getClaudeEngineCatalog: undefined,
    });
    // server_url を spawn 側で欠落させると fallback が使われる
    const { server_url: _drop, ...withoutUrl } = spawnMsg;
    void _drop;
    h.sup.handleSpawn({ ...withoutUrl, cwd: "/cwd" });
    expect(h.configs.at(-1)?.server_url).toBe("ws://new:5000/wrapper");
  });

  it("codexChatgptPlan を差替え、以降の codex spawn の WrapperConfig に載る", () => {
    const h = harness({ cwdAllowlist: ["/cwd"] });
    h.sup.updateRuntimeConfig({
      cwdAllowlist: ["/cwd"],
      wrapperServerUrl: "ws://localhost:4000/wrapper",
      codexAuthMode: "chatgpt",
      codexChatgptPlan: "pro",
      codexInternalSubagents: undefined,
      getClaudeEngineCatalog: undefined,
    });
    h.sup.handleSpawn({ ...spawnMsg, cwd: "/cwd", engine: "codex" });
    expect(h.configs.at(-1)?.codex_chatgpt_plan).toBe("pro");
    expect(h.configs.at(-1)?.codex_auth_mode).toBe("chatgpt");
  });

  it("codexChatgptPlan を undefined に戻すと以降の codex spawn からも消える", () => {
    const h = harness({ cwdAllowlist: ["/cwd"] });
    h.sup.updateRuntimeConfig({
      cwdAllowlist: ["/cwd"],
      wrapperServerUrl: "ws://localhost:4000/wrapper",
      codexAuthMode: "chatgpt",
      codexChatgptPlan: "pro",
      codexInternalSubagents: undefined,
      getClaudeEngineCatalog: undefined,
    });
    h.sup.updateRuntimeConfig({
      cwdAllowlist: ["/cwd"],
      wrapperServerUrl: "ws://localhost:4000/wrapper",
      codexAuthMode: "chatgpt",
      codexChatgptPlan: undefined,
      codexInternalSubagents: undefined,
      getClaudeEngineCatalog: undefined,
    });
    h.sup.handleSpawn({ ...spawnMsg, cwd: "/cwd", engine: "codex" });
    expect(h.configs.at(-1)?.codex_chatgpt_plan).toBeUndefined();
  });

  it("既存稼働中の child は kill されない (適用は将来の spawn だけ)", () => {
    const h = harness({ cwdAllowlist: ["/cwd"] });
    h.sup.handleSpawn({ ...spawnMsg, cwd: "/cwd" });
    const running = h.last();
    h.sup.updateRuntimeConfig({
      cwdAllowlist: ["/other"],
      wrapperServerUrl: "ws://localhost:4000/wrapper",
      codexAuthMode: undefined,
      codexChatgptPlan: undefined,
      codexInternalSubagents: undefined,
      getClaudeEngineCatalog: undefined,
    });
    expect(running.kills).toBe(0);
  });

  it("codexInternalSubagents 未指定は effective default=true を codex spawn config に載せる", () => {
    const h = harness({ cwdAllowlist: ["/cwd"] });
    h.sup.handleSpawn({ ...spawnMsg, cwd: "/cwd", engine: "codex" });
    expect(h.configs.at(-1)?.codex_internal_subagents).toBe(true);
  });

  it("codexInternalSubagents=false は以降の codex spawn の WrapperConfig に載る", () => {
    const h = harness({ cwdAllowlist: ["/cwd"] });
    h.sup.updateRuntimeConfig({
      cwdAllowlist: ["/cwd"],
      wrapperServerUrl: "ws://localhost:4000/wrapper",
      codexAuthMode: "chatgpt",
      codexChatgptPlan: undefined,
      codexInternalSubagents: false,
      getClaudeEngineCatalog: undefined,
    });
    h.sup.handleSpawn({ ...spawnMsg, cwd: "/cwd", engine: "codex" });
    expect(h.configs.at(-1)?.codex_internal_subagents).toBe(false);
  });

  it("codexInternalSubagents=true は以降の codex spawn の WrapperConfig に true として載る", () => {
    const h = harness({ cwdAllowlist: ["/cwd"] });
    h.sup.updateRuntimeConfig({
      cwdAllowlist: ["/cwd"],
      wrapperServerUrl: "ws://localhost:4000/wrapper",
      codexAuthMode: "chatgpt",
      codexChatgptPlan: undefined,
      codexInternalSubagents: true,
      getClaudeEngineCatalog: undefined,
    });
    h.sup.handleSpawn({ ...spawnMsg, cwd: "/cwd", engine: "codex" });
    expect(h.configs.at(-1)?.codex_internal_subagents).toBe(true);
  });

  it("getClaudeEngineCatalog が返す catalog を claude spawn の WrapperConfig に載せる (ADR-0039 F9)", () => {
    const catalog = [
      { value: "sonnet", display_name: "Sonnet", description: "" },
      { value: "haiku", display_name: "Haiku", description: "" },
    ];
    const h = harness({
      cwdAllowlist: ["/cwd"],
      getClaudeEngineCatalog: () => catalog,
    });
    h.sup.handleSpawn({ ...spawnMsg, cwd: "/cwd", engine: "claude-code" });
    expect(h.configs.at(-1)?.claude_engine_catalog).toEqual(catalog);
  });

  it("getClaudeEngineCatalog が null / 空を返したら WrapperConfig に載せない (bootstrap 経路)", () => {
    const empties: Array<WrapperConfig["claude_engine_catalog"] | null> = [
      null,
      undefined,
      [],
    ];
    for (const empty of empties) {
      const h = harness({
        cwdAllowlist: ["/cwd"],
        getClaudeEngineCatalog: () => empty,
      });
      h.sup.handleSpawn({ ...spawnMsg, cwd: "/cwd", engine: "claude-code" });
      expect(h.configs.at(-1)?.claude_engine_catalog).toBeUndefined();
    }
  });

  it("codex spawn では claude_engine_catalog を無視する (engine 分離)", () => {
    const catalog = [
      { value: "sonnet", display_name: "Sonnet", description: "" },
    ];
    const h = harness({
      cwdAllowlist: ["/cwd"],
      getClaudeEngineCatalog: () => catalog,
    });
    h.sup.handleSpawn({ ...spawnMsg, cwd: "/cwd", engine: "codex" });
    expect(h.configs.at(-1)?.claude_engine_catalog).toBeUndefined();
  });
});

// Phase-23 (ADR-0014 F1 追補「P1 pair-aware apply」, 藤 R2 must-fix
// integration coverage). resume_snapshot.test.ts の pure helper unit test
// では applyResumeSnapshot が ParsedSpawn を正しく mutate することしか pin
// できず、各 handler が **applyResumeSnapshot 呼び出し → ParsedSpawn 更新
// → resolveWrapperConfig で config.model_source / effort_source へ
// passthrough** の全経路を carry する保証がない。以下では代表経路
// (initial restore / live switch / reset) と Codex/Claude engine 対称性
// を config レベルで確認する。crash/rollback の経路継承は phase-22 P0
// 系 test で既に entry.parsed を carry すること (ChildEntry.parsed のみ
// 参照する #relaunch / #rollback の code path 単純性) が pin されており、
// P1 field も同じ carry を辿るため P1 独立 test は追加しない。
describe("Supervisor P1 pair-aware apply integration (phase-23)", () => {
  const codexResumeMsg = {
    ...spawnMsg,
    engine: "codex",
    resume_session_id: "22222222-3333-4444-5555-666666666666",
  };
  const claudeResumeMsg = {
    ...spawnMsg,
    engine: "claude-code",
    resume_session_id: "33333333-4444-5555-6666-777777777777",
  };

  it("initial restore (Codex): Case 3 explicit source を config.model_source / effort_source へ passthrough", () => {
    const h = harness({ exists: true });
    h.sup.handleSpawn({
      ...codexResumeMsg,
      resume_snapshot: {
        model: "gpt-5.6-sol",
        model_source: "launch",
        effort: "high",
        effort_source: "config",
        sandbox: "workspace-write",
      },
    });
    const cfg = h.configs[0]!;
    expect(cfg.model).toBe("gpt-5.6-sol");
    expect(cfg.model_source).toBe("launch");
    expect(cfg.effort).toBe("high");
    expect(cfg.effort_source).toBe("config");
  });

  it("initial restore (Codex): Case 2 (source=default) は config へ載らない (SDK 委任)", () => {
    const h = harness({ exists: true });
    h.sup.handleSpawn({
      ...codexResumeMsg,
      resume_snapshot: {
        model: "gpt-5.6-terra",
        model_source: "default",
        effort: "medium",
        effort_source: "default",
      },
    });
    const cfg = h.configs[0]!;
    // Case 2: value + source=default → pair 全体 unset。config.model /
    // config.model_source どちらも undefined (前回 SDK 側 default を委任
    // していたため、次回も explicit pin せず SDK に再選択させる)。
    expect(cfg.model).toBeUndefined();
    expect(cfg.model_source).toBeUndefined();
    expect(cfg.effort).toBeUndefined();
    expect(cfg.effort_source).toBeUndefined();
    // Phase-23 dogfood 回帰対策 (ADR-0014 F1 追補 P1「launch pin vs display
    // hint」): Case 2 で config には載らないが、config.resume_snapshot には
    // sanitize 通過後の (value, source="default") ペアが保持されており、
    // wrapper 側は これを display / catalog resolve hint として consume する。
    expect(cfg.resume_snapshot).toEqual({
      model: "gpt-5.6-terra",
      model_source: "default",
      effort: "medium",
      effort_source: "default",
    });
  });

  it("initial restore (Codex): Case 4 legacy (value only) は config.*_source='config' で届く", () => {
    const h = harness({ exists: true });
    h.sup.handleSpawn({
      ...codexResumeMsg,
      // source tracking 導入前の DETS record を模す
      resume_snapshot: { model: "gpt-5.5", effort: "low" },
    });
    const cfg = h.configs[0]!;
    expect(cfg.model).toBe("gpt-5.5");
    expect(cfg.model_source).toBe("config");
    expect(cfg.effort).toBe("low");
    expect(cfg.effort_source).toBe("config");
  });

  it("initial restore (Claude): Case 3 対称性 pin", () => {
    const h = harness({ exists: true });
    h.sup.handleSpawn({
      ...claudeResumeMsg,
      resume_snapshot: {
        model: "opus[1m]",
        model_source: "env",
        effort: "high",
        effort_source: "config",
        permission_mode: "bypassPermissions",
      },
    });
    const cfg = h.configs[0]!;
    expect(cfg.model).toBe("opus[1m]");
    expect(cfg.model_source).toBe("env");
    expect(cfg.effort).toBe("high");
    expect(cfg.effort_source).toBe("config");
    expect(cfg.permission_mode).toBe("bypassPermissions");
  });

  it("live switch (Codex): payload.resume_snapshot の P1 pair が relaunched child の config に届く", () => {
    const h = harness({ exists: true });
    h.sup.handleSpawn({
      ...codexResumeMsg,
      resume_snapshot: {
        model: "gpt-5.6-sol",
        model_source: "launch",
        effort: "high",
        effort_source: "launch",
      },
    });
    h.sup.handleSwitchSession({
      version: "0",
      agent_id: codexResumeMsg.agent_id,
      resume_session_id: "44444444-5555-6666-7777-888888888888",
      resume_snapshot: {
        model: "gpt-5.6-terra",
        model_source: "config",
        effort: "medium",
        effort_source: "config",
      },
    });
    h.children[0]!.exit();
    // relaunched child = configs[1]
    const cfg = h.configs[1]!;
    expect(cfg.model).toBe("gpt-5.6-terra");
    expect(cfg.model_source).toBe("config");
    expect(cfg.effort).toBe("medium");
    expect(cfg.effort_source).toBe("config");
  });

  it("reset_session (Claude): payload.resume_snapshot の P1 pair が fresh relaunch config に届く", () => {
    const h = harness({ exists: true });
    h.sup.handleSpawn(claudeResumeMsg);
    h.sup.handleResetSession({
      agent_id: claudeResumeMsg.agent_id,
      mode: "new",
      request_id: "rs_p1",
      previous_session_id: claudeResumeMsg.resume_session_id,
      resume_snapshot: {
        model: "opus[1m]",
        model_source: "launch",
        effort: "max",
        effort_source: "launch",
      },
    });
    h.children[0]!.exit();
    const cfg = h.configs[1]!;
    expect(cfg.model).toBe("opus[1m]");
    expect(cfg.model_source).toBe("launch");
    expect(cfg.effort).toBe("max");
    expect(cfg.effort_source).toBe("launch");
    // fresh: resume_session_id は stripped
    expect(h.resumes[1]).toBeUndefined();
  });

  it("fresh spawn (no resume) では payload.resume_snapshot に P1 pair が載っていても config へは apply されない (P0/P1 共通の apply しない semantics)", () => {
    const h = harness();
    // fresh spawn (resume_session_id 未指定) に snapshot を混ぜる (ill-typed
    // 使用だが sanitize を通れば passthrough される)。
    h.sup.handleSpawn({
      ...spawnMsg,
      engine: "codex",
      resume_snapshot: {
        model: "gpt-5.6-sol",
        model_source: "launch",
      },
    });
    const cfg = h.configs[0]!;
    // config.resume_snapshot には drift 表示用に届くが (Phase 22 semantics)、
    // config.model / config.model_source は fresh spawn の空の parsed のまま
    // (applyResumeSnapshot が呼ばれない経路)。
    expect(cfg.model).toBeUndefined();
    expect(cfg.model_source).toBeUndefined();
    expect(cfg.resume_snapshot).toEqual({
      model: "gpt-5.6-sol",
      model_source: "launch",
    });
  });
});

// phase-27 (#160): the session-transition correlation id must survive every
// hop the runner owns — into the wrapper config, back out on spawn_result,
// and across a switch's relaunch. The server matches a wrapper's join
// against this id, so a dropped or stale value silently costs the agent its
// activity metadata.
describe("Supervisor — session transition 相関子 (#160)", () => {
  const withId = { ...spawnMsg, request_id: "tr-spawn-1" };

  it("spawn 成功の result に request_id を echo する", () => {
    const h = harness();
    h.sup.handleSpawn(withId);
    expect(h.results[0]).toMatchObject({ ok: true, request_id: "tr-spawn-1" });
  });

  it("spawn 失敗の result にも request_id を echo する", () => {
    const h = harness();
    h.sup.handleSpawn({ ...withId, cwd: "/etc" });
    expect(h.results[0]).toMatchObject({
      ok: false,
      reason: "cwd_not_found",
      request_id: "tr-spawn-1",
    });
  });

  it("parseSpawn が弾く payload でも request_id を echo する", () => {
    // parsed が得られない経路でも、server は対象の pending transition を
    // 特定して abort できなければならない。
    const h = harness();
    const { persona: _omit, ...broken } = withId;
    void _omit;
    h.sup.handleSpawn(broken);
    expect(h.results[0]).toMatchObject({
      ok: false,
      reason: "error",
      request_id: "tr-spawn-1",
    });
  });

  it("wrapper config へ transition_id として伝播する", () => {
    const h = harness();
    h.sup.handleSpawn(withId);
    expect(h.configs[0]).toMatchObject({ transition_id: "tr-spawn-1" });
  });

  it("legacy (request_id なし) では config にも result にも載せない", () => {
    const h = harness();
    h.sup.handleSpawn(spawnMsg);
    expect(h.configs[0]).not.toHaveProperty("transition_id");
    expect(h.results[0]).not.toHaveProperty("request_id");
  });

  it("空文字の request_id は落として wrapper へ渡さない", () => {
    // server は blank を legacy absent ではなく mismatch として扱うため、
    // blank が CAS の迂回経路にならないようにする。
    const h = harness();
    h.sup.handleSpawn({ ...spawnMsg, request_id: "" });
    expect(h.configs[0]).not.toHaveProperty("transition_id");
  });

  it("switch の relaunch は switch 自身の id を運ぶ", () => {
    const h = harness({ exists: true });
    h.sup.handleSpawn({
      ...spawnMsg,
      resume_session_id: "11111111-2222-3333-4444-555555555555",
      request_id: "tr-spawn-1",
    });
    h.sup.handleSwitchSession({
      agent_id: spawnMsg.agent_id,
      resume_session_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      request_id: "tr-switch-1",
    });
    h.last().exit();
    expect(h.configs[1]).toMatchObject({ transition_id: "tr-switch-1" });
  });

  it("legacy switch は前回 spawn の stale な id を持ち込まない", () => {
    const h = harness({ exists: true });
    h.sup.handleSpawn({
      ...spawnMsg,
      resume_session_id: "11111111-2222-3333-4444-555555555555",
      request_id: "tr-spawn-1",
    });
    h.sup.handleSwitchSession({
      agent_id: spawnMsg.agent_id,
      resume_session_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    });
    h.last().exit();
    expect(h.configs[1]).not.toHaveProperty("transition_id");
  });

  it("stop による spawn 取消は request_id なしで報告する", () => {
    // 元コマンドの相関子を保持していないため。server 側は CAS 不一致として
    // 破棄し、pending は TTL で回収される (plan の degrade path)。
    const h = harness({ exists: new Promise<boolean>(() => {}) });
    h.sup.handleSpawn({
      ...withId,
      resume_session_id: "11111111-2222-3333-4444-555555555555",
    });
    h.sup.handleStop({ agent_id: spawnMsg.agent_id });
    expect(h.results[0]).toMatchObject({ ok: false, reason: "error" });
    expect(h.results[0]).not.toHaveProperty("request_id");
  });
});

// phase-27 (#160) MF-R3: the fresh session a reset creates belongs to THAT
// reset, so its relaunch must carry the reset's request_id — the server
// matches the fresh wrapper's join against the reset lock it holds, and an
// inherited spawn id would read as a mismatch and suppress the metadata.
describe("Supervisor.handleResetSession — transition 相関子 (#160)", () => {
  it("fresh relaunch は reset の request_id を transition_id として運ぶ", () => {
    const h = harness();
    h.sup.handleSpawn({ ...spawnMsg, request_id: "tr-spawn-1" });
    h.sup.handleResetSession({
      agent_id: spawnMsg.agent_id,
      mode: "new",
      request_id: "rs-reset-1",
      previous_session_id: "sess-old-xyz",
    });
    h.children[0]!.exit();

    expect(h.configs[1]).toMatchObject({ transition_id: "rs-reset-1" });
  });
});
