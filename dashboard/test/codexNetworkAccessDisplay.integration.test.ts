// @vitest-environment jsdom
// issue #118: Codex 固有の ext.effective.network_access (true|false) を
// AgentDetail 左ペインに表示することを検証する。gate は
// permissionModeSwitchable (ext.permission.enforcement が "mode" かどうか)
// と typeof boolean の二重防御 — false を落とさず、launch-fixed でない
// engine や absent/不正値は行そのものを非表示にする (fail-closed)。
// enforcement は実際の host が effective.network_access と同時に stamp
// する field なので、fixture も両方を揃えて envelope の実形を再現する
// (round 2 MF-R2-6: ext.engine 名ではなく値で判定する)。
import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AgentDetail from "../src/lib/AgentDetail.svelte";
import type { Envelope, KaoiroConnection } from "../src/lib/protocol";

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
    ts: "2026-07-17T00:00:00Z",
    type: "state_change",
    state: "idle",
    payload: {},
    ext,
    persona: { id: "p", name: "P", sprite_set: "p" },
  };
}

async function render(
  ext: Record<string, unknown>,
  options: { connection?: KaoiroConnection | null } = {},
) {
  const target = document.createElement("div");
  document.body.append(target);
  const conn =
    options.connection === undefined ? connection() : options.connection;
  const component = mount(AgentDetail, {
    target,
    props: {
      envelope: envelope(ext),
      connection: conn,
      onClose: vi.fn(),
    },
  });
  mounted.push(component);
  await tick();
  return target;
}

function networkRow(target: Element): HTMLElement | null {
  const dts = [...target.querySelectorAll("dt")];
  const dt = dts.find((node) => node.textContent?.trim() === "network_access");
  return (dt?.nextElementSibling as HTMLElement | null) ?? null;
}

function ccPanel(target: Element): HTMLElement | null {
  return target.querySelector("dl.cc");
}

// Real hosts stamp `permission` and `effective.network_access` from the
// same call (effectiveStatusEnvelopeFields), so fixtures carry both —
// isolating network_access alone would test a shape no real envelope has.
function codexPermission() {
  return { sandbox: "workspace-write", approval: "never", enforcement: "os" as const };
}

function claudePermission() {
  return {
    sandbox: "workspace-write",
    approval: "on-request",
    enforcement: "mode" as const,
  };
}

describe("AgentDetail network_access row (issue #118)", () => {
  it("codex + effective.network_access=true → 行を出し値 'true' を表示", async () => {
    const target = await render({
      engine: "codex",
      permission: codexPermission(),
      effective: { network_access: true },
    });
    const dd = networkRow(target);
    expect(dd).not.toBeNull();
    expect(dd?.textContent?.trim()).toBe("true");
  });

  it("codex + effective.network_access=false → 行を出し値 'false' を表示 (false を落とさない)", async () => {
    const target = await render({
      engine: "codex",
      permission: codexPermission(),
      effective: { network_access: false },
    });
    const dd = networkRow(target);
    expect(dd).not.toBeNull();
    expect(dd?.textContent?.trim()).toBe("false");
  });

  it("claude-code + effective.network_access=true → 行そのものを非表示 (permissionModeSwitchable gate)", async () => {
    // 他 engine が誤って stamp しても、permission.enforcement が "mode" な
    // ら (Claude の実際の stamp) permissionModeSwitchable gate で行が出ない。
    const target = await render({
      engine: "claude-code",
      permission: claudePermission(),
      effective: { network_access: true },
    });
    expect(networkRow(target)).toBeNull();
  });

  it("codex + effective に network_access field なし → 行を非表示", async () => {
    // rolling upgrade / 部分 stamp の想定。typeof gate で null になり非表示。
    const target = await render({
      engine: "codex",
      permission: codexPermission(),
      effective: { sandbox: "workspace-write" },
    });
    expect(networkRow(target)).toBeNull();
  });

  it("codex + effective.network_access が boolean 以外 → 行を非表示 (fail-closed)", async () => {
    // 文字列 "true" などの不正型は typeof boolean gate で落とす。
    const target = await render({
      engine: "codex",
      permission: codexPermission(),
      effective: { network_access: "true" },
    });
    expect(networkRow(target)).toBeNull();
  });

  // 藤 R1 regression pin: hasCcStatus が network_access 単独で panel 開扉に
  // 効くこと、および launch-fixed でない engine の誤 stamp が panel を開か
  // ないこと。connection=null で ccPermissionMode/models/rate 等が全て空
  // でも network_access 単独が panel 判定に効くかを分離検証する。

  it("codex network-only + connection=null → row と .cc panel の両方が出る", async () => {
    // hasCcStatus の effectiveNetworkAccess 条件がなければ、connection=null
    // + 他 field 全欠落の状態で panel は開かず row も見えなくなる。
    const target = await render(
      {
        engine: "codex",
        permission: codexPermission(),
        effective: { network_access: true },
      },
      { connection: null },
    );
    const dd = networkRow(target);
    expect(dd).not.toBeNull();
    expect(dd?.textContent?.trim()).toBe("true");
    expect(ccPanel(target)).not.toBeNull();
  });

  it("claude-code 誤 stamp + connection=null → .cc panel を開かない (R1 gate, round 2 で値駆動に置換)", async () => {
    // 他 engine が boolean を誤 stamp した状態を再現。derive の
    // permissionModeSwitchable (permission.enforcement === "mode") gate で
    // effectiveNetworkAccess が null に落ちるため hasCcStatus は false、
    // panel 全体が開かない。行だけ隠して panel 構造に影響を残す旧実装を
    // この test で pin する。
    const target = await render(
      {
        engine: "claude-code",
        permission: claudePermission(),
        effective: { network_access: true },
      },
      { connection: null },
    );
    expect(networkRow(target)).toBeNull();
    expect(ccPanel(target)).toBeNull();
  });
});
