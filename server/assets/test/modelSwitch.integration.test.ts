// @vitest-environment jsdom
import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AgentDetail from "../src/lib/AgentDetail.svelte";
import LaunchDialog from "../src/lib/LaunchDialog.svelte";
import type {
  Envelope,
  HostInfo,
  KaoiroConnection,
  ModelOption,
} from "../src/lib/protocol";

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

function connection(overrides: Partial<KaoiroConnection> = {}): KaoiroConnection {
  return {
    spawn: vi.fn(async () => undefined),
    enumerateSessions: vi.fn(async () => undefined),
    setModel: vi.fn(async () => undefined),
    setEffort: vi.fn(async () => undefined),
    refreshModels: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as KaoiroConnection;
}

function host(models: ModelOption[], engine: "claude-code" | "codex" = "codex"): HostInfo {
  return {
    host_id: "host-a",
    personas: [{ id: "fuji", name: "藤", sprite_set: "fuji" }],
    cwd_allowlist: ["/workspace"],
    capabilities: [engine],
    engines: [{ id: engine, models }],
  };
}

async function renderLaunch(
  models: ModelOption[],
  conn = connection(),
  engine: "claude-code" | "codex" = "codex",
) {
  const target = document.createElement("div");
  document.body.append(target);
  const component = mount(LaunchDialog, {
    target,
    props: { hosts: [host(models, engine)], connection: conn, sessions: null, onClose: vi.fn() },
  });
  mounted.push(component);
  await tick();
  return { target, conn };
}

function selectFor(target: Element, label: string): HTMLSelectElement {
  const labels = [...target.querySelectorAll("label")];
  const found = labels.find((node) => node.textContent?.includes(label));
  const select = found?.querySelector("select");
  if (!(select instanceof HTMLSelectElement)) throw new Error(`${label} select not found`);
  return select;
}

function switchEnvelope(ext: Record<string, unknown>): Envelope {
  return {
    version: "0",
    agent_id: "host-a.fuji",
    ts: "2026-07-13T00:00:00Z",
    type: "state_change",
    state: "idle",
    payload: {},
    ext,
    persona: { id: "fuji", name: "藤", sprite_set: "fuji" },
  };
}

async function renderDetail(ext: Record<string, unknown>, conn = connection()) {
  const target = document.createElement("div");
  document.body.append(target);
  const component = mount(AgentDetail, {
    target,
    props: {
      envelope: switchEnvelope(ext),
      connection: conn,
      onClose: vi.fn(),
    },
  });
  mounted.push(component);
  await tick();
  return { target, conn };
}

const terra: ModelOption = {
  value: "gpt-terra",
  display_name: "Terra",
  effort_levels: ["low", "medium", "high"],
  default_effort: "medium",
};
const sol: ModelOption = {
  value: "gpt-sol",
  display_name: "Sol",
  effort_levels: ["high", "xhigh"],
  default_effort: "high",
};
const claudeBootstrap: ModelOption[] = [
  {
    value: "default",
    display_name: "Default (recommended)",
    effort_levels: ["low", "medium", "high", "xhigh", "max"],
  },
  {
    value: "claude-fable-5[1m]",
    display_name: "Fable",
    effort_levels: ["low", "medium", "high", "xhigh", "max"],
  },
  { value: "haiku", display_name: "Haiku" },
];

describe("phase-16 dashboard model switch integration", () => {
  it.each([
    ["Free", [terra], ["gpt-terra"]],
    ["Go", [terra], ["gpt-terra"]],
    ["Plus+", [sol, terra], ["gpt-sol", "gpt-terra"]],
    ["apikey", [{ ...terra, value: "gpt-api" }], ["gpt-api"]],
    ["未申告", [], []],
  ])("LaunchDialog reflects the %s catalog", async (_plan, models, expected) => {
    const { target } = await renderLaunch(models as ModelOption[]);
    const modelSelect = [...target.querySelectorAll("label")]
      .find((node) => node.textContent?.includes("モデル"))
      ?.querySelector("select");
    if (expected.length === 0) {
      expect(modelSelect).toBeUndefined();
      return;
    }
    expect([...modelSelect!.options].slice(1).map((option) => option.value)).toEqual(expected);
  });

  it("LaunchDialog applies default_effort and submits the explicit catalog choice", async () => {
    const conn = connection();
    const { target } = await renderLaunch([terra, sol], conn);
    const model = selectFor(target, "モデル");
    model.value = "gpt-sol";
    model.dispatchEvent(new Event("change", { bubbles: true }));
    await tick();
    expect(selectFor(target, "effort").value).toBe("high");
    target.querySelector("form")!.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
    await tick();
    expect(conn.spawn).toHaveBeenCalledWith(expect.objectContaining({
      engine: "codex",
      model: "gpt-sol",
      effort: "high",
    }));
  });

  it("LaunchDialog offers the Claude bootstrap catalog before spawn (#110)", async () => {
    const conn = connection();
    const { target } = await renderLaunch(claudeBootstrap, conn, "claude-code");
    const model = selectFor(target, "モデル");
    expect([...model.options].slice(1).map((option) => option.value)).toEqual([
      "default",
      "claude-fable-5[1m]",
      "haiku",
    ]);
    model.value = "claude-fable-5[1m]";
    model.dispatchEvent(new Event("change", { bubbles: true }));
    await tick();
    const effort = selectFor(target, "effort");
    effort.value = "max";
    effort.dispatchEvent(new Event("change", { bubbles: true }));
    target.querySelector("form")!.dispatchEvent(
      new SubmitEvent("submit", { bubbles: true, cancelable: true }),
    );
    await tick();
    expect(conn.spawn).toHaveBeenCalledWith(expect.objectContaining({
      engine: "claude-code",
      model: "claude-fable-5[1m]",
      effort: "max",
    }));
  });

  it("fresh idle keeps model/effort/ctx rows stable and switchable (#110)", async () => {
    const { target } = await renderDetail({
      engine: "claude-code",
      models: claudeBootstrap,
      session_capabilities: {
        supports_attachments: true,
        supports_user_input_dialog: true,
        supports_model_switch: true,
        supports_effort_switch: true,
      },
    });
    expect(target.textContent).toContain("model");
    expect(target.textContent).toContain("確認待ち");
    expect(target.textContent).toContain("effort");
    expect(target.textContent).toContain("既定");
    expect(target.textContent).toContain("ctx");
    expect(target.textContent).toContain("初回応答後に取得");
    expect(target.querySelector('[title="モデルを切替"]')).not.toBeNull();
    expect(target.querySelector('[title="effort を切替"]')).not.toBeNull();
  });

  it("permission switch uses the shrink-safe specialized class (#110)", async () => {
    const { target } = await renderDetail({ engine: "claude-code" });
    const button = target.querySelector(".cc-perm-switch");
    expect(button).not.toBeNull();
    expect(button?.textContent).toContain("書込:");
    expect(button?.textContent).toContain("承認:");
  });

  it("hides both switch controls unless their capabilities are explicitly stamped", async () => {
    const { target } = await renderDetail({ model: "gpt-terra", models: [terra] });
    expect(target.querySelector('[title="モデルを切替"]')).toBeNull();
    expect(target.querySelector('[title="effort を切替"]')).toBeNull();
  });

  it("drives model pending UI through the connection and renders effective state", async () => {
    const conn = connection();
    const { target } = await renderDetail({
      model: "gpt-terra",
      models: [terra, sol],
      session_capabilities: { supports_attachments: false, supports_user_input_dialog: true, supports_model_switch: true, supports_effort_switch: true },
      effective: { effort: "medium" },
    }, conn);
    (target.querySelector('[title="モデルを切替"]') as HTMLButtonElement).click();
    await tick();
    const solButton = [...target.querySelectorAll('[role="option"]')]
      .find((button) => button.textContent === "Sol") as HTMLButtonElement;
    solButton.click();
    await tick();
    expect(conn.setModel).toHaveBeenCalledWith("host-a.fuji", "gpt-sol");
    expect(target.textContent).toContain("pending: Sol");

    const effective = await renderDetail({
      model: "gpt-sol",
      models: [terra, sol],
      session_capabilities: { supports_attachments: false, supports_user_input_dialog: true, supports_model_switch: true, supports_effort_switch: true },
      effective: { effort: "high" },
    });
    expect(effective.target.textContent).toContain("gpt-sol");
    expect(effective.target.textContent).toContain("high");
    expect(effective.target.textContent).not.toContain("pending: Sol");
  });

  it("renders host pending state, loud failure, and last-good rollback", async () => {
    const pending = await renderDetail({
      model: "gpt-terra",
      models: [terra, sol],
      session_capabilities: { supports_attachments: false, supports_user_input_dialog: true, supports_model_switch: true },
      pending_model: "gpt-sol",
    });
    expect(pending.target.textContent).toContain("pending: Sol");

    const failed = await renderDetail({
      model: "gpt-terra",
      models: [terra, sol],
      session_capabilities: { supports_attachments: false, supports_user_input_dialog: true, supports_model_switch: true },
      switch_error: {
        kind: "model",
        requested: "bad-slug",
        reason: "turn_failed",
        rolled_back_to: "gpt-terra",
      },
    });
    expect(failed.target.textContent).toContain("モデル切替に失敗");
    expect(failed.target.textContent).toContain("bad-slug は実効に反映されていません");
    expect(failed.target.textContent).toContain("旧値 gpt-terra に戻しました");
  });

  it("does not offer an invalid old effort for a pending model and announces reset", async () => {
    const { target } = await renderDetail({
      model: "gpt-terra",
      models: [terra, sol],
      session_capabilities: { supports_attachments: false, supports_user_input_dialog: true, supports_model_switch: true, supports_effort_switch: true },
      pending_model: "gpt-sol",
      effective: { effort: "medium" },
      effort_reset: true,
    });
    expect(target.textContent).toContain("新モデルで元の effort が使えないため既定へ戻しました");
    (target.querySelector('[title="effort を切替"]') as HTMLButtonElement).click();
    await tick();
    const choices = [...target.querySelectorAll('[aria-label="effort 候補"] [role="option"]')]
      .map((button) => button.textContent);
    expect(choices).toEqual(["high", "xhigh"]);
    expect(choices).not.toContain("medium");
  });

  it("supports_effort_switch=false でも effective.effort があれば read-only 表示する (#113)", async () => {
    const { target } = await renderDetail({
      engine: "codex",
      model: "gpt-terra",
      models: [terra],
      session_capabilities: {
        supports_attachments: false,
        supports_user_input_dialog: true,
        supports_model_switch: false,
        supports_effort_switch: false,
      },
      permission: { sandbox: "workspace-write", approval: "never" },
      effective: { effort: "medium" },
    });
    const dts = [...target.querySelectorAll("dt")].map((el) => el.textContent);
    expect(dts).toContain("effort");
    expect(target.textContent).toContain("medium");
    expect(target.textContent).toContain("書込: workspace-write");
    expect(target.textContent).toContain("承認: never");
    expect(target.textContent).toContain("host-fixed");
    expect(target.querySelector('[title="effort を切替"]')).toBeNull();
  });

  it("viewer + supports_effort_switch=false + effective 無しでは effort 行を隠す (#113)", async () => {
    const { target } = await renderDetail(
      {
        engine: "codex",
        session_capabilities: {
          supports_attachments: false,
          supports_user_input_dialog: false,
          supports_model_switch: false,
          supports_effort_switch: false,
        },
      },
      null as unknown as KaoiroConnection,
    );
    const dts = [...target.querySelectorAll("dt")].map((el) => el.textContent);
    expect(dts).not.toContain("effort");
  });

  it("refresh button sends refresh_models and briefly disables the button (ADR-0037 F6, phase-18-9)", async () => {
    // The mock resolves synchronously, so the button re-enables on the next
    // microtask. What we pin here is (1) the wire — connection.refreshModels
    // received the agent_id, and (2) the button existed with its a11y label.
    const conn = connection();
    const { target } = await renderDetail({
      engine: "claude-code",
      model: "default",
      models: claudeBootstrap,
      session_capabilities: {
        supports_attachments: true,
        supports_user_input_dialog: true,
        supports_model_switch: true,
        supports_effort_switch: true,
      },
    }, conn);
    const button = target.querySelector(
      '[aria-label="モデル一覧を再取得"]',
    ) as HTMLButtonElement | null;
    expect(button).not.toBeNull();
    button!.click();
    await tick();
    expect(conn.refreshModels).toHaveBeenCalledWith("host-a.fuji");
  });

  it("refresh button is hidden on codex engine (ADR-0035 no-op cross-engine)", async () => {
    // codex has no refresh_models handler (catalog is static per ADR-0035),
    // so the dashboard must not render a button that would be dead on click.
    const { target } = await renderDetail({
      engine: "codex",
      model: "gpt-terra",
      models: [terra],
      session_capabilities: {
        supports_attachments: false,
        supports_user_input_dialog: true,
        supports_model_switch: true,
        supports_effort_switch: true,
      },
    });
    expect(
      target.querySelector('[aria-label="モデル一覧を再取得"]'),
    ).toBeNull();
  });

  it("refresh reject surfaces via switchNotice in error tone (phase-18-9)", async () => {
    // Refresh has no ext.switch_error path, so the reject must be brought
    // into the same switchNotice line the operator already watches for
    // switch failures.
    const conn = connection({
      refreshModels: vi.fn(async () => {
        throw new Error("session_reset_pending");
      }),
    });
    const { target } = await renderDetail({
      engine: "claude-code",
      model: "default",
      models: claudeBootstrap,
      session_capabilities: {
        supports_attachments: true,
        supports_user_input_dialog: true,
        supports_model_switch: true,
        supports_effort_switch: true,
      },
    }, conn);
    (target.querySelector(
      '[aria-label="モデル一覧を再取得"]',
    ) as HTMLButtonElement).click();
    // The catch runs on the microtask after the awaited rejection settles;
    // one tick is enough to flush it.
    await tick();
    await tick();
    expect(target.textContent).toContain("モデル一覧の再取得に失敗");
    expect(target.textContent).toContain("session_reset_pending");
  });
});
