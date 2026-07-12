import { describe, expect, it } from "vitest";
import type {
  RunnerSessions,
  SessionMeta,
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
    sessions?: SessionMeta[];
    exists?: boolean;
    wrapperServerUrl?: string;
    now?: () => number;
  } = {},
) {
  const children: FakeChild[] = [];
  const results: SpawnResult[] = [];
  const configs: WrapperConfig[] = [];
  const resumes: Array<string | undefined> = [];
  const prompts: Array<string | undefined> = [];
  const sessionsSent: RunnerSessions[] = [];
  const sup = new Supervisor({
    hostId: "lab-pc-1",
    cwdAllowlist: opts.cwdAllowlist ?? allowlist,
    wrapperServerUrl: opts.wrapperServerUrl ?? "ws://localhost:4000/wrapper",
    launch: (_agentId, config, _cwd, resumeSessionId, initialPrompt) => {
      configs.push(config);
      resumes.push(resumeSessionId);
      prompts.push(initialPrompt);
      const child = new FakeChild();
      children.push(child);
      return child;
    },
    sendResult: (r) => results.push(r),
    sendSessions: (s) => sessionsSent.push(s),
    listSessions: () => opts.sessions ?? [],
    sessionExists: () => opts.exists ?? false,
    ...(opts.now === undefined ? {} : { now: opts.now }),
  });
  return {
    sup,
    children,
    results,
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
      server_url: spawnMsg.server_url,
      server_token: "tok",
    });
    expect("allowed_tools" in config).toBe(false);
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
      { version: "0", host_id: "lab-pc-1", agent_id: spawnMsg.agent_id, ok: true },
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
    expect(h.results[1]).toMatchObject({ ok: false, reason: "already_running" });
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
  const resumeMsg = { ...spawnMsg, resume_session_id: "11111111-2222-3333-4444-555555555555" };

  it("存在する session は起動し --resume を渡す", () => {
    const h = harness({ exists: true });
    h.sup.handleSpawn(resumeMsg);
    expect(h.children).toHaveLength(1);
    expect(h.resumes[0]).toBe(resumeMsg.resume_session_id);
    expect(h.results[0]).toMatchObject({ ok: true });
  });

  it("存在しない session(T3 失敗)は error で拒否", () => {
    const h = harness({ exists: false });
    h.sup.handleSpawn(resumeMsg);
    expect(h.children).toHaveLength(0);
    expect(h.results[0]).toMatchObject({ ok: false, reason: "error" });
  });

  it("同一 session の同時 resume は already_running(F4 ロック)", () => {
    const h = harness({ exists: true });
    h.sup.handleSpawn({ ...resumeMsg, agent_id: "lab-pc-1.claude-a" });
    h.sup.handleSpawn({ ...resumeMsg, agent_id: "lab-pc-1.claude-b" });
    expect(h.children).toHaveLength(1);
    expect(h.results[1]).toMatchObject({ ok: false, reason: "already_running" });
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
    const sessions: SessionMeta[] = [{ session_id: "s1", mtime: "2026-06-24T00:00:00Z" }];
    const h = harness({ sessions });
    h.sup.handleEnumerate({ version: "0", agent_id: "a", cwd: "/home/user/git/kaoiro" });
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

  it("resume_session_id を欠くと error で拒否", () => {
    const h = harness({ exists: true });
    h.sup.handleSpawn(resumeMsg);
    h.sup.handleSwitchSession({ agent_id: resumeMsg.agent_id });
    expect(h.results[1]).toMatchObject({ ok: false, reason: "error" });
    expect(h.last().kills).toBe(0);
  });

  it("差替先の session が存在しなければ error(T3)", () => {
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
      sessionExists: () => exists,
    });
    sup.handleSpawn(resumeMsg);
    exists = false;
    sup.handleSwitchSession({
      agent_id: resumeMsg.agent_id,
      resume_session_id: otherSession,
    });
    expect(results[1]).toMatchObject({ ok: false, reason: "error" });
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
