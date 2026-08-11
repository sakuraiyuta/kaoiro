// @vitest-environment jsdom
// issue #197 段階3 unit B, ふじ MF-3 レビュー指摘: a live-disconnected
// agent has no wrapper to re-emit `state_change` after a rename, so its
// stale AgentStates envelope would otherwise show the pre-rename name
// forever even after AgentDirectory (and the operator's own rename
// click) has already moved on. `App.svelte`'s `projectDirectoryName`
// closes that gap by projecting AgentDirectory's current name onto the
// live envelope whenever the two names diverge.
//
// Mounts App.svelte with `connectKaoiro` swapped for a capture (mirrors
// projectionEpochWindow.integration.test.ts's harness) and drives it
// through the REAL `onSnapshot`/`onDirectory`/`onHosts` handlers App
// itself wired — nothing about the projection logic is re-implemented
// here.
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

function disconnectedEnvelope(agentId: string, name: string): Envelope {
  return {
    version: "0",
    agent_id: agentId,
    persona: { id: agentId, name, sprite_set: agentId },
    display_name: name,
    ts: "2026-08-11T00:00:00Z",
    type: "state_change",
    state: "disconnected",
    payload: {},
    ext: {},
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
      const url = String(input);
      if (url.includes("/session/ticket")) {
        return { ok: true, status: 200, json: async () => ({ ticket: "t-1" }) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    }),
  );
  // prefers-reduced-motion: true skips AgentDetail's expand-from-origin
  // Web Animations API call (unsupported in jsdom) — mirrors
  // modelSwitch.integration.test.ts's harness, not
  // projectionEpochWindow's (that suite never opens a detail view).
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

describe("AgentDirectory name projection onto a live-disconnected agent (issue #197 段階3 ふじ MF-3 レビュー指摘)", () => {
  it("offline tile と selected detail の両方が directory の新しい name へ追随する", async () => {
    const h = await mountApp();
    h.onHosts?.([]); // operator signal
    h.onSnapshot({ "agent-a": disconnectedEnvelope("agent-a", "あお") });
    // AgentDirectory alone advances past the stale AgentStates envelope —
    // exactly the state a `rename_agent` success (server commit + live
    // `directory` broadcast) leaves a disconnected agent in, since no
    // wrapper is there to re-emit `state_change`.
    h.onDirectory?.({
      "agent-a": {
        // persona (canonical) is UNCHANGED by rename (issue #219 D19) —
        // only display_name diverges from the stale AgentStates envelope.
        persona: { id: "agent-a", name: "あお", sprite_set: "agent-a" },
        display_name: "あお(改名)",
        last_seen: null,
      },
    });
    await tick();

    // Offline tile: the collapsed <details> section still renders its DOM
    // (jsdom does not strip content on a closed <details>), so querying
    // the tile's <h2> observes the projected name directly.
    const offlineHeading = document.querySelector(".offline .agents h2");
    expect(offlineHeading?.textContent).toBe("あお(改名)");
    expect(document.querySelector(".offline .agents h2")?.textContent).not.toBe("あお");

    // Selecting the tile opens the detail view — its header must show the
    // same projected name, not the stale AgentStates one.
    const openButton = document.querySelector(
      ".offline .agents .open",
    ) as HTMLButtonElement;
    expect(openButton).not.toBeNull();
    openButton.click();
    await tick();

    const detailHeading = document.querySelector(".detail-stage h2");
    expect(detailHeading?.textContent).toBe("あお(改名)");
  });

  it("directory の display_name が AgentStates と一致していれば projection は何もしない (no-op)", async () => {
    const h = await mountApp();
    h.onHosts?.([]);
    h.onSnapshot({ "agent-a": disconnectedEnvelope("agent-a", "あお") });
    h.onDirectory?.({
      "agent-a": {
        persona: { id: "agent-a", name: "あお", sprite_set: "agent-a" },
        display_name: "あお",
        last_seen: null,
      },
    });
    await tick();

    expect(document.querySelector(".offline .agents h2")?.textContent).toBe("あお");
  });
});
