// @vitest-environment jsdom
// Exercise the default App -> AgentCard / AgentDetail wiring with pending
// records on a live state that has already advanced to tool_running.
import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Envelope, KaoiroHandlers } from "../src/lib/protocol";

const captured = vi.hoisted(() => ({ handlers: null as KaoiroHandlers | null }));

vi.mock("../src/lib/protocol", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/protocol")>();
  return {
    ...actual,
    connectKaoiro: (_url: string, handlers: KaoiroHandlers) => {
      captured.handlers = handlers;
      return {
        disconnect: () => {}, reconnect: () => {}, notifyOnline: () => {},
        sendInstruction: () => {}, sendInterrupt: () => {}, stop: async () => {},
        restore: async () => {}, deleteAgent: async () => {}, renameAgent: async () => {},
      };
    },
    fetchPersonaManifest: async () => null,
    fetchAuthMethods: async () => ({ token: true, oauth: [] }),
  };
});

const App = (await import("../src/App.svelte")).default;
let component: object | null = null;

function agent(agentId: string, name: string, state = "tool_running", pending: boolean | "question" = false): Envelope {
  return {
    version: "0", agent_id: agentId,
    persona: { id: agentId, name, sprite_set: agentId }, display_name: name,
    ts: "2026-09-27T00:00:00Z", type: "state_change", state, payload: {},
    ...(pending === true
      ? { ext: { pending_permission: { request_id: `req-${agentId}`, tool_name: "request_session_reset" } } }
      : pending === "question"
        ? { ext: { pending_question: { request_id: `q-${agentId}`, questions: [] } } }
        : { ext: {} }),
  } as unknown as Envelope;
}

async function mountApp(): Promise<KaoiroHandlers> {
  component = mount(App, { target: document.body });
  await vi.waitFor(() => { if (captured.handlers === null) throw new Error("not connected"); });
  return captured.handlers!;
}

beforeEach(() => {
  captured.handlers = null;
  vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes("/session/ticket")) return { ok: true, status: 200, json: async () => ({ ticket: "t-1" }) };
    return { ok: true, status: 200, json: async () => ({}) };
  }));
  Object.defineProperty(window, "matchMedia", { configurable: true, value: vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })) });
});

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("default App pending attention wiring (issue #421)", () => {
  it("lights Hisui's card badge and Chloe's blindspot, clears on settle, and excludes Hisui when selected", async () => {
    const handlers = await mountApp();
    handlers.onHosts?.([]);
    handlers.onSnapshot({
      "host.chloe": agent("host.chloe", "クロエ", "waiting_input"),
      "host.hisui": agent("host.hisui", "ひすい", "tool_running", true),
    });
    await tick();

    const hisuiCard = [...document.querySelectorAll("article.card")]
      .find((card) => card.textContent?.includes("ひすい"));
    expect(hisuiCard?.querySelector(".badge")).not.toBeNull();

    const chloeCard = [...document.querySelectorAll("article.card")]
      .find((card) => card.textContent?.includes("クロエ"));
    chloeCard?.querySelector<HTMLButtonElement>('button[aria-label$="の詳細を開く"]')?.click();
    await tick();
    expect(document.querySelector("button.blindspot")?.textContent).toContain("他に 1 体が要対応");
    expect(document.querySelector("button.blindspot")?.getAttribute("data-tone")).toBe("waiting_permission");

    handlers.onEnvelope(agent("host.hisui", "ひすい", "tool_running", false));
    await tick();
    expect(document.querySelector("button.blindspot")).toBeNull();

    handlers.onEnvelope(agent("host.hisui", "ひすい", "tool_running", true));
    await tick();
    document.querySelector<HTMLButtonElement>('button.chip[title^="ひすい"]')?.click();
    await tick();
    expect(document.querySelector("button.blindspot")).toBeNull();
  });

  it("does not light attention for tool_running without a pending record", async () => {
    const handlers = await mountApp();
    handlers.onHosts?.([]);
    handlers.onSnapshot({ "host.hisui": agent("host.hisui", "ひすい", "tool_running", false) });
    await tick();
    expect(document.querySelector(".badge")).toBeNull();
  });

  it("also lights attention for a pending question while live state is tool_running", async () => {
    const handlers = await mountApp();
    handlers.onHosts?.([]);
    handlers.onSnapshot({ "host.hisui": agent("host.hisui", "ひすい", "tool_running", "question") });
    await tick();
    expect(document.querySelector(".badge")).not.toBeNull();
  });
});
