import "./isolation.setup";
// @vitest-environment jsdom
// App.svelte names an agent through the shared resolver (directory name, then
// live name, persona name, id), so a rename shows at once even while the live
// envelope still carries the old name. Same harness as
// directoryNameProjection.integration.test.ts: App is mounted with
// `connectKaoiro` captured and driven through its own handlers.
//
// The agent strip chips and the previous/next buttons list connected agents
// only (`sorted` drops `disconnected`), so a disconnected agent never appears
// there; those two places are checked for connected agents. The session
// history and status line history titles are reachable for both states.
import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Envelope, KaoiroHandlers } from "../src/lib/protocol";

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
        listSessionEvents: async () => ({ events: [], incomplete: false }),
        fetchStatusLineHistory: async () => [],
      };
    },
    fetchPersonaManifest: async () => ({ kind: "unavailable" }),
    fetchAuthMethods: async () => ({ token: true, oauth: [] }),
  };
});

const App = (await import("../src/App.svelte")).default;

// jsdom does not implement HTMLDialogElement.showModal/close; Modal calls them on mount.
if (typeof HTMLDialogElement.prototype.showModal !== "function") {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.removeAttribute("open");
  };
}

let component: object | null = null;

// The live envelope still carries the pre-rename name; the directory has the new one.
function liveEnvelope(id: string, state: string): Envelope {
  return {
    version: "0",
    agent_id: id,
    persona: { id, name: `persona-${id}`, sprite_set: id },
    display_name: `old-${id}`,
    ts: "2026-10-24T00:00:00Z",
    type: "state_change",
    state,
    payload: {},
    ext: {},
  } as unknown as Envelope;
}

async function mountApp(): Promise<void> {
  component = mount(App, { target: document.body });
  await vi.waitFor(() => {
    if (captured.handlers === null) throw new Error("not connected yet");
  });
  const h = captured.handlers!;
  h.onHosts?.([]); // operator signal
  h.onSnapshot({
    "agent-a": liveEnvelope("agent-a", "idle"),
    "agent-b": liveEnvelope("agent-b", "idle"),
    "agent-c": liveEnvelope("agent-c", "idle"),
    "agent-d": liveEnvelope("agent-d", "disconnected"),
  });
  h.onDirectory?.(Object.fromEntries(
    ["a", "b", "c", "d"].map((x) => [
      `agent-${x}`,
      { persona: { id: `agent-${x}`, name: `persona-agent-${x}`, sprite_set: `agent-${x}` }, display_name: `new-${x}`, last_seen: null },
    ]),
  ));
  h.onStatusLineSnapshot?.(Object.fromEntries(
    ["agent-b", "agent-d"].map((id) => [
      id,
      { cleared: false, seq: 1, head: "working", truncated: false, bytes: 7, updatedAt: "2026-10-24T00:00:00Z" },
    ]),
  ), false);
  await tick();
}

function open(selector: string): void {
  const button = document.querySelector(selector) as HTMLButtonElement | null;
  expect(button).not.toBeNull();
  button!.click();
}

// Live cards sit in the main grid in id order (a, b, c); d is in the offline section.
async function openDetail(which: "agent-b" | "agent-d"): Promise<void> {
  const buttons = which === "agent-d"
    ? document.querySelectorAll(".offline .agents .open")
    : Array.from(document.querySelectorAll(".agents .open")).filter((el) => !el.closest(".offline"));
  const target = which === "agent-d" ? buttons[0] : buttons[1];
  expect(target).toBeDefined();
  (target as HTMLButtonElement).click();
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

describe("App names agents directory-first at every read (issue #670)", () => {
  it("previous/next buttons and strip chips show the renamed neighbours", async () => {
    await mountApp();
    await openDetail("agent-b");
    expect(document.querySelector("[aria-label^='前のエージェント']")?.getAttribute("aria-label"))
      .toBe("前のエージェント new-a へ");
    expect(document.querySelector("[aria-label^='次のエージェント']")?.getAttribute("aria-label"))
      .toBe("次のエージェント new-c へ");
    const titles = Array.from(document.querySelectorAll(".agent-strip .chip")).map((el) => el.getAttribute("title") ?? "");
    expect(titles.map((t) => t.split(" — ")[0])).toEqual(["new-a", "new-b", "new-c"]);
  });

  it.each([["agent-b", "new-b"], ["agent-d", "new-d"]] as const)(
    "the session history title of connected/disconnected %s shows %s",
    async (id, name) => {
      await mountApp();
      await openDetail(id);
      open(".session-lifecycle-open");
      await tick();
      expect(document.querySelector(".session-lifecycle-dialog h2")?.textContent).toBe(`${name} のセッション履歴`);
    },
  );

  it.each([["agent-b", "new-b"], ["agent-d", "new-d"]] as const)(
    "the status line history title of %s shows %s",
    async (id, name) => {
      await mountApp();
      await openDetail(id);
      open(".status-line-panel button");
      await tick();
      expect(document.querySelector(".status-line-history h2")?.textContent).toBe(`${name} の状況表示`);
    },
  );
});
