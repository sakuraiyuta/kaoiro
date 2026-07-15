// @vitest-environment jsdom
import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AgentDetail from "../src/lib/AgentDetail.svelte";
import LaunchDialog from "../src/lib/LaunchDialog.svelte";
import { makeReactiveAgentDetailProps } from "./reactiveProps.svelte";
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
    // ADR-0039 F9 v2 = 藤 review turn-10 must-fix 3: refreshModels now
    // returns a Promise<RefreshModelsResult>; stubbing undefined would let
    // `result.ok` access throw and be silently caught as "success". Return
    // a well-shaped result so the tested behaviour is real.
    refreshModels: vi.fn(async () => ({
      agent_id: "host-a.fuji",
      request_id: "test-req",
      ok: true,
      models_count: 0,
    })),
    // Kept for backwards compat of Codex path tests; Claude uses
    // refreshModels only in v2 (refreshEngineCatalog is not called).
    refreshEngineCatalog: vi.fn(async () => ({
      host_id: "host-a",
      engine: "claude-code",
      request_id: "test-req",
      ok: true,
      models_count: 0,
    })),
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

  it("refresh button は result 到着まで disabled、成功で再有効化 (藤 review turn-10 must-fix 3)", async () => {
    // Deferred: 手動で resolve するまで refreshModels() が settle しない
    // → button loading が最後まで維持されることを pin。
    type RefreshResult = {
      agent_id: string;
      request_id: string;
      ok: boolean;
      models_count?: number;
    };
    let resolveRefresh: (r: RefreshResult) => void = () => {};
    const conn = connection({
      refreshModels: (async () =>
        new Promise<RefreshResult>((resolve) => {
          resolveRefresh = resolve;
        })) as unknown as (agentId: string) => Promise<RefreshResult>,
    });
    const { target } = await renderDetail(
      {
        engine: "claude-code",
        model: "default",
        models: claudeBootstrap,
        session_capabilities: {
          supports_attachments: true,
          supports_user_input_dialog: true,
          supports_model_switch: true,
          supports_effort_switch: true,
        },
      },
      conn,
    );
    const btn = () =>
      target.querySelector(
        '[aria-label="モデル一覧を再取得"]',
      ) as HTMLButtonElement | null;
    btn()!.click();
    await tick();
    // Ack fired but result not yet arrived: button stays disabled.
    expect(btn()?.disabled).toBe(true);
    resolveRefresh({
      agent_id: "host-a.fuji",
      request_id: "req-1",
      ok: true,
      models_count: 3,
    });
    // Two ticks: microtask + svelte reactivity.
    await tick();
    await tick();
    expect(btn()?.disabled).toBe(false);
  });

  it("refresh failure reason は switchNotice error 表示 (藤 review turn-10 must-fix 3)", async () => {
    const conn = connection({
      refreshModels: vi.fn(async () => ({
        agent_id: "host-a.fuji",
        request_id: "req-fail",
        ok: false,
        reason: "auth_failed",
      })),
    });
    const { target } = await renderDetail(
      {
        engine: "claude-code",
        model: "default",
        models: claudeBootstrap,
        session_capabilities: {
          supports_attachments: true,
          supports_user_input_dialog: true,
          supports_model_switch: true,
          supports_effort_switch: true,
        },
      },
      conn,
    );
    const btn = target.querySelector(
      '[aria-label="モデル一覧を再取得"]',
    ) as HTMLButtonElement | null;
    btn!.click();
    // microtask + reactivity
    await tick();
    await tick();
    const notice = target.textContent ?? "";
    expect(notice).toContain("auth_failed");
  });

  it("refresh button click 後、reactive envelope 更新で default-only → rich models へ遷移し effort 切替 button が出る (藤 review turn-13 追加指示)", async () => {
    // 同じ mount 済み AgentDetail 上で:
    // 1) 初期は models=[default] のみで effort_levels 空 → effort 切替 button 非表示
    // 2) refresh button click で refreshingModels=true (button disabled)
    // 3) wrapper からの state_change (envelope 更新) が rich models +
    //    supports_effort_switch=true を持って先に到達 → 選択肢が増え、
    //    active model の effort_levels により effort 切替 button が出る
    // 4) その後 refresh_models_result が Promise を resolve するが、
    //    completion result envelope 自体は AgentDetail の generic state に
    //    入らない (wrapper/agents_channel の gating 契約) 前提で、UI 側は
    //    button の disabled 解除だけが起きる
    let resolveRefresh: (r: {
      agent_id: string;
      request_id: string;
      ok: boolean;
      models_count?: number;
    }) => void = () => {};
    const conn = connection({
      refreshModels: (async () =>
        new Promise((resolve) => {
          resolveRefresh = resolve;
        })) as unknown as (agentId: string) => Promise<{
        agent_id: string;
        request_id: string;
        ok: boolean;
        models_count?: number;
      }>,
    });

    // 初期: default-only、effort_levels 未提供 → supports_effort_switch=false
    // (wrapper 側 host.ts が active model の effort_levels 有無で narrow)。
    const defaultOnlyEnv: Envelope = switchEnvelope({
      engine: "claude-code",
      model: "default",
      models: [{ value: "default", display_name: "Default" }],
      session_capabilities: {
        supports_attachments: true,
        supports_user_input_dialog: true,
        supports_model_switch: true,
        supports_effort_switch: false,
      },
    });

    const target = document.createElement("div");
    document.body.append(target);
    const props = makeReactiveAgentDetailProps({
      envelope: defaultOnlyEnv,
      connection: conn,
      onClose: vi.fn(),
    });
    const component = mount(AgentDetail, { target, props });
    mounted.push(component);
    await tick();

    // Pre-refresh: effort 切替 button 非表示。model 切替 button は存在。
    expect(target.querySelector('[title="effort を切替"]')).toBeNull();
    const modelBtn = target.querySelector(
      '[title="モデルを切替"]',
    ) as HTMLButtonElement | null;
    expect(modelBtn).not.toBeNull();
    // 選択肢を開いて 1 件しかないことを確認、閉じる。
    modelBtn!.click();
    await tick();
    let options = [...target.querySelectorAll('[role="option"]')].map(
      (n) => n.textContent,
    );
    expect(options).toEqual(["Default"]);
    modelBtn!.click();
    await tick();

    // Refresh を発火 (完了は保留、button disabled のまま)。
    const refreshBtn = target.querySelector(
      '[aria-label="モデル一覧を再取得"]',
    ) as HTMLButtonElement;
    expect(refreshBtn).not.toBeNull();
    refreshBtn.click();
    await tick();
    expect(refreshBtn.disabled).toBe(true);

    // Wrapper が rich models を stamp した state_change を先に emit する経路
    // (ADR-0039 F9 v2 = 藤 review turn-7 D2a)。AgentDetail に届く形は envelope
    // の reactive 差替え。effort_levels を active model が持つので、
    // supports_effort_switch も true に narrow される。
    props.envelope = switchEnvelope({
      engine: "claude-code",
      model: "default",
      models: [
        {
          value: "default",
          display_name: "Default",
          effort_levels: ["low", "medium", "high"],
        },
        {
          value: "sonnet",
          display_name: "Sonnet",
          effort_levels: ["low", "medium", "high", "xhigh"],
        },
        { value: "haiku", display_name: "Haiku", effort_levels: ["low", "medium"] },
      ],
      session_capabilities: {
        supports_attachments: true,
        supports_user_input_dialog: true,
        supports_model_switch: true,
        supports_effort_switch: true,
      },
    });
    await tick();

    // effort 切替 button が現れる。
    expect(target.querySelector('[title="effort を切替"]')).not.toBeNull();

    // Model dropdown を再度開くと選択肢が増えている。
    const modelBtnAfter = target.querySelector(
      '[title="モデルを切替"]',
    ) as HTMLButtonElement;
    modelBtnAfter.click();
    await tick();
    options = [...target.querySelectorAll('[role="option"]')]
      .filter((n) => n.closest('[aria-label="モデル候補"]') !== null)
      .map((n) => n.textContent);
    expect(options).toEqual(["Default", "Sonnet", "Haiku"]);

    // 対の refresh_models_result が最後に Promise を settle。completion result
    // envelope 自体は refresh_models_result type で、agents_channel の allow-list
    // gating (:viewer drop / :operator forward) と wrapper_channel の非 store
    // 契約により generic state slot には反映されない。ここでは UI 面で
    // refresh button の disabled 解除のみが起きることを pin する。
    resolveRefresh({
      agent_id: "host-a.fuji",
      request_id: "req-e2e",
      ok: true,
      models_count: 3,
    });
    await tick();
    await tick();
    expect(refreshBtn.disabled).toBe(false);
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

  it("ext.models_error は switchNotice と ↻ button の error class を同時に立てる (ADR-0037 F6, phase-18-10)", async () => {
    // The transient switchNotice fires once via a rising-edge tracker; the
    // persistent .cc-refresh-error class stays for the whole duration
    // ext.models_error is true, so the operator can still see the degraded
    // state after any unrelated click clears switchNotice. ふじ の 18-10 監督
    // で最も重要な穴 (清算後 silent 化) はこの class binding で塞がれる。
    const { target } = await renderDetail({
      engine: "claude-code",
      model: "default",
      models: claudeBootstrap,
      models_error: true,
      session_capabilities: {
        supports_attachments: true,
        supports_user_input_dialog: true,
        supports_model_switch: true,
        supports_effort_switch: true,
      },
    });
    expect(target.textContent).toContain("モデル一覧の取得に繰り返し失敗");
    const button = target.querySelector(
      '[aria-label="モデル一覧を再取得"]',
    ) as HTMLButtonElement;
    expect(button.classList.contains("cc-refresh-error")).toBe(true);
  });

  it("ext.models_error 無しの状態では error class も switchNotice も立たない (phase-18-10 negative)", async () => {
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
    });
    expect(target.textContent).not.toContain("モデル一覧の取得に繰り返し失敗");
    const button = target.querySelector(
      '[aria-label="モデル一覧を再取得"]',
    ) as HTMLButtonElement;
    expect(button.classList.contains("cc-refresh-error")).toBe(false);
  });

  it("persist_alias_unknown は info tone で自動 fallback 用の文面へ (ADR-0037 F8, phase-18-10)", async () => {
    // The persist-alias validation (18-7) surfaces via switch_error with
    // reason=persist_alias_unknown. It is a startup silent-fallback, not an
    // operator-initiated switch failure — the message must reflect that.
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
      switch_error: {
        kind: "model",
        requested: "opus[1m]",
        reason: "persist_alias_unknown",
        rolled_back_to: "default",
      },
    });
    expect(target.textContent).toContain("保存されていた opus[1m] は現在の catalog にないので default で開始しました");
    // Info tone: no "モデル切替に失敗" (that phrasing stays for genuine
    // operator-initiated failures like turn_failed).
    expect(target.textContent).not.toContain("モデル切替に失敗");
    // The switch-notice row must render in the .switch-notice container
    // WITHOUT the .error modifier so the tone reads as info visually.
    const notice = target.querySelector(".switch-notice");
    expect(notice?.classList.contains("error")).toBe(false);
  });

  it("codex engine には models_error 通知も class も届かない (cross-engine, phase-18-10)", async () => {
    // Same negative surface as 18-9's button-hidden test, but for the toast
    // path — the effect gates naturally because host derive is Claude-only.
    const { target } = await renderDetail({
      engine: "codex",
      model: "gpt-terra",
      models: [terra],
      models_error: true,
      session_capabilities: {
        supports_attachments: false,
        supports_user_input_dialog: true,
        supports_model_switch: true,
        supports_effort_switch: true,
      },
    });
    expect(target.textContent).not.toContain("モデル一覧の取得に繰り返し失敗");
    // Refresh button itself is hidden (18-9 gate); the class question is
    // moot but we still assert absence to catch any accidental leak.
    expect(target.querySelector(".cc-refresh-error")).toBeNull();
  });

  it("LaunchDialog は縮小 BOOTSTRAP (default 1 エントリ) でも spawn まで到達する (ADR-0037 F1, phase-18-11)", async () => {
    // Phase 18-3 shrank the wrapper BOOTSTRAP to just `default`. This test
    // pins that the dashboard's launch flow keeps working with that shape:
    // the model select renders with the single option, effort_levels are
    // taken from the entry, and spawn receives model="default".
    const shrunk: ModelOption[] = [
      {
        value: "default",
        display_name: "Default (recommended)",
        effort_levels: ["low", "medium", "high", "xhigh", "max"],
      },
    ];
    const conn = connection();
    const { target } = await renderLaunch(shrunk, conn, "claude-code");
    const model = selectFor(target, "モデル");
    expect([...model.options].slice(1).map((o) => o.value)).toEqual(["default"]);
    model.value = "default";
    model.dispatchEvent(new Event("change", { bubbles: true }));
    await tick();
    // effort select is present with the FULL_EFFORT levels the entry carries.
    const effort = selectFor(target, "effort");
    expect([...effort.options].slice(1).map((o) => o.value)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    effort.value = "high";
    effort.dispatchEvent(new Event("change", { bubbles: true }));
    target
      .querySelector("form")!
      .dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
    await tick();
    expect(conn.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        engine: "claude-code",
        model: "default",
        effort: "high",
      }),
    );
  });

  it("LaunchDialog は codex の空 catalog でも spawn まで到達する (?? [] fallback, ADR-0035 F1, phase-18-11)", async () => {
    // codex returns [] for unknown-auth / no-plan hosts (ADR-0035 F1). The
    // dashboard's ?? [] fallback (engineModels / effortLevels) must let the
    // launch complete with no model / effort selection. The spawn payload
    // OMITS model and effort (conditional-spread in LaunchDialog:168-169),
    // NOT sends empty string — so both fields must be absent, not "".
    const conn = connection();
    const { target } = await renderLaunch([], conn, "codex");
    // Model / effort selects are hidden when the catalog is empty
    // (LaunchDialog:272 / 284 gate on length > 0).
    expect(
      [...target.querySelectorAll("label")].find((n) =>
        n.textContent?.includes("モデル"),
      ),
    ).toBeUndefined();
    expect(
      [...target.querySelectorAll("label")].find(
        (n) => n.textContent?.trim() === "effort",
      ),
    ).toBeUndefined();
    target
      .querySelector("form")!
      .dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
    await tick();
    expect(conn.spawn).toHaveBeenCalledTimes(1);
    const spawnArg = (conn.spawn as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(spawnArg).toMatchObject({ engine: "codex" });
    // Field-omission pin: neither model nor effort must reach the wire,
    // so the wrapper falls through to its own engine default.
    expect(spawnArg).not.toHaveProperty("model");
    expect(spawnArg).not.toHaveProperty("effort");
  });

  it("models_error の toggle (false→true→false→true) で switchNotice が 2 回 fire (rising-edge, phase-18-12 A1)", async () => {
    // Phase 18-10 could pin the initial rising-edge fire but NOT the
    // second fire after a manual retry succeeded and the wrapper's next
    // catalog fetch failed again — mount() with a static props object
    // never re-runs the AgentDetail effect on prop changes. This test
    // closes that gap by driving a $state proxy through a .svelte.ts
    // harness (see reactiveProps.svelte.ts) so the effect DOES observe
    // the transitions within a single component instance. ふじ 18-10
    // 監督で最重要と指定された穴を e2e で塞ぐ (18-12 A1)。
    const buildEnv = (modelsError: boolean): Envelope => ({
      ...switchEnvelope({
        engine: "claude-code",
        model: "default",
        models: claudeBootstrap,
        session_capabilities: {
          supports_attachments: true,
          supports_user_input_dialog: true,
          supports_model_switch: true,
          supports_effort_switch: true,
        },
        models_error: modelsError,
      }),
      // ts varies between the two states so an observer that keys on ts
      // (e.g. a would-be state_change log) sees distinct events. It is
      // NOT what drives $effect re-runs — Svelte's rune reactivity keys
      // on the boolean models_error value itself, which changes here.
      ts: `2026-07-13T00:00:0${modelsError ? "1" : "0"}Z`,
    });
    const target = document.createElement("div");
    document.body.append(target);
    const props = makeReactiveAgentDetailProps({
      envelope: buildEnv(false),
      connection: connection(),
      onClose: vi.fn(),
    });
    const component = mount(AgentDetail, { target, props });
    mounted.push(component);
    await tick();
    // Initial: models_error=false → notice absent.
    expect(target.textContent).not.toContain("モデル一覧の取得に繰り返し失敗");

    // First rising edge: false → true fires the notice.
    props.envelope = buildEnv(true);
    await tick();
    expect(target.textContent).toContain("モデル一覧の取得に繰り返し失敗");

    // Persistent-surface pin: the .cc-refresh-error class must be present
    // while models_error is true, regardless of whether switchNotice is
    // still on screen (this is the fix ふじ demanded in 18-10).
    const button = target.querySelector(
      '[aria-label="モデル一覧を再取得"]',
    ) as HTMLButtonElement;
    expect(button.classList.contains("cc-refresh-error")).toBe(true);

    // Click the ↻ button — refreshModels() sets switchNotice = null.
    // Without this explicit clear, the assertion after the second rising
    // edge below could not distinguish "notice re-appeared" from "the
    // first fire's text lingered in the DOM". This click is what makes
    // the sawModelsError re-fire genuinely observable — pinning what
    // 18-10 could not (ふじ 18-10 監督で最重要と指定された gap を塞ぐ)。
    button.click();
    await tick();
    expect(target.textContent).not.toContain(
      "モデル一覧の取得に繰り返し失敗",
    );

    // Falling edge (true → false): tracker auto-resets via saw = err at
    // the end of the effect. No new fire on this transition.
    props.envelope = buildEnv(false);
    await tick();
    expect(target.textContent).not.toContain(
      "モデル一覧の取得に繰り返し失敗",
    );

    // Second rising edge: false → true again — the tracker resets on the
    // falling edge, so this transition MUST re-fire the notice. This is
    // the mandate ふじ set in 18-10: retry succeeded then cap again →
    // the operator must see the alert a second time.
    props.envelope = buildEnv(true);
    await tick();
    expect(target.textContent).toContain("モデル一覧の取得に繰り返し失敗");

    // Prove reactivity of the harness itself: model change through props
    // MUST propagate to the mounted component, otherwise this test would
    // pass trivially even if $effect never re-ran. The class binding
    // reads `modelsError` derived from `envelope.ext.models_error` — if
    // the harness is broken, the class would be stuck at its initial
    // state (false → no cc-refresh-error class), which the assertions
    // above would fail.
    props.envelope = buildEnv(false);
    await tick();
    expect(button.classList.contains("cc-refresh-error")).toBe(false);
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
