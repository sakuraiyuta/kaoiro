// @vitest-environment jsdom
// issue #273: the quagmire banner is operator-only on BOTH layers. The
// server gate is pinned in agents_channel_test.exs; this pins the client
// half, so a client that somehow receives the event still renders nothing
// for a viewer session. Uses the connectKaoiro mock harness (mirrors
// appAgentStripPresetWiring.integration.test.ts) to drive the handler
// directly.
import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KaoiroHandlers, QuagmireNotice } from "../src/lib/protocol";
import { parseQuagmireNotice } from "../src/lib/protocol";

const captured = vi.hoisted(() => ({
  handlers: null as KaoiroHandlers | null,
}));

vi.mock("../src/lib/protocol", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/protocol")>();
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

const rally: QuagmireNotice = {
  kind: "rally",
  participants: ["host.a", "host.b"],
  turns: 18,
  conversations: 2,
  threshold: 16,
};

async function mountApp(): Promise<KaoiroHandlers> {
  component = mount(App, { target: document.body });
  await vi.waitFor(() => {
    if (captured.handlers === null) throw new Error("not connected yet");
  });
  return captured.handlers!;
}

function banners(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(".quagmire-notice"));
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

describe("quagmire notice (issue #273)", () => {
  it("renders nothing for a session that never became operator", async () => {
    const h = await mountApp();
    h.onQuagmireNotice?.(rally);
    await tick();

    expect(banners()).toHaveLength(0);
  });

  it("renders one banner per subject for an operator session", async () => {
    const h = await mountApp();
    h.onHosts?.([]);
    h.onQuagmireNotice?.(rally);
    await tick();

    expect(banners()).toHaveLength(1);
    expect(banners()[0]?.textContent).toContain("18");

    // Re-firing the same subject replaces rather than stacks.
    h.onQuagmireNotice?.({ ...rally, turns: 20 });
    await tick();
    expect(banners()).toHaveLength(1);
    expect(banners()[0]?.textContent).toContain("20");

    h.onQuagmireNotice?.({
      kind: "stall",
      agentId: "host.c",
      undelivered: 2,
      pendingSince: "2026-09-05T00:00:00Z",
      thresholdMs: 1_800_000,
    });
    await tick();
    expect(banners()).toHaveLength(2);
    // An unacknowledged delivery also looks like this while the recipient is
    // mid-turn, so the copy must not assert a stall (director addendum).
    expect(banners()[1]?.textContent).toContain("疑い");
  });

  it("stays dismissed until the condition fires again", async () => {
    const h = await mountApp();
    h.onHosts?.([]);
    h.onQuagmireNotice?.(rally);
    await tick();

    banners()[0]?.querySelector<HTMLButtonElement>(".quagmire-dismiss")?.click();
    await tick();
    expect(banners()).toHaveLength(0);

    h.onQuagmireNotice?.(rally);
    await tick();
    expect(banners()).toHaveLength(1);
  });
});

describe("parseQuagmireNotice", () => {
  it("accepts a well-formed rally and stall", () => {
    expect(
      parseQuagmireNotice({
        kind: "rally",
        participants: ["a", "b"],
        turns: 18,
        conversations: 2,
        threshold: 16,
      }),
    ).toEqual({
      kind: "rally",
      participants: ["a", "b"],
      turns: 18,
      conversations: 2,
      threshold: 16,
    });

    expect(
      parseQuagmireNotice({
        kind: "stall",
        agent_id: "host.c",
        undelivered: 3,
        pending_since: "2026-09-05T00:00:00Z",
        threshold_ms: 1_800_000,
      }),
    ).toEqual({
      kind: "stall",
      agentId: "host.c",
      undelivered: 3,
      pendingSince: "2026-09-05T00:00:00Z",
      thresholdMs: 1_800_000,
    });
  });

  it("rejects a malformed notice rather than rendering half of it", () => {
    // An operator acting on a quagmire needs the numbers to be real.
    expect(parseQuagmireNotice(null)).toBeNull();
    expect(parseQuagmireNotice({ kind: "unknown" })).toBeNull();
    expect(
      parseQuagmireNotice({ kind: "rally", participants: ["a"], turns: "18", threshold: 16 }),
    ).toBeNull();
    expect(
      parseQuagmireNotice({ kind: "rally", participants: "a-b", turns: 18, threshold: 16 }),
    ).toBeNull();
    expect(parseQuagmireNotice({ kind: "stall", undelivered: 3 })).toBeNull();
    // conversations / threshold_ms are validated as strictly as their
    // siblings: substituting 0 would render "0 会話" — the half-filled
    // banner with a wrong number the doc says cannot occur.
    expect(
      parseQuagmireNotice({
        kind: "rally",
        participants: ["a", "b"],
        turns: 18,
        threshold: 16,
      }),
    ).toBeNull();
    expect(
      parseQuagmireNotice({
        kind: "stall",
        agent_id: "host.c",
        undelivered: 3,
        pending_since: "2026-09-05T00:00:00Z",
      }),
    ).toBeNull();
  });
});
