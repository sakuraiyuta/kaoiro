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
});
