import { describe, expect, it } from "vitest";
import type { SpawnResult, WrapperConfig } from "@kaoiro/protocol";
import {
  MAX_RESTARTS,
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

function harness(opts: { cwdAllowlist?: string[] } = {}) {
  const children: FakeChild[] = [];
  const results: SpawnResult[] = [];
  const configs: WrapperConfig[] = [];
  const sup = new Supervisor({
    hostId: "lab-pc-1",
    cwdAllowlist: opts.cwdAllowlist ?? allowlist,
    launch: (_agentId, config) => {
      configs.push(config);
      const child = new FakeChild();
      children.push(child);
      return child;
    },
    sendResult: (r) => results.push(r),
  });
  return { sup, children, results, configs, last: () => children[children.length - 1]! };
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
    const config = resolveWrapperConfig("lab-pc-1.claude-a", parsed);
    expect(config).toEqual({
      agent_id: "lab-pc-1.claude-a",
      persona: spawnMsg.persona,
      server_url: spawnMsg.server_url,
      server_token: "tok",
    });
    expect("allowed_tools" in config).toBe(false);
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

  it("resume 付き spawn は現状 error で拒否(4-5 まで)", () => {
    const h = harness();
    h.sup.handleSpawn({ ...spawnMsg, resume_session_id: "s-1" });
    expect(h.children).toHaveLength(0);
    expect(h.results[0]).toMatchObject({ ok: false, reason: "error" });
  });

  it("二重 spawn は already_running で拒否", () => {
    const h = harness();
    h.sup.handleSpawn(spawnMsg);
    h.sup.handleSpawn(spawnMsg);
    expect(h.children).toHaveLength(1);
    expect(h.results[1]).toMatchObject({ ok: false, reason: "already_running" });
  });

  it("同期 launch 失敗を error で報告し slot を残さない", () => {
    const results: SpawnResult[] = [];
    let calls = 0;
    const sup = new Supervisor({
      hostId: "lab-pc-1",
      cwdAllowlist: allowlist,
      launch: () => {
        calls += 1;
        throw new Error("boom");
      },
      sendResult: (r) => results.push(r),
    });
    sup.handleSpawn(spawnMsg);
    expect(results[0]).toMatchObject({ ok: false, reason: "error" });
    // slot は残らないので再 spawn でき(already_running にならず)再度起動を試みる
    sup.handleSpawn(spawnMsg);
    expect(calls).toBe(2);
    expect(results[1]).toMatchObject({ ok: false, reason: "error" });
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
