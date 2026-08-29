// @vitest-environment jsdom
// issue #276: App.svelte wires SettingsDrawer's `connection` prop through
// `isOperator`, the SAME client-side signal LaunchDialog already gates on
// (App.svelte's own `{#if isOperator && connection}`). Without that gate a
// viewer session opening Settings would still call `listConversations()`
// and the server would reject it as forbidden — this pins that the
// conversation-list section simply never appears for a non-operator
// instead. This is a display-only convenience: the actual authority stays
// server-side in agents_channel.ex's `require_operator` (see
// conversationStatesOperatorProjection_test.exs / agentsChannelTest's
// list_conversations 経路 for that gate). Mirrors
// appAgentStripPresetWiring.integration.test.ts's connectKaoiro mock
// harness.
import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostInfo, KaoiroHandlers } from "../src/lib/protocol";

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
        listConversations: vi.fn(async () => []),
      };
    },
    fetchPersonaManifest: async () => null,
    fetchAuthMethods: async () => ({ token: true, oauth: [] }),
  };
});

const App = (await import("../src/App.svelte")).default;

let component: object | null = null;

async function mountApp(): Promise<KaoiroHandlers> {
  component = mount(App, { target: document.body });
  await vi.waitFor(() => {
    if (captured.handlers === null) throw new Error("not connected yet");
  });
  await tick();
  return captured.handlers!;
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
  captured.handlers = null;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function openSettings() {
  document
    .querySelector<HTMLButtonElement>("button.settings-toggle")!
    .dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

describe("SettingsDrawer connection gate (issue #276)", () => {
  it("viewer (isOperator=false) では会話一覧セクションを出さない", async () => {
    await mountApp();
    openSettings();
    await tick();

    expect(document.querySelector(".conversations")).toBeNull();
  });

  it("operator (onHosts 受信済み) では会話一覧セクションを出す", async () => {
    const handlers = await mountApp();
    handlers.onHosts?.([] as HostInfo[]);
    await tick();
    openSettings();
    await tick();

    expect(document.querySelector(".conversations")).not.toBeNull();
  });
});
