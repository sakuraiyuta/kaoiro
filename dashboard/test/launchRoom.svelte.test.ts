import "./isolation.setup";
// @vitest-environment jsdom
// issue #1081 Phase 1-1: the launch dialog picks the room a new agent starts
// in, and that choice reaches the spawn request. One test per claim of the
// design (T11a-T11f), so one mutation turns exactly one of them red. The file
// is `.svelte.test.ts` because T11e needs a reactive prop: a room that leaves
// the snapshot while the dialog is open.
import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import LaunchDialog from "../src/lib/LaunchDialog.svelte";
import { LOBBY_ID, roomErrorText, type Room } from "../src/lib/rooms";
import type { HostInfo, KaoiroConnection } from "../src/lib/protocol";

// jsdom does not implement HTMLDialogElement.showModal/close (same polyfill
// as launchDialogModal.integration.test.ts).
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

const BLUE = "11111111-2222-3333-4444-555555555555";
const mounted: object[] = [];

function bothRooms(): Room[] {
  return [
    { id: LOBBY_ID, name: null },
    { id: BLUE, name: "Blue" },
  ];
}

function host(): HostInfo {
  return {
    host_id: "host-a",
    personas: [{ id: "ao", name: "あお", sprite_set: "ao" }],
    cwd_allowlist: ["/workspace"],
    capabilities: ["claude-code"],
    engines: [{ id: "claude-code", models: [] }],
  };
}

function makeConnection(spawn?: () => Promise<{ agentId: string }>): KaoiroConnection {
  return {
    spawn: vi.fn(spawn ?? (async () => ({ agentId: "host-a.new" }))),
    enumerateSessions: vi.fn(async () => undefined),
    setModel: vi.fn(async () => undefined),
    setEffort: vi.fn(async () => undefined),
    refreshModels: vi.fn(async () => undefined),
    refreshEngineCatalog: vi.fn(async () => ({
      host_id: "host-a",
      engine: "claude-code",
      request_id: "r",
      ok: true,
    })),
    getLaunchDefaults: vi.fn(async () => ({})),
  } as unknown as KaoiroConnection;
}

beforeEach(() => {
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
  for (const component of mounted.splice(0)) await unmount(component);
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

// `rooms` is handed over as a getter onto a `$state` holder, so a test can
// take a room away while the dialog is open (T11e).
function render(options: { rooms?: Room[]; spawn?: () => Promise<{ agentId: string }> } = {}) {
  const holder = $state({ rooms: options.rooms ?? bothRooms() });
  const target = document.createElement("div");
  document.body.append(target);
  const conn = makeConnection(options.spawn);

  const component = mount(LaunchDialog, {
    target,
    props: {
      hosts: [host()],
      connection: conn,
      sessions: { host_id: "host-a", cwd: "/workspace", sessions: [{ session_id: "past" }] },
      get rooms() {
        return holder.rooms;
      },
      onClose: vi.fn(),
    },
  });

  mounted.push(component);
  return { target, conn, holder };
}

function findLabel(target: Element, label: string): HTMLElement | undefined {
  return [...target.querySelectorAll("label")].find((n) => n.textContent?.includes(label));
}

function labelledSelect(target: Element, label: string): HTMLSelectElement {
  const sel = findLabel(target, label)?.querySelector("select");
  if (!(sel instanceof HTMLSelectElement)) throw new Error(`no select for ${label}`);
  return sel;
}

async function selectValue(select: HTMLSelectElement, value: string) {
  select.value = value;
  select.dispatchEvent(new Event("change", { bubbles: true }));
  await tick();
}

async function submit(target: Element) {
  target
    .querySelector("form")!
    .dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
  await tick();
  await Promise.resolve();
}

function request(conn: KaoiroConnection): Record<string, unknown> {
  const calls = vi.mocked(conn.spawn).mock.calls;
  expect(calls).toHaveLength(1);
  return calls[0][0] as unknown as Record<string, unknown>;
}

describe("LaunchDialog room picker (issue #1081 Phase 1-1)", () => {
  it("T11a a picked room rides the spawn request", async () => {
    const { target, conn } = render();
    await tick();
    await selectValue(labelledSelect(target, "部屋"), BLUE);
    await submit(target);

    expect(request(conn).room_id).toBe(BLUE);
  });

  it("T11b the default is the lobby, which omits the key", async () => {
    const { target, conn } = render();
    await tick();
    expect(labelledSelect(target, "部屋").value).toBe(LOBBY_ID);
    await submit(target);

    expect(request(conn)).not.toHaveProperty("room_id");
  });

  it("T11c without a snapshot there is no control and no room", async () => {
    const { target, conn } = render({ rooms: [] });
    await tick();
    expect(findLabel(target, "部屋")).toBeUndefined();
    await submit(target);

    expect(request(conn)).not.toHaveProperty("room_id");
  });

  it("T11d resume mode picks a room too, alongside its session", async () => {
    const { target, conn } = render();
    await tick();
    const resume = [...target.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === "再開",
    )!;
    resume.click();
    await tick();

    await selectValue(labelledSelect(target, "部屋"), BLUE);
    await submit(target);

    const sent = request(conn);
    expect(sent.room_id).toBe(BLUE);
    expect(sent.resume_session_id).toBe("past");
  });

  it("T11e a room that leaves the snapshot returns the choice to the lobby", async () => {
    const { target, conn, holder } = render();
    await tick();
    await selectValue(labelledSelect(target, "部屋"), BLUE);

    // The operator deleted it from another tab while this dialog was open.
    holder.rooms = [{ id: LOBBY_ID, name: null }];
    await tick();
    await submit(target);

    expect(request(conn)).not.toHaveProperty("room_id");
  });

  it("T11f a room refusal is shown in the room vocabulary", async () => {
    for (const code of ["unknown_room", "rooms_unavailable", "room_change_unconfirmed"]) {
      const { target } = render({
        spawn: async () => {
          throw new Error(code);
        },
      });
      await tick();
      await submit(target);

      expect(target.textContent).toContain(roomErrorText(code));
      for (const component of mounted.splice(0)) await unmount(component);
      document.body.innerHTML = "";
    }
  });
});
