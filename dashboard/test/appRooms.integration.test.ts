import "./isolation.setup";
// @vitest-environment jsdom
// Issue #537 in the real App: where the room separators go, who sees the room
// controls (the UI half of the operator gate; the server refuses the calls
// itself), and what a rejoin or an incomplete snapshot does.
//
// Same connectKaoiro mock as appPermissionOperatorGate.integration.test.ts,
// which is module-scope and so needs its own file.
import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../src/lib/i18n/index.svelte";
import type { Envelope, KaoiroHandlers } from "../src/lib/protocol";
import { parseRoomsSnapshot } from "../src/lib/rooms";

HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };

const captured = vi.hoisted(() => ({
  handlers: null as KaoiroHandlers | null,
  reconnect: (() => {}) as () => void,
  moveAgent: (async () => ({ closedCount: 0, movedCount: 1 })) as () => Promise<unknown>,
}));

vi.mock("../src/lib/protocol", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/protocol")>();
  return {
    ...actual,
    connectKaoiro: (_url: string, handlers: KaoiroHandlers) => {
      captured.handlers = handlers;
      return {
        disconnect: () => {},
        reconnect: () => captured.reconnect(),
        notifyOnline: () => {},
        sendInstruction: () => {},
        sendInterrupt: () => {},
        stop: async () => {},
        restore: async () => {},
        deleteAgent: async () => {},
        renameAgent: async () => {},
        setPermission: async () => null,
        moveAgent: () => captured.moveAgent(),
        previewRoomMove: async () => ({ closingCount: 1, memberCount: 1 }),
        previewRoomDelete: async () => ({ closingCount: 0, memberCount: 0 }),
      };
    },
    fetchPersonaManifest: async () => ({ kind: "unavailable" }),
    fetchAuthMethods: async () => ({ token: true, oauth: [] }),
  };
});

const App = (await import("../src/App.svelte")).default;

let component: object | null = null;

function envelope(agentId: string, name: string): Envelope {
  return {
    version: "0",
    agent_id: agentId,
    persona: { id: "p", name, sprite_set: "p" },
    display_name: name,
    ts: "2026-11-10T00:00:00Z",
    type: "state_change",
    state: "idle",
    payload: {},
    ext: { engine: "codex" },
  } as unknown as Envelope;
}

const RAW = {
  rooms: [{ id: "lobby", name: null }, { id: "r1", name: "Review" }, { id: "r2", name: "Docs" }],
  memberships: { "h.a": "lobby", "h.b": "r1" },
};

function snapshot(raw: unknown) {
  const parsed = parseRoomsSnapshot(raw);
  if (parsed === null) throw new Error("not a snapshot");
  return parsed;
}

async function mountApp(role: "operator" | "viewer", raw: unknown | null = RAW): Promise<KaoiroHandlers> {
  component = mount(App, { target: document.body });
  await vi.waitFor(() => {
    if (captured.handlers === null) throw new Error("not connected yet");
  });
  const h = captured.handlers!;
  h.onStatus("connected");
  if (role === "operator") h.onHosts?.([], false);
  h.onSnapshot({ "h.a": envelope("h.a", "Alpha"), "h.b": envelope("h.b", "Bravo") });
  if (raw !== null) h.onRoomsSnapshot?.(snapshot(raw));
  await tick();
  return h;
}

const rows = () => [...document.querySelectorAll(".live-dashboard .agents > li")];
const kinds = () => rows().map((li) =>
  li.classList.contains("rooms-toolbar") ? "toolbar"
    : li.classList.contains("room-header") ? `header:${li.getAttribute("data-room")}`
    : `card:${li.querySelector("article")?.textContent?.includes("Alpha") ? "h.a" : "h.b"}`);
const text = () => document.body.textContent ?? "";
const button = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === label);

beforeEach(() => {
  captured.handlers = null;
  captured.reconnect = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
    if (String(input).includes("/session/ticket")) return { ok: true, status: 200, json: async () => ({ ticket: "t-1" }) };
    return { ok: true, status: 200, json: async () => ({}) };
  }));
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

describe("the grid", () => {
  it("stays flat, with no room control, until a snapshot arrives (an older server)", async () => {
    await mountApp("operator", null);

    expect(kinds()).toEqual(["card:h.a", "card:h.b"]);
    expect(button("部屋を作成")).toBeUndefined();
    expect(button("部屋を移動")).toBeUndefined();
  });

  it("puts the lobby first, then each room with its tiles, an empty room included", async () => {
    await mountApp("operator");

    expect(kinds()).toEqual([
      "toolbar", "header:lobby", "card:h.a", "header:r1", "card:h.b", "header:r2",
    ]);
    const headers = [...document.querySelectorAll(".live-dashboard .room-header")];
    expect(headers.map((h) => h.querySelector("h3")?.textContent)).toEqual(["ロビー", "Review", "Docs"]);
    expect(headers[2]!.textContent).toContain("この部屋に agent はいません");
  });

  it("lists an agent the complete snapshot omits in the lobby, and an incomplete one's omission as unconfirmed", async () => {
    const h = await mountApp("operator", { ...RAW, memberships: { "h.b": "r1" } });
    expect(kinds().slice(0, 3)).toEqual(["toolbar", "header:lobby", "card:h.a"]);

    h.onRoomsSnapshot?.(snapshot({ ...RAW, memberships: { "h.b": "r1" }, snapshot_incomplete: true }));
    await tick();

    expect(kinds()).toEqual(["toolbar", "header:lobby", "header:r1", "card:h.b", "header:r2", "header:unknown", "card:h.a"]);
    expect(document.querySelector('[data-room="unknown"] h3')?.textContent).toBe("部屋を確認できていません");
  });

  it("goes back to flat when the connection rejoins, until the new snapshot arrives", async () => {
    const h = await mountApp("operator");
    expect(kinds()).toContain("header:r1");

    h.onJoined?.();
    h.onSnapshot({ "h.a": envelope("h.a", "Alpha"), "h.b": envelope("h.b", "Bravo") });
    await tick();

    expect(kinds()).toEqual(["card:h.a", "card:h.b"]);
  });
});

describe("who sees the controls", () => {
  it("shows an operator create, rename, delete (never on the lobby) and a move on each tile", async () => {
    await mountApp("operator");

    expect(button("部屋を作成")).toBeDefined();
    const renames = [...document.querySelectorAll<HTMLButtonElement>("button[aria-label^='部屋'][aria-label$='を改名']")];
    expect(renames.map((b) => b.getAttribute("aria-label"))).toEqual(["部屋 ロビー を改名", "部屋 Review を改名", "部屋 Docs を改名"]);
    const deletes = [...document.querySelectorAll<HTMLButtonElement>("button[aria-label^='部屋'][aria-label$='を削除']")];
    expect(deletes.map((b) => b.getAttribute("aria-label"))).toEqual(["部屋 Review を削除", "部屋 Docs を削除"]);
    expect(document.querySelectorAll("button[aria-label$='を別の部屋へ移動']")).toHaveLength(2);
  });

  it("shows a viewer the rooms and who is in them, and no control", async () => {
    await mountApp("viewer");

    expect(kinds()).toEqual(["header:lobby", "card:h.a", "header:r1", "card:h.b", "header:r2"]);
    expect(button("部屋を作成")).toBeUndefined();
    expect(document.querySelector("button[aria-label$='を改名']")).toBeNull();
    expect(document.querySelector("button[aria-label$='を削除']")).toBeNull();
    expect(document.querySelector("button[aria-label$='を別の部屋へ移動']")).toBeNull();
  });

  it("drops the controls of a viewer-downgraded rejoin", async () => {
    const h = await mountApp("operator");
    expect(button("部屋を作成")).toBeDefined();

    h.onJoined?.();
    h.onSnapshot({ "h.a": envelope("h.a", "Alpha"), "h.b": envelope("h.b", "Bravo") });
    h.onRoomsSnapshot?.(snapshot(RAW));
    await tick();

    expect(button("部屋を作成")).toBeUndefined();
    expect(document.querySelector("button[aria-label$='を別の部屋へ移動']")).toBeNull();
  });
});

describe("the dialog", () => {
  it("opens on a tile's move button, and a rejoin closes it", async () => {
    const h = await mountApp("operator");

    document.querySelector<HTMLButtonElement>("button[aria-label='Alpha を別の部屋へ移動']")!.click();
    await vi.waitFor(() => expect(document.querySelector("dialog")?.getAttribute("aria-label")).toBe("Alpha を別の部屋へ移動"));
    await vi.waitFor(() => expect(text()).toContain("この移動で 1 件の会話が閉じます。"));

    h.onJoined?.();
    await tick();

    expect(document.querySelector("dialog")).toBeNull();
  });

  it("reconnects after an unconfirmed move only when the operator presses reload", async () => {
    captured.moveAgent = vi.fn(async () => { throw new Error("room_change_unconfirmed"); });
    await mountApp("operator");

    document.querySelector<HTMLButtonElement>("button[aria-label='Alpha を別の部屋へ移動']")!.click();
    await vi.waitFor(() => expect(button("移動する")?.disabled).toBe(false));
    button("移動する")!.click();
    await vi.waitFor(() => expect(button("読み直す")).toBeDefined());
    expect(captured.reconnect).not.toHaveBeenCalled();

    button("読み直す")!.click();
    await tick();

    expect(captured.reconnect).toHaveBeenCalledTimes(1);
    expect(document.querySelector("dialog")).toBeNull();
  });
});

describe("offline tiles", () => {
  it("are separated by room too, an empty room left out", async () => {
    const h = await mountApp("operator");

    h.onDirectory?.({
      "h.off": { persona: { id: "p", name: "Off", sprite_set: "p" }, display_name: "Off", last_seen: null },
    });
    h.onRoomsSnapshot?.(snapshot({ ...RAW, memberships: { ...RAW.memberships, "h.off": "r2" } }));
    await tick();

    const headers = [...document.querySelectorAll(".offline .room-header")];
    expect(headers.map((x) => x.querySelector("h3")?.textContent)).toEqual(["Docs"]);
    expect(document.querySelector(".offline button[aria-label$='を改名']")).toBeNull();
  });
});

describe("language", () => {
  it("repaints the separators and buttons, and keeps the names an operator chose", async () => {
    await mountApp("operator");

    setLocale("en");
    await tick();

    const headers = [...document.querySelectorAll(".live-dashboard .room-header h3")];
    expect(headers.map((h) => h.textContent)).toEqual(["Lobby", "Review", "Docs"]);
    expect(button("Create room")).toBeDefined();
    expect(document.querySelector("button[aria-label='Rename room Review']")).not.toBeNull();
    expect(document.querySelectorAll("button[aria-label^='Move '][aria-label$=' to another room']")).toHaveLength(2);
    expect(text()).toContain("No agents in this room");
  });
});
