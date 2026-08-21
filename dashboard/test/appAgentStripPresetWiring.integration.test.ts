// @vitest-environment jsdom
// issue #245 fix-round (ふじ round1 must-fix, confidence 0.99): pins
// App.svelte's agent-strip (`.chip`) wiring to PersonaFace's size="chip"
// preset, mirroring personaFacePresetWiring.integration.test.ts for the
// other 3 sites. Split into its own file because it needs the
// connectKaoiro mock harness (mirrors
// directoryNameProjection.integration.test.ts's pattern), which must sit
// at module scope and would otherwise leak into the other 3 sites' plain
// component mounts.
import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Envelope,
  KaoiroHandlers,
  PersonaManifest,
} from "../src/lib/protocol";

const manifestWithSprite: PersonaManifest = {
  version: "1",
  personas: {
    p: {
      states: {
        idle: { url: "/sprites/p/idle.png", hash: "sha256:idle" },
      },
    },
  },
};

const captured = vi.hoisted(() => ({
  handlers: null as KaoiroHandlers | null,
  manifest: null as PersonaManifest | null,
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
    fetchPersonaManifest: async () => captured.manifest,
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
    ts: "2026-08-20T00:00:00Z",
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
  captured.manifest = null;
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

// Opens the detail view for the first online AgentCard in the grid, which
// is what makes `selectedEnvelope && sorted.length > 1` true and the
// agent-strip render at all (App.svelte:1398).
async function openDetailFromGrid(): Promise<void> {
  const openButton = document.querySelector<HTMLButtonElement>(
    'button[aria-label$="の詳細を開く"]',
  );
  expect(openButton).not.toBeNull();
  openButton!.click();
  await tick();
}

describe("App.svelte agent-strip -> PersonaFace preset wiring", () => {
  it('sprite 無し face は size="chip" / aria-hidden="true" / role 無し', async () => {
    const h = await mountApp();
    h.onHosts?.([]);
    h.onSnapshot({
      "host-a.p": onlineEnvelope("host-a.p", "あお"),
      "host-b.p": onlineEnvelope("host-b.p", "もも"),
    });
    await tick();
    await openDetailFromGrid();

    const face = document.querySelector(".agent-strip .chip .face");
    expect(face?.getAttribute("data-size")).toBe("chip");
    expect(face?.getAttribute("aria-hidden")).toBe("true");
    expect(face?.hasAttribute("role")).toBe(false);
    expect(face?.hasAttribute("aria-label")).toBe(false);
  });

  it('sprite 有り img は size="chip" / alt=""', async () => {
    captured.manifest = manifestWithSprite;
    const h = await mountApp();
    h.onHosts?.([]);
    h.onSnapshot({
      "host-a.p": onlineEnvelope("host-a.p", "あお"),
      "host-b.p": onlineEnvelope("host-b.p", "もも"),
    });
    await tick();
    await openDetailFromGrid();

    const img = document.querySelector(".agent-strip .chip img.portrait-sprite");
    expect(img?.getAttribute("data-size")).toBe("chip");
    expect(img?.getAttribute("alt")).toBe("");
  });
});
