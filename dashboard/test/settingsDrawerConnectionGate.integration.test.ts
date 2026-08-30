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
  // issue #276 review follow-up (ふじ round3): also capture the
  // connection object itself so a test can assert on
  // `listConversations`'s call COUNT (not just whether the section
  // renders), pinning "hosts 再受信なしの rejoin は一覧を取得し直さない".
  listConversations: null as ReturnType<typeof vi.fn> | null,
}));

vi.mock("../src/lib/protocol", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/lib/protocol")>();
  return {
    ...actual,
    connectKaoiro: (_url: string, handlers: KaoiroHandlers) => {
      captured.handlers = handlers;
      captured.listConversations = vi.fn(async () => []);
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
        listConversations: captured.listConversations,
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
  captured.listConversations = null;
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
  captured.listConversations = null;
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

  // issue #276 review follow-up (ふじ round3 must-fix): onJoined resets
  // every OTHER join-scoped projection (agents/tasks/deliveries/...) but
  // used to leave isOperator/hosts untouched. Since onHosts is the ONLY
  // place isOperator becomes true, and the server only pushes "hosts" to
  // an operator-capable role on join (agents_channel.ex), a role
  // downgrade mid-session rejoins as a viewer that never gets "hosts"
  // again — isOperator stayed stuck true from the prior, now-revoked
  // session. Pins the full production wiring: operator display -> same-
  // connection rejoin with no hosts (viewer downgrade) -> section gone,
  // no re-fetch -> a later hosts push re-raises operator display.
  it("同一 connection 上で hosts 無しの再 join (viewer への降格) が起きると会話一覧が消え、再取得もしない", async () => {
    const handlers = await mountApp();
    handlers.onHosts?.([] as HostInfo[]);
    await tick();
    openSettings();
    await tick();

    expect(document.querySelector(".conversations")).not.toBeNull();
    const callsBeforeRejoin = captured.listConversations!.mock.calls.length;
    expect(callsBeforeRejoin).toBeGreaterThanOrEqual(1);

    // Same underlying connection re-joins (phoenix-level reconnect); the
    // server no longer sends "hosts" because the role is no longer
    // operator-capable.
    handlers.onJoined?.();
    await tick();

    expect(document.querySelector(".conversations")).toBeNull();
    expect(captured.listConversations!.mock.calls.length).toBe(
      callsBeforeRejoin,
    );

    // A later rejoin where the role IS still/again operator-capable does
    // get "hosts" and re-raises the section (and re-fetches).
    handlers.onHosts?.([] as HostInfo[]);
    await tick();

    expect(document.querySelector(".conversations")).not.toBeNull();
    expect(
      captured.listConversations!.mock.calls.length,
    ).toBeGreaterThan(callsBeforeRejoin);
  });
});
