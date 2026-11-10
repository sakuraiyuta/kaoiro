// Issue #537 Phase 0: the dashboard's reading of the rooms. The three states of
// the snapshot (none, complete, incomplete) are the load-bearing part: a client
// must never show an agent in the lobby when the server did not say so.
import "./isolation.setup";
import { describe, expect, it } from "vitest";
import { setLocale } from "../src/lib/i18n/index.svelte";
import {
  isUnconfirmed,
  parseRoomChange,
  parseRoomPreview,
  parseRoomReply,
  parseRoomsSnapshot,
  roomErrorText,
  roomOf,
  type RoomsView,
} from "../src/lib/rooms";

const RAW = {
  rooms: [{ id: "lobby", name: null }, { id: "r1", name: "Review" }, { id: "r2", name: "Empty" }],
  memberships: { "h.a": "lobby", "h.b": "r1" },
};

function loaded(raw: unknown): RoomsView {
  const parsed = parseRoomsSnapshot(raw);
  if (parsed === null) throw new Error("not a snapshot");
  return { kind: "loaded", ...parsed };
}

describe("parseRoomsSnapshot", () => {
  it("keeps the rooms in the server's order and reads the memberships", () => {
    const parsed = parseRoomsSnapshot(RAW);
    expect(parsed?.rooms.map((room) => room.id)).toEqual(["lobby", "r1", "r2"]);
    expect(parsed?.rooms[0]?.name).toBeNull();
    expect(parsed?.memberships.get("h.b")).toBe("r1");
    expect(parsed?.incomplete).toBe(false);
  });

  it("reads snapshot_incomplete", () => {
    expect(parseRoomsSnapshot({ ...RAW, snapshot_incomplete: true })?.incomplete).toBe(true);
  });

  it.each([
    ["not an object", "x"],
    ["no rooms", { memberships: {} }],
    ["no memberships", { rooms: RAW.rooms }],
    ["no lobby", { rooms: [{ id: "r1", name: "Review" }], memberships: {} }],
  ])("returns null for a payload it cannot vouch for: %s", (_label, raw) => {
    expect(parseRoomsSnapshot(raw)).toBeNull();
  });

  it("drops a malformed or repeated room entry alone", () => {
    const parsed = parseRoomsSnapshot({
      rooms: [{ id: "lobby", name: null }, { id: "", name: "x" }, { id: "r1", name: 3 }, { id: "lobby", name: "again" }, { id: "r2", name: "Ok" }],
      memberships: {},
    });
    expect(parsed?.rooms).toEqual([{ id: "lobby", name: null }, { id: "r2", name: "Ok" }]);
  });

  it("marks the snapshot incomplete when a membership is unreadable, instead of reading it as the lobby", () => {
    const parsed = parseRoomsSnapshot({ ...RAW, memberships: { "h.a": 7, "h.b": "r1" } });
    expect(parsed?.incomplete).toBe(true);
    expect(parsed?.memberships.has("h.a")).toBe(false);
  });

  it("keeps an agent id such as __proto__ as a plain key", () => {
    const parsed = parseRoomsSnapshot(JSON.parse('{"rooms":[{"id":"lobby","name":null},{"id":"r1","name":"R"}],"memberships":{"__proto__":"r1"}}'));
    expect(parsed?.memberships.get("__proto__")).toBe("r1");
  });
});

describe("roomOf: the three states", () => {
  it("is null while no snapshot has arrived", () => {
    expect(roomOf({ kind: "none" }, "h.a")).toBeNull();
  });

  it("places a listed agent in the room the server named", () => {
    expect(roomOf(loaded(RAW), "h.b")).toEqual({ kind: "room", id: "r1" });
  });

  it("places an agent a complete snapshot does not list in the lobby (it was created after the snapshot)", () => {
    expect(roomOf(loaded(RAW), "h.new")).toEqual({ kind: "room", id: "lobby" });
  });

  it("does not place an agent an incomplete snapshot does not list in the lobby", () => {
    expect(roomOf(loaded({ ...RAW, snapshot_incomplete: true }), "h.new")).toEqual({ kind: "unknown" });
  });

  it.each([false, true])("treats a room the snapshot does not list as unknown (incomplete: %s)", (incomplete) => {
    const view = loaded({ ...RAW, memberships: { "h.a": "gone" }, snapshot_incomplete: incomplete });
    expect(roomOf(view, "h.a")).toEqual({ kind: "unknown" });
  });
});

describe("reply parsers", () => {
  it("read a counted preview and a change result, and reject anything else", () => {
    expect(parseRoomPreview({ closing_count: 2, member_count: 3 })).toEqual({ closingCount: 2, memberCount: 3 });
    expect(parseRoomChange({ closed_count: 0, member_count: 1 })).toEqual({ closedCount: 0, movedCount: 1 });
    for (const bad of [{}, { closing_count: -1, member_count: 0 }, { closing_count: 1.5, member_count: 0 }, { closing_count: "1", member_count: 0 }, null]) {
      expect(parseRoomPreview(bad)).toBeNull();
    }
    expect(parseRoomChange({ closed_count: 1 })).toBeNull();
  });

  it("read the room of create_room and rename_room", () => {
    expect(parseRoomReply({ room: { id: "r1", name: "Review" } })).toEqual({ id: "r1", name: "Review" });
    expect(parseRoomReply({ room: { id: "r1" } })).toBeNull();
    expect(parseRoomReply({})).toBeNull();
  });
});

describe("server codes", () => {
  it("shows a known code in the UI language and an unknown one as it is", () => {
    expect(roomErrorText("lobby_protected")).toBe("ロビーは削除できません");
    expect(roomErrorText("brand_new_code")).toBe("失敗しました (brand_new_code)");
    setLocale("en");
    expect(roomErrorText("lobby_protected")).toBe("The lobby cannot be deleted");
    expect(roomErrorText("brand_new_code")).toBe("Failed (brand_new_code)");
  });

  it.each(["constructor", "__proto__", "toString"])("does not read %s off the table's prototype", (code) => {
    expect(roomErrorText(code)).toBe(`失敗しました (${code})`);
  });

  it("calls a missing, unreadable or unconfirmed answer unconfirmed, and a plain refusal not", () => {
    expect(["room_change_unconfirmed", "timeout", "invalid_reply"].every(isUnconfirmed)).toBe(true);
    expect(["rooms_unavailable", "unknown_room", "forbidden"].some(isUnconfirmed)).toBe(false);
  });
});
