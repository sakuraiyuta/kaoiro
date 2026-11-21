import "./isolation.setup";
// @vitest-environment jsdom
// phase-34 A12 (ADR-0057 F4/F4c): AgentDetail の permission panel を
// antigravity にも適用する。(1) network_access 行は
// ext.effective.network_access の値の有無だけで出し分ける、(2)
// ext.permission.enforcement === "advisory" のとき実効書込範囲バッジに
// 恒久表示、(3) 作業意図 (Claude permission_mode) スイッチャーは
// permAxes.enforcement === "mode" のときだけ表示する (round 2 MF-R2-6:
// ext.engine は display-only, ADR-0034 F3 — SANDBOX_AXIS_ENGINES という
// engine 名 allowlist も同じ違反だったため値駆動の判定に置き換えた)。
import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AgentDetail from "../src/lib/AgentDetail.svelte";
import { makeReactiveAgentDetailProps } from "./reactiveProps.svelte";
import { SessionEnumeration } from "../src/lib/sessionEnumeration";
import type { EngineCatalog, Envelope, HostInfo, KaoiroConnection } from "../src/lib/protocol";

const mounted: object[] = [];

beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
});

afterEach(async () => {
  for (const component of mounted.splice(0)) await unmount(component);
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

function connection(): KaoiroConnection {
  return {
    spawn: vi.fn(),
    enumerateSessions: vi.fn(),
    setModel: vi.fn(),
    setEffort: vi.fn(),
    refreshModels: vi.fn(async () => ({
      agent_id: "host-a.p",
      request_id: "test",
      ok: true,
      models_count: 0,
    })),
    refreshEngineCatalog: vi.fn(),
  } as unknown as KaoiroConnection;
}

function envelope(ext: Record<string, unknown>): Envelope {
  return {
    version: "0",
    agent_id: "host-a.p",
    ts: "2026-09-04T00:00:00Z",
    type: "state_change",
    state: "idle",
    payload: {},
    ext,
    persona: { id: "p", name: "P", sprite_set: "p" },
  };
}

async function render(ext: Record<string, unknown>) {
  const target = document.createElement("div");
  document.body.append(target);
  const component = mount(AgentDetail, {
    target,
    props: {
      envelope: envelope(ext),
      connection: connection(),
      onClose: vi.fn(),
    },
  });
  mounted.push(component);
  await tick();
  return target;
}

function rowByLabel(target: Element, label: string): HTMLElement | null {
  const dts = [...target.querySelectorAll("dt")];
  const dt = dts.find((node) => node.textContent?.trim() === label);
  return (dt?.nextElementSibling as HTMLElement | null) ?? null;
}

describe("AgentDetail permission panel — antigravity (phase-34 A12, ADR-0057 F4/F4c)", () => {
  it("antigravity + effective.network_access=true → network_access 行を出す (SANDBOX_AXIS_ENGINES 拡張)", async () => {
    const target = await render({
      engine: "antigravity",
      effective: { network_access: true },
      permission: { sandbox: "workspace-write", approval: "local" },
    });
    const dd = rowByLabel(target, "network_access");
    expect(dd).not.toBeNull();
    expect(dd?.textContent?.trim()).toBe("true");
  });

  it("antigravity + enforcement='advisory' → 実効書込範囲に恒久バッジを出す", async () => {
    const target = await render({
      engine: "antigravity",
      permission: {
        sandbox: "workspace-write",
        approval: "never",
        enforcement: "advisory",
      },
    });
    const dd = rowByLabel(target, "実効書込範囲");
    expect(dd).not.toBeNull();
    expect(dd?.textContent).toContain("advisory, wrapper enforced");
  });

  it("codex (enforcement 未 stamp) → advisory バッジは出ない", async () => {
    const target = await render({
      engine: "codex",
      permission: { sandbox: "workspace-write", approval: "never" },
    });
    const dd = rowByLabel(target, "実効書込範囲");
    expect(dd).not.toBeNull();
    expect(dd?.textContent).not.toContain("advisory");
    // Codex 固有の host-fixed バッジは維持される (回帰防止)。
    expect(dd?.textContent).toContain("host-fixed");
  });

  it("antigravity → 作業意図 (Claude permission_mode) スイッチャーを表示しない (A12 前の !isCodexAgent 回帰 pin)", async () => {
    const target = await render({
      engine: "antigravity",
      permission: { sandbox: "workspace-write", approval: "on-request" },
    });
    expect(rowByLabel(target, "作業意図")).toBeNull();
  });

  it("claude-code → 作業意図スイッチャーは引き続き表示される (既存挙動の非退行)", async () => {
    // issue #305: availability comes from the capability the Claude
    // adapter stamps from its first state_change, not from the absence of
    // permission data. The fixture mirrors that producer so this
    // non-regression pin keeps measuring Claude's picker rather than the
    // removed fail-open default.
    const target = await render({
      engine: "claude-code",
      session_capabilities: {
        supports_attachments: false,
        supports_user_input_dialog: true,
        supports_permission_mode_switch: true,
      },
    });
    expect(rowByLabel(target, "作業意図")).not.toBeNull();
  });

  it("未知 engine + enforcement='os' (launch-fixed) → 作業意図スイッチャーを表示しない (round 2 MF-R2-6 回帰 pin)", async () => {
    // engine 名の allowlist (SANDBOX_AXIS_ENGINES) には無い架空の engine。
    // permAxes.enforcement が "mode" 以外である以上、名前を知らなくても
    // launch-fixed と判定できることを確認する — 旧実装 (engine 名 allowlist)
    // ではここで意味のない「作業意図: default」が出ていた。
    const target = await render({
      engine: "future-engine",
      permission: {
        sandbox: "workspace-write",
        approval: "never",
        enforcement: "os",
      },
    });
    expect(rowByLabel(target, "作業意図")).toBeNull();
  });
});

describe("host-declared actions in AgentDetail", () => {
  const all = { version: 1, spawn: true, resume: true, enumerate_sessions: true } as const;
  function host(operations: EngineCatalog["operations"]): HostInfo {
    return { host_id: "host-a", personas: [], cwd_allowlist: [], capabilities: ["sample"],
      engines: [{ id: "sample", operations, models: [] }] };
  }

  async function mountDetail(engine = "sample", state: Envelope["state"] = "disconnected") {
    const conn = connection();
    conn.restore = vi.fn(async () => undefined);
    conn.enumerateAgentSessions = vi.fn(async () => undefined);
    conn.resumeSession = vi.fn(async () => undefined);
    const enumeration = new SessionEnumeration();
    const onSetPermission = vi.fn(async () => null);
    const caps = { supports_attachments: false, supports_user_input_dialog: false,
      supports_permission_switch: true, supports_permission_mode_switch: true };
    const initial = { envelope: { ...envelope({ engine, session_capabilities: caps,
      permission_mode: "default" }), state }, hosts: [host(all)], enumeration,
      detailActive: true, connection: conn, onClose: vi.fn(), onSetPermission };
    const props = makeReactiveAgentDetailProps(initial) as typeof initial;
    const target = document.createElement("div");
    document.body.append(target);
    mounted.push(mount(AgentDetail, { target, props }));
    await tick();
    return { target, props, conn, enumeration, onSetPermission };
  }

  it.each(["idle", "disconnected"] as const)("follows host history declarations while %s", async state => {
    const { props, target, conn } = await mountDetail("sample", state);
    for (const [flags, active, restore, picker] of [
      [{ spawn: true }, true, false, false],
      [{ enumerate_sessions: true }, true, false, true],
      [{}, true, false, false],
      [all, false, true, false],
      [all, true, true, true],
    ] as const) {
      props.hosts = [host({ ...flags, version: 1 })];
      props.detailActive = active;
      await tick();
      expect(!!target.querySelector("button.restore")).toBe(restore && state === "disconnected");
      expect(!!target.querySelector("button.resume-swap")).toBe(picker);
      expect(conn.restore).not.toHaveBeenCalled();
      expect(conn.resumeSession).not.toHaveBeenCalled();
    }
  });

  it.each([false, true])("rechecks restore at click time (withdraw=%s)", async withdraw => {
    const { props, target, conn } = await mountDetail();
    const button = target.querySelector<HTMLButtonElement>("button.restore")!;
    if (withdraw) props.hosts = [host({ version: 1, spawn: true })];
    button.click();
    await tick();
    expect(conn.restore).toHaveBeenCalledTimes(withdraw ? 0 : 1);
    if (!withdraw) expect(conn.restore).toHaveBeenCalledWith("host-a.p");
  });

  it.each([false, true])("rechecks the chosen session after confirmation (withdraw=%s)", async withdraw => {
    const { props, target, conn, enumeration } = await mountDetail("sample", "thinking");
    target.querySelector<HTMLButtonElement>("button.resume-swap")!.click();
    await tick();
    expect(conn.enumerateAgentSessions).toHaveBeenCalledWith("host-a.p");
    enumeration.receive({host_id: "host-a", engine: "sample", cwd: "/workspace",
      sessions: [{session_id: "saved"}]});
    const option = await vi.waitFor(() => {
      const button = target.querySelector<HTMLButtonElement>(".resume-menu button");
      expect(button?.textContent).toContain("saved");
      return button!;
    });
    const confirm = vi.spyOn(window, "confirm").mockImplementation(() => {
      if (withdraw) props.hosts = [host({version: 1, enumerate_sessions: true})];
      return true;
    });
    option.click();
    await tick();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(conn.resumeSession).toHaveBeenCalledTimes(withdraw ? 0 : 1);
    if (!withdraw) expect(conn.resumeSession).toHaveBeenCalledWith("host-a.p", "saved");
  });

  it.each([false, true])("keeps legacy Claude controls out of external details (external=%s)", async external => {
    const { props, target, onSetPermission } = await mountDetail("claude");
    expect(target.querySelector("button.restore")).not.toBeNull();
    expect(target.querySelector("button.resume-swap")).not.toBeNull();
    expect(rowByLabel(target, "作業意図")?.querySelector("button")).toBeTruthy();
    const sandbox = rowByLabel(target, "sandbox 変更")!;
    sandbox.querySelector<HTMLButtonElement>("button")!.click();
    await tick();
    const option = [...sandbox.querySelectorAll<HTMLButtonElement>('[role="option"]')]
      .find(button => button.textContent?.trim() === "read-only")!;
    expect(option.disabled).toBe(false);
    if (external) props.envelope = { ...props.envelope,
      ext: { ...props.envelope.ext, engine: "sample" } };
    option.click();
    await tick();
    expect(onSetPermission).toHaveBeenCalledTimes(external ? 0 : 1);
    if (external) {
      expect(rowByLabel(target, "sandbox 変更")).toBeNull();
      expect(rowByLabel(target, "作業意図")).toBeNull();
    } else {
      expect(onSetPermission).toHaveBeenCalledWith("host-a.p", { sandbox: "read-only" });
    }
  });
});
