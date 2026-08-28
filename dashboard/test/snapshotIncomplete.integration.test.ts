// @vitest-environment jsdom
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

function stateEnvelope(agentId: string): Envelope {
  return {
    version: "0",
    agent_id: agentId,
    persona: { id: agentId, name: agentId, sprite_set: agentId },
    ts: "2026-08-28T00:00:00Z",
    type: "state_change",
    state: "idle",
    payload: {},
  } as unknown as Envelope;
}

async function mountApp(): Promise<KaoiroHandlers> {
  component = mount(App, { target: document.body });
  await vi.waitFor(() => {
    if (captured.handlers === null) throw new Error("not connected yet");
  });
  return captured.handlers!;
}

beforeEach(() => {
  captured.handlers = null;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      if (String(input).includes("/session/ticket")) {
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

describe("snapshot_incomplete の可観測性 (issue #203 V-4)", () => {
  it("省略を表示し、次の join では新 snapshot 前に古い警告を消す", async () => {
    const handlers = await mountApp();
    handlers.onSnapshot({ "agent-a": stateEnvelope("agent-a") });
    handlers.onSnapshotIncomplete?.(true);
    await tick();

    expect(document.querySelector(".snapshot-notice")?.textContent).toContain(
      "snapshot の上限により表示されていません",
    );

    handlers.onJoined?.();
    await tick();
    expect(document.querySelector(".snapshot-notice")).toBeNull();
  });
});
