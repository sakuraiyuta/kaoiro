// @vitest-environment jsdom
// issue #287: App.svelte's own half of the sticky error badge — setting
// unackedErrorKey when an is_error result envelope arrives, and clearing it
// (ack) when the operator opens that agent's detail. AgentCard's rendering
// of hasUnackedError is pinned separately in
// agentCardUnackedError.integration.test.ts; this file pins the wiring
// that feeds it. Mirrors appAgentStripPresetWiring.integration.test.ts's
// connectKaoiro mock harness (module-scope, so it lives in its own file).
import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Envelope, KaoiroHandlers } from "../src/lib/protocol";

const captured = vi.hoisted(() => ({
  handlers: null as KaoiroHandlers | null,
}));

vi.mock("../src/lib/protocol", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/lib/protocol")>();
  return {
    ...actual,
    connectKaoiro: (_url: string, handlers: KaoiroHandlers) => {
      captured.handlers = handlers;
      return {
        disconnect: () => {},
        reconnect: () => {},
        notifyOnline: () => {},
        sendInstruction: () => {},
        sendInterrupt: () => {},
        stop: async () => {},
        restore: async () => {},
        deleteAgent: async () => {},
        renameAgent: async () => {},
      };
    },
    fetchPersonaManifest: async () => null,
    fetchAuthMethods: async () => ({ token: true, oauth: [] }),
  };
});

const App = (await import("../src/App.svelte")).default;

let component: object | null = null;

function onlineEnvelope(agentId: string, name: string): Envelope {
  return {
    version: "0",
    agent_id: agentId,
    persona: { id: "p", name, sprite_set: "p" },
    display_name: name,
    ts: "2026-09-01T00:00:00Z",
    type: "state_change",
    state: "waiting_input",
    payload: {},
  } as unknown as Envelope;
}

function errorResultEnvelope(agentId: string): Envelope {
  return {
    version: "0",
    agent_id: agentId,
    ts: "2026-09-01T00:00:01Z",
    type: "result",
    state: "error",
    payload: {
      is_error: true,
      error_code: "authentication_failed",
      error_summary: "認証の有効期限が切れました。",
    },
  } as unknown as Envelope;
}

async function mountApp(): Promise<KaoiroHandlers> {
  component = mount(App, { target: document.body });
  await vi.waitFor(() => {
    if (captured.handlers === null) throw new Error("not connected yet");
  });
  return captured.handlers!;
}

async function openDetailFromGrid(): Promise<void> {
  const openButton = document.querySelector<HTMLButtonElement>(
    'button[aria-label$="の詳細を開く"]',
  );
  expect(openButton).not.toBeNull();
  openButton!.click();
  await tick();
}

beforeEach(() => {
  captured.handlers = null;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes("/session/ticket")) {
        return { ok: true, status: 200, json: async () => ({ ticket: "t-1" }) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    }),
  );
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
  if (component) await unmount(component);
  component = null;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("App.svelte unacked error badge wiring (issue #287)", () => {
  it("is_error result 到達後、waiting_input でもグリッドのバッジが立つ", async () => {
    const h = await mountApp();
    h.onHosts?.([]);
    h.onSnapshot({ "host-a.p": onlineEnvelope("host-a.p", "あお") });
    await tick();

    expect(document.querySelector(".badge")).toBeNull();

    h.onEnvelope(errorResultEnvelope("host-a.p"));
    await tick();

    expect(document.querySelector(".badge")).not.toBeNull();
  });

  it("detail を開くとバッジが消える (ack)", async () => {
    const h = await mountApp();
    h.onHosts?.([]);
    h.onSnapshot({ "host-a.p": onlineEnvelope("host-a.p", "あお") });
    await tick();
    h.onEnvelope(errorResultEnvelope("host-a.p"));
    await tick();
    expect(document.querySelector(".badge")).not.toBeNull();

    await openDetailFromGrid();
    // Detail は現在 fullscreen なのでグリッド自体が外れる -- グリッドへ
    // 戻ってバッジが再点灯しないことまで確認する。
    const closeButton = document.querySelector<HTMLButtonElement>(
      "button.blindspot",
    );
    closeButton?.click();
    await tick();

    expect(document.querySelector(".badge")).toBeNull();
  });

  // ふじ2 round1 M1: logs (transcript/history) is the source of truth for
  // the sticky badge, not just the live onEnvelope path -- a dashboard that
  // was disconnected when the error happened must still see it via
  // onHistory alone.
  it("history のみに含まれる is_error result でもバッジが立つ (history-only, live envelope 無し)", async () => {
    const h = await mountApp();
    h.onHosts?.([]);
    h.onSnapshot({ "host-a.p": onlineEnvelope("host-a.p", "あお") });
    h.onHistory?.({ "host-a.p": [errorResultEnvelope("host-a.p")] }, {});
    await tick();

    expect(document.querySelector(".badge")).not.toBeNull();
  });

  it("ack 後、同じ history で reconnect してもバッジは再点灯しない", async () => {
    const h = await mountApp();
    h.onHosts?.([]);
    h.onSnapshot({ "host-a.p": onlineEnvelope("host-a.p", "あお") });
    h.onHistory?.({ "host-a.p": [errorResultEnvelope("host-a.p")] }, {});
    await tick();
    await openDetailFromGrid();
    document
      .querySelector<HTMLButtonElement>("button.blindspot")
      ?.click();
    await tick();
    expect(document.querySelector(".badge")).toBeNull();

    // Reconnect: the server re-sends the SAME history (same envelope, same
    // entry key) -- e.g. a socket blip that re-triggers the join push.
    h.onHistory?.({ "host-a.p": [errorResultEnvelope("host-a.p")] }, {});
    await tick();

    expect(document.querySelector(".badge")).toBeNull();
  });

  it("fresh mount (reload 相当) では ack が引き継がれず再点灯する", async () => {
    const h1 = await mountApp();
    h1.onHosts?.([]);
    h1.onSnapshot({ "host-a.p": onlineEnvelope("host-a.p", "あお") });
    h1.onHistory?.({ "host-a.p": [errorResultEnvelope("host-a.p")] }, {});
    await tick();
    await openDetailFromGrid();
    document
      .querySelector<HTMLButtonElement>("button.blindspot")
      ?.click();
    await tick();
    expect(document.querySelector(".badge")).toBeNull();

    // Reload: a brand-new App instance -- ackedErrorKeys is in-memory only
    // (こはく裁定), so it must NOT survive this.
    await unmount(component!);
    component = null;
    captured.handlers = null;
    document.body.innerHTML = "";

    const h2 = await mountApp();
    h2.onHosts?.([]);
    h2.onSnapshot({ "host-a.p": onlineEnvelope("host-a.p", "あお") });
    h2.onHistory?.({ "host-a.p": [errorResultEnvelope("host-a.p")] }, {});
    await tick();

    expect(document.querySelector(".badge")).not.toBeNull();
  });

  it("logout 後の再ログインでは stale ack が持ち越されない (同じ agent_id でもバッジが立つ)", async () => {
    vi.stubGlobal("confirm", () => true);
    const h = await mountApp();
    h.onHosts?.([]);
    h.onSnapshot({ "host-a.p": onlineEnvelope("host-a.p", "あお") });
    h.onHistory?.({ "host-a.p": [errorResultEnvelope("host-a.p")] }, {});
    await tick();
    await openDetailFromGrid();
    document
      .querySelector<HTMLButtonElement>("button.blindspot")
      ?.click();
    await tick();
    expect(document.querySelector(".badge")).toBeNull();

    // Logout via the UI (confirm() stubbed true above). logout() itself is
    // async (awaits the DELETE fetch before flipping needLogin), so the
    // login form needs an extra microtask turn to actually mount.
    document.querySelector<HTMLButtonElement>("button.logout")?.click();
    await tick();
    await tick();

    // Re-login through the actual form -- exercises logout()'s own clear,
    // not a re-mount (which would trivially clear everything).
    captured.handlers = null;
    const tokenInput = document.querySelector<HTMLInputElement>(
      'input[aria-label="アクセストークン"]',
    );
    const form = document.querySelector<HTMLFormElement>("form.login-card");
    expect(tokenInput).not.toBeNull();
    expect(form).not.toBeNull();
    tokenInput!.value = "dummy-token";
    tokenInput!.dispatchEvent(new Event("input", { bubbles: true }));
    form!.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
    await vi.waitFor(() => {
      if (captured.handlers === null) throw new Error("not reconnected yet");
    });
    const h2 = captured.handlers!;
    h2.onHosts?.([]);
    h2.onSnapshot({ "host-a.p": onlineEnvelope("host-a.p", "あお") });
    h2.onHistory?.({ "host-a.p": [errorResultEnvelope("host-a.p")] }, {});
    await tick();

    expect(document.querySelector(".badge")).not.toBeNull();
  });
});
