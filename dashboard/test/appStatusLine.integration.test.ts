// @vitest-environment jsdom
// Issue 482 through the real App: what a card says about an agent's status
// line, the order rules of the events that update it, the change log a viewer
// can open, and the two-layer gate on the retention control (the server's
// forbidden is tested on the server; this is the client's half).
//
// Mirrors quagmireThresholdOperatorGate.integration.test.ts: the connection is
// a stub, the handlers App registers are captured, and the test drives them the
// way the protocol layer would.
import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Envelope, KaoiroHandlers } from "../src/lib/protocol";
import type { StatusLineRow } from "../src/lib/statusLine";

const captured = vi.hoisted(() => ({
  handlers: null as KaoiroHandlers | null,
  fetchStatusLineHistory: null as ((agentId: string) => Promise<unknown>) | null,
  setStatusLineRetention: null as ((retention: number) => Promise<void>) | null,
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
        setPermission: async () => null,
        setQuagmireSettings: async () => {},
        fetchStatusLineHistory: (agentId: string) =>
          captured.fetchStatusLineHistory?.(agentId) ?? Promise.resolve([]),
        setStatusLineRetention: (retention: number) =>
          captured.setStatusLineRetention?.(retention) ?? Promise.resolve(),
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

async function mountApp(): Promise<KaoiroHandlers> {
  component = mount(App, { target: document.body });
  await vi.waitFor(() => {
    if (captured.handlers === null) throw new Error("not connected yet");
  });
  return captured.handlers!;
}

function envelope(agentId: string): Envelope {
  return {
    version: "0",
    agent_id: agentId,
    ts: "2026-10-03T12:00:00Z",
    type: "state_change",
    state: "idle",
    payload: {},
    persona: { id: "p", name: "P", sprite_set: "p" },
  };
}

function set(seq: number, updatedAt: string, head = "working"): StatusLineRow {
  return { cleared: false, seq, head, truncated: false, bytes: head.length, updatedAt };
}

const card = (agentId: string) =>
  [...document.querySelectorAll<HTMLElement>("article.card")].find((el) =>
    el.textContent?.includes(agentId),
  );
const rowOf = (agentId: string) =>
  card(agentId)?.querySelector<HTMLButtonElement>("button.status-line") ?? null;
const rowText = (agentId: string) => rowOf(agentId)?.querySelector(".status-text")?.textContent ?? null;
const retentionSection = () => document.querySelector("section.status-retention");

async function openSettings(): Promise<void> {
  document.querySelector<HTMLButtonElement>('button[aria-label="設定"]')!.click();
  await tick();
}

/** A join as a viewer or an operator would see it. */
async function join(h: KaoiroHandlers, agents: string[], role: "viewer" | "operator" = "viewer"): Promise<void> {
  h.onJoined?.();
  h.onSnapshot?.(Object.fromEntries(agents.map((id) => [id, envelope(id)])));
  if (role === "operator") h.onHosts?.([], false);
  h.onStatus("connected");
  await tick();
}

beforeEach(() => {
  captured.handlers = null;
  captured.fetchStatusLineHistory = null;
  captured.setStatusLineRetention = null;
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

describe("the card row", () => {
  it("draws no row before the snapshot arrives", async () => {
    const h = await mountApp();
    await join(h, ["a.one"]);

    expect(card("a.one")).toBeDefined();
    expect(rowOf("a.one")).toBeNull();
  });

  it("shows the line after the snapshot, and 未設定 for an agent with none", async () => {
    const h = await mountApp();
    await join(h, ["a.one", "a.two"]);

    h.onStatusLineSnapshot?.({ "a.one": set(1, "2026-10-03T12:00:00.000001Z", "Reviewing") }, false);
    await tick();

    expect(rowText("a.one")).toBe("Reviewing");
    expect(rowText("a.two")).toBe("未設定");
  });

  it("never turns an incomplete snapshot into 未設定", async () => {
    const h = await mountApp();
    await join(h, ["a.one", "a.two"]);

    h.onStatusLineSnapshot?.({ "a.one": set(1, "2026-10-03T12:00:00.000001Z", "Reviewing") }, true);
    await tick();

    expect(rowText("a.one")).toBe("Reviewing");
    expect(rowOf("a.two")).toBeNull();

    h.onStatusLineSnapshot?.({ "a.one": set(1, "2026-10-03T12:00:00.000001Z", "Reviewing") }, false);
    await tick();

    expect(rowText("a.two")).toBe("未設定");
  });

  it("applies a live line, and ignores one older than what it holds", async () => {
    const h = await mountApp();
    await join(h, ["a.one"]);
    h.onStatusLineSnapshot?.({ "a.one": set(5, "2026-10-03T12:00:05.000000Z", "newest") }, false);

    h.onStatusLine?.("a.one", set(4, "2026-10-03T12:00:04.000000Z", "older"));
    await tick();
    expect(rowText("a.one")).toBe("newest");

    h.onStatusLine?.("a.one", set(6, "2026-10-03T12:00:06.000000Z", "latest"));
    await tick();
    expect(rowText("a.one")).toBe("latest");
  });

  it("a stamped clear shows 未設定 and rejects an older set that arrives later", async () => {
    const h = await mountApp();
    await join(h, ["a.one"]);
    h.onStatusLineSnapshot?.({ "a.one": set(1, "2026-10-03T12:00:01.000000Z") }, false);

    h.onStatusLine?.("a.one", { cleared: true, seq: 2, updatedAt: "2026-10-03T12:00:02.000000Z" });
    h.onStatusLine?.("a.one", set(1, "2026-10-03T12:00:01.000000Z", "stale"));
    await tick();

    expect(rowText("a.one")).toBe("未設定");
  });

  // The server announces a line from inside the write that makes its agent
  // visible, which can precede the envelope that creates the card.
  it("keeps a line that arrives before the card exists", async () => {
    const h = await mountApp();
    h.onJoined?.();
    h.onSnapshot?.({ "a.other": envelope("a.other") });
    h.onStatusLineSnapshot?.({}, false);
    h.onStatusLine?.("a.late", set(1, "2026-10-03T12:00:00.000001Z", "early bird"));
    await tick();
    expect(card("a.late")).toBeUndefined();

    h.onEnvelope?.(envelope("a.late"));
    await tick();

    expect(rowText("a.late")).toBe("early bird");
  });

  it("drops an agent's line when the agent is deleted", async () => {
    const h = await mountApp();
    await join(h, ["a.one"]);
    h.onStatusLineSnapshot?.({ "a.one": set(1, "2026-10-03T12:00:00.000001Z", "gone soon") }, false);
    await tick();
    expect(rowText("a.one")).toBe("gone soon");

    h.onAgentDeleted?.("a.one");
    h.onEnvelope?.(envelope("a.one"));
    await tick();

    expect(rowText("a.one")).toBe("未設定");
  });

  it("forgets everything held on a rejoin", async () => {
    const h = await mountApp();
    await join(h, ["a.one"]);
    h.onStatusLineSnapshot?.({ "a.one": set(1, "2026-10-03T12:00:00.000001Z") }, false);
    await tick();
    expect(rowOf("a.one")).not.toBeNull();

    h.onJoined?.();
    h.onSnapshot?.({ "a.one": envelope("a.one") });
    await tick();

    expect(rowOf("a.one")).toBeNull();
  });
});

describe("the change log dialog", () => {
  it("opens for a viewer, who has no operator connection, and reads the agent's log", async () => {
    const calls: string[] = [];
    captured.fetchStatusLineHistory = async (agentId) => {
      calls.push(agentId);
      return [{ seq: 1, text: "# first", bytes: 7, updatedAt: "2026-10-03T12:00:00.000001Z" }];
    };
    const h = await mountApp();
    await join(h, ["a.one"], "viewer");
    h.onStatusLineSnapshot?.({ "a.one": set(1, "2026-10-03T12:00:00.000001Z") }, false);
    await tick();

    rowOf("a.one")!.click();
    await vi.waitFor(() => expect(document.querySelector("dialog h1")).not.toBeNull());

    expect(calls).toEqual(["a.one"]);
    expect(document.querySelector("dialog h1")?.textContent).toBe("first");
  });

  it("reads again when the agent writes a new line", async () => {
    const calls: string[] = [];
    captured.fetchStatusLineHistory = async (agentId) => {
      calls.push(agentId);
      return [];
    };
    const h = await mountApp();
    await join(h, ["a.one"]);
    h.onStatusLineSnapshot?.({ "a.one": set(1, "2026-10-03T12:00:00.000001Z") }, false);
    await tick();
    rowOf("a.one")!.click();
    await vi.waitFor(() => expect(calls).toHaveLength(1));

    h.onStatusLine?.("a.one", set(2, "2026-10-03T12:00:09.000000Z", "new"));

    await vi.waitFor(() => expect(calls).toHaveLength(2));
  });
});

describe("the member detail view", () => {
  const openDetail = async (agentId: string) => {
    card(agentId)!.querySelector<HTMLButtonElement>("button.open")!.click();
    await tick();
  };
  const panel = () => document.querySelector<HTMLElement>(".status-line-panel");

  it("shows the agent's line, live, and nothing before the snapshot", async () => {
    const h = await mountApp();
    await join(h, ["a.one"]);
    await openDetail("a.one");
    expect(panel()).toBeNull();

    h.onStatusLineSnapshot?.({ "a.one": set(1, "2026-10-03T12:00:00.000001Z", "**first**") }, false);
    await tick();
    expect(panel()?.querySelector(".body strong")?.textContent).toBe("first");
    // Below the pinned identity header, inside the scrolling column.
    expect(panel()?.closest(".status-scroll")).not.toBeNull();

    h.onStatusLine?.("a.one", set(2, "2026-10-03T12:00:09.000000Z", "second"));
    await tick();
    expect(panel()?.querySelector(".body")?.textContent?.trim()).toBe("second");
  });

  it("says 未設定 once a complete snapshot has none, and never for an incomplete one", async () => {
    const h = await mountApp();
    await join(h, ["a.one"]);
    await openDetail("a.one");

    h.onStatusLineSnapshot?.({}, true);
    await tick();
    expect(panel()).toBeNull();

    h.onStatusLineSnapshot?.({}, false);
    await tick();
    expect(panel()?.querySelector(".unset")?.textContent).toBe("未設定");
  });

  it("opens the change log of the agent on 続きを読む, for a viewer too", async () => {
    const calls: string[] = [];
    captured.fetchStatusLineHistory = async (agentId) => {
      calls.push(agentId);
      return [{ seq: 1, text: "# whole text", bytes: 12, updatedAt: "2026-10-03T12:00:00.000001Z" }];
    };
    const h = await mountApp();
    await join(h, ["a.one"], "viewer");
    h.onStatusLineSnapshot?.(
      {
        "a.one": {
          cleared: false,
          seq: 1,
          head: "cut",
          truncated: true,
          bytes: 4096,
          updatedAt: "2026-10-03T12:00:00.000001Z",
        },
      },
      false,
    );
    await tick();
    await openDetail("a.one");

    panel()!.querySelector<HTMLButtonElement>(".read-more")!.click();
    await vi.waitFor(() => expect(document.querySelector("dialog h1")?.textContent).toBe("whole text"));

    expect(calls).toEqual(["a.one"]);
  });
});

describe("the retention control: the client's half of the two-layer gate", () => {
  it("is shown to an operator, with the value in force", async () => {
    const h = await mountApp();
    await join(h, [], "operator");
    h.onStatusLineSettings?.({ retention: 20, source: "default", min: 1, max: 100 });
    await tick();
    await openSettings();

    expect(retentionSection()).not.toBeNull();
    expect(retentionSection()!.querySelector<HTMLInputElement>("input[type=number]")!.value).toBe("20");
  });

  it("is withheld from a viewer", async () => {
    const h = await mountApp();
    await join(h, [], "viewer");
    h.onStatusLineSettings?.({ retention: 20, source: "default", min: 1, max: 100 });
    await tick();
    await openSettings();

    expect(retentionSection()).toBeNull();
  });

  it("is withdrawn when a rejoin downgrades the role", async () => {
    const h = await mountApp();
    await join(h, [], "operator");
    h.onStatusLineSettings?.({ retention: 20, source: "default", min: 1, max: 100 });
    await tick();
    await openSettings();
    expect(retentionSection()).not.toBeNull();

    h.onJoined?.();
    await tick();

    expect(retentionSection()).toBeNull();
  });

  it("sends the typed value, clamped to the server's bounds", async () => {
    const sent: number[] = [];
    captured.setStatusLineRetention = async (retention) => {
      sent.push(retention);
    };
    const h = await mountApp();
    await join(h, [], "operator");
    h.onStatusLineSettings?.({ retention: 20, source: "default", min: 1, max: 100 });
    await tick();
    await openSettings();
    const input = retentionSection()!.querySelector<HTMLInputElement>("input[type=number]")!;

    for (const typed of ["7", "500", "0"]) {
      input.value = typed;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }

    expect(sent).toEqual([7, 100, 1]);
  });

  it("shows the server's reason when a change is rejected", async () => {
    captured.setStatusLineRetention = async () => {
      throw new Error("status_line_unavailable");
    };
    const h = await mountApp();
    await join(h, [], "operator");
    h.onStatusLineSettings?.({ retention: 20, source: "default", min: 1, max: 100 });
    await tick();
    await openSettings();
    const input = retentionSection()!.querySelector<HTMLInputElement>("input[type=number]")!;

    input.value = "9";
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() => expect(retentionSection()!.querySelector(".error")).not.toBeNull());

    expect(retentionSection()!.querySelector(".error")?.textContent).toContain("status_line_unavailable");
  });
});
