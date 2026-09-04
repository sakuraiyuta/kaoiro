// @vitest-environment jsdom
// phase-34 A12 (ADR-0057 F4/F4c): AgentDetail の permission panel を
// antigravity にも適用する。(1) network_access 行の engine gate を
// SANDBOX_AXIS_ENGINES (codex/antigravity) に拡張、(2)
// ext.permission.enforcement === "advisory" のとき実効書込範囲バッジに
// 恒久表示、(3) 作業意図 (Claude permission_mode) スイッチャーは
// hasSandboxAxis で非表示にする — A12 実装前は `!isCodexAgent` だったため
// antigravity で意味のない「作業意図: default」が出ていた回帰の pin。
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
      permission: { sandbox: "workspace-write", approval: "on-request" },
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
    const target = await render({ engine: "claude-code" });
    expect(rowByLabel(target, "作業意図")).not.toBeNull();
  });
});
