// @vitest-environment jsdom
// issue #677 through the real App: a `session_reset_started` broadcast with
// `origin: "director"` reaches the open agent pane as "who asked", and the
// indicator clears when the reset completes or fails. The connection is a
// stub and the handlers App registers are captured (same scaffold as
// appDeliveryRole.integration.test.ts).
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
        setQuagmireSettings: async () => {},
        fetchStatusLineHistory: async () => [],
        setStatusLineRetention: async () => {},
        listConversations: async () => Object.assign([], { incomplete: false }),
        listUsers: async () => [],
        closeConversation: async () => {},
        renameUser: async () => {},
      };
    },
    fetchPersonaManifest: async () => ({ kind: "unavailable" }),
    fetchAuthMethods: async () => ({ token: true, oauth: [] }),
  };
});

// jsdom does not implement HTMLDialogElement.showModal/close.
if (
  typeof HTMLDialogElement !== "undefined" &&
  typeof HTMLDialogElement.prototype.showModal !== "function"
) {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
}

const App = (await import("../src/App.svelte")).default;
let component: object | null = null;

const TARGET = "host-a.target";
const DIRECTOR = "host-a.director";

function envelope(agentId: string, displayName: string): Envelope {
  return {
    version: "0",
    agent_id: agentId,
    display_name: displayName,
    ts: "2026-10-17T12:00:00Z",
    type: "state_change",
    state: "idle",
    payload: {},
    persona: { id: "p", name: "P", sprite_set: "p" },
  };
}

async function openTarget(): Promise<KaoiroHandlers> {
  component = mount(App, { target: document.body });
  await vi.waitFor(() => {
    if (captured.handlers === null) throw new Error("not connected yet");
  });
  const h = captured.handlers!;
  h.onJoined?.();
  h.onSnapshot?.({
    [TARGET]: envelope(TARGET, "あお"),
    [DIRECTOR]: envelope(DIRECTOR, "ひすい"),
  });
  h.onHosts?.([], false);
  h.onStatus("connected");
  await tick();
  const open = document.querySelector<HTMLButtonElement>(
    `button[aria-label="あお の詳細を開く"]`,
  );
  expect(open).not.toBeNull();
  open!.click();
  await tick();
  return h;
}

const progress = () => document.querySelector(".reset-progress")?.textContent ?? null;

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
    value: vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  });
});

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the open pane while a reset is in flight (issue #677)", () => {
  it("names the director by display name and the work", async () => {
    const h = await openTarget();
    h.onSessionResetStarted?.({
      request_id: "rs_1",
      agent_id: TARGET,
      mode: "new",
      origin: "director",
      requested_by: { kind: "agent", id: DIRECTOR },
      work_id: "wrk_1",
    });
    await tick();
    expect(progress()).toContain("director ひすい (work wrk_1) が要求");
    expect(progress()).toContain("mode: new");
  });

  it("says nothing about a director for an operator-origin reset", async () => {
    const h = await openTarget();
    h.onSessionResetStarted?.({
      request_id: "rs_2",
      agent_id: TARGET,
      mode: "clear",
      origin: "operator",
    });
    await tick();
    expect(progress()).toContain("mode: clear");
    expect(progress()).not.toContain("director");
  });

  it.each(["completed", "failed"] as const)("clears the attribution when the reset %s", async (end) => {
    const h = await openTarget();
    h.onSessionResetStarted?.({
      request_id: "rs_3",
      agent_id: TARGET,
      mode: "new",
      origin: "director",
      requested_by: { kind: "agent", id: DIRECTOR },
      work_id: "wrk_1",
    });
    await tick();
    expect(progress()).not.toBeNull();
    if (end === "completed") {
      h.onSessionResetCompleted?.({
        request_id: "rs_3", agent_id: TARGET, mode: "new", to_session_id: "s-2",
      });
    } else {
      h.onSessionResetFailed?.({
        request_id: "rs_3", agent_id: TARGET, mode: "new", reason: "timeout",
      });
    }
    await tick();
    expect(progress()).toBeNull();
  });

  it("a reset of another agent does not show on this pane", async () => {
    const h = await openTarget();
    h.onSessionResetStarted?.({
      request_id: "rs_4",
      agent_id: DIRECTOR,
      mode: "new",
      origin: "director",
      requested_by: { kind: "agent", id: TARGET },
      work_id: "wrk_9",
    });
    await tick();
    expect(progress()).toBeNull();
  });
});
