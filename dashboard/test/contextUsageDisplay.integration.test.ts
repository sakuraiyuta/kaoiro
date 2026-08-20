// @vitest-environment jsdom
// ADR-0040 phase-21: AgentDetail の ctx 行が supports_context_usage capability
// で pending / meter / unsupported / hidden を fail-closed に分岐することを
// 検証する。engine 名分岐禁止 (ADR-0034 F3) — capability だけで判定する。
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
    ts: "2026-07-16T00:00:00Z",
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

function ctxRow(target: Element): HTMLElement | null {
  const dts = [...target.querySelectorAll("dt")];
  const dt = dts.find((node) => node.textContent?.trim() === "ctx");
  return (dt?.nextElementSibling as HTMLElement | null) ?? null;
}

describe("AgentDetail ctx row (ADR-0040 phase-21)", () => {
  it("supports_context_usage=true + 値なし → 「取得中」placeholder を出す", async () => {
    const target = await render({
      session_capabilities: {
        supports_attachments: true,
        supports_user_input_dialog: true,
        supports_context_usage: true,
      },
    });
    const dd = ctxRow(target);
    expect(dd?.textContent).toContain("取得中");
    // 未対応 が誤って混入していないこと (M-B 契約: true+null は取得中のみ)
    expect(dd?.textContent).not.toContain("未対応");
    // meter の visual primitive は出ない
    expect(dd?.querySelector(".meter")).toBeNull();
  });

  it("旧 wrapper の context 3-field だけでも生窓比を分母名付きで出す", async () => {
    const target = await render({
      session_capabilities: {
        supports_attachments: true,
        supports_user_input_dialog: true,
        supports_context_usage: true,
      },
      context: {
        used_tokens: 5000,
        max_tokens: 200000,
        used_percentage: 3,
      },
    });
    const dd = ctxRow(target);
    const fill = dd?.querySelector(".meter-fill") as HTMLElement | null;
    expect(fill).not.toBeNull();
    expect(fill?.style.width).toBe("3%");
    expect(dd?.textContent).toContain("生窓 3%");
    // context_budget を知らない旧 wrapper の作業予算を UI で推測しない。
    expect(dd?.textContent).not.toContain("作業予算");
    // 取得中 / 未対応 の placeholder は出ない
    expect(dd?.textContent).not.toContain("取得中");
    expect(dd?.textContent).not.toContain("未対応");
  });

  it("作業予算があれば token 分母と 100%超の予算比を併記する (#264)", async () => {
    const target = await render({
      session_capabilities: {
        supports_attachments: true,
        supports_user_input_dialog: true,
        supports_context_usage: true,
      },
      context: {
        used_tokens: 150000,
        max_tokens: 200000,
        used_percentage: 75,
      },
      context_budget: {
        work_budget_tokens: 100000,
        work_budget_percentage: 150,
      },
    });
    const dd = ctxRow(target);
    expect(dd?.querySelector(".meter-fill")?.getAttribute("style")).toContain(
      "width: 75%",
    );
    expect(dd?.textContent).toContain("生窓 75%");
    expect(dd?.textContent).toContain("(150k/200k)");
    expect(dd?.textContent).toContain("作業予算 150%");
    expect(dd?.textContent).toContain("(150k/100k)");
  });

  it("不正な作業予算分母は隠し、生窓表示を壊さない (#264)", async () => {
    const target = await render({
      session_capabilities: {
        supports_attachments: true,
        supports_user_input_dialog: true,
        supports_context_usage: true,
      },
      context: {
        used_tokens: 5000,
        max_tokens: 200000,
        used_percentage: 3,
      },
      context_budget: {
        work_budget_tokens: 0,
        work_budget_percentage: 5,
      },
    });
    const dd = ctxRow(target);
    expect(dd?.textContent).toContain("生窓 3%");
    expect(dd?.textContent).not.toContain("作業予算");
  });

  it("supports_context_usage=false → 「未対応」を出す (Codex 相当)", async () => {
    const target = await render({
      session_capabilities: {
        supports_attachments: false,
        supports_user_input_dialog: true,
        supports_context_usage: false,
      },
    });
    const dd = ctxRow(target);
    expect(dd?.textContent).toContain("未対応");
    // 「取得中」に fall back していないこと (M-B: false は unsupported)
    expect(dd?.textContent).not.toContain("取得中");
    expect(dd?.querySelector(".meter")).toBeNull();
  });

  it("supports_context_usage 未 stamp (旧 wrapper) → ctx 行そのものを非表示", async () => {
    // 旧 wrapper の rolling upgrade を想定: capability envelope は
    // 揃っているが supports_context_usage field 自体が absent。
    // fail-closed で「未対応」表示するのは誤り (M-B) — 行そのものを隠す。
    const target = await render({
      session_capabilities: {
        supports_attachments: true,
        supports_user_input_dialog: true,
      },
    });
    expect(ctxRow(target)).toBeNull();
  });

  it("session_capabilities 完全 absent (更に古い envelope) → ctx 行そのものを非表示", async () => {
    // sessionCapabilitiesFrom が null を返す最も古い経路。engine 名で判定
    // すれば Claude だと meter を出せてしまうが、capability-only 契約に
    // 従い ここでも fail-closed で行を隠す。
    const target = await render({
      model: "claude-x",
      cwd: "/repo",
    });
    expect(ctxRow(target)).toBeNull();
  });
});
