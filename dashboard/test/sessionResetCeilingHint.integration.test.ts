// @vitest-environment jsdom
import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KaoiroHandlers } from "../src/lib/protocol";

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
        setPermission: async () => null,
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
  return captured.handlers!;
}

function notifyCeilingConflict(handlers: KaoiroHandlers): void {
  handlers.onSessionResetFailed?.({
    request_id: "reset-405",
    agent_id: "host-a.p",
    mode: "new",
    reason: "permission_ceiling_conflict",
    ceiling_conflict: [
      { axis: "network_access", current: true, ceiling: false },
      {
        axis: "sandbox",
        current: "danger-full-access",
        ceiling: "workspace-write",
      },
    ],
  });
}

beforeEach(() => {
  captured.handlers = null;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes("/session/ticket")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ ticket: "t-1" }),
        };
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

describe("App.svelte session reset ceiling hint (issue 405)", () => {
  it("explains that full access pins network and directs sandbox narrowing first", async () => {
    const handlers = await mountApp();
    notifyCeilingConflict(handlers);
    await tick();

    const notice = document.querySelector(".spawn-notice")?.textContent ?? "";
    expect(notice).toContain(
      "現在の sandbox は danger-full-access なので network_access は true に固定されています。",
    );
    expect(notice).toContain("先に sandbox を workspace-write に狭めてください。");
    expect(notice).toContain("その後も network_access が上限を超える場合は false に狭めてください。");
    expect(notice.indexOf("先に sandbox")).toBeLessThan(
      notice.indexOf("その後も network_access"),
    );
  });

  it("keeps the direct network hint when only network_access conflicts", async () => {
    const handlers = await mountApp();
    handlers.onSessionResetFailed?.({
      request_id: "reset-405-network",
      agent_id: "host-a.p",
      mode: "new",
      reason: "permission_ceiling_conflict",
      ceiling_conflict: [
        { axis: "network_access", current: true, ceiling: false },
      ],
    });
    await tick();

    expect(document.querySelector(".spawn-notice")?.textContent).toContain(
      "network_access を false に狭めてから reset (現在: true)",
    );
  });
});
