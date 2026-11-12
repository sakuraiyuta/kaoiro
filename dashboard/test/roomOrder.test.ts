// This browser's room order: how a saved list of ids is applied to the rooms
// the server lists, and that a bad stored value never breaks the page.
import "./isolation.setup";
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  applyRoomOrder,
  loadRoomOrder,
  ROOM_ORDER_STORAGE_KEY,
  saveRoomOrder,
  shiftRoom,
} from "../src/lib/roomOrder";

const rooms = [{ id: "lobby" }, { id: "a" }, { id: "b" }, { id: "c" }];
const ids = (list: { id: string }[]) => list.map((room) => room.id);

afterEach(() => localStorage.removeItem(ROOM_ORDER_STORAGE_KEY));

describe("applyRoomOrder", () => {
  it("is the server's order when nothing is saved", () => {
    expect(ids(applyRoomOrder(rooms, []))).toEqual(["lobby", "a", "b", "c"]);
  });

  it("puts the saved order first, even ahead of the lobby", () => {
    expect(ids(applyRoomOrder(rooms, ["c", "lobby", "a", "b"]))).toEqual(["c", "lobby", "a", "b"]);
  });

  it("appends a room the saved order does not name, in the server's order", () => {
    expect(ids(applyRoomOrder(rooms, ["b", "a"]))).toEqual(["b", "a", "lobby", "c"]);
  });

  it("skips an id the server no longer lists and counts a repeated id once", () => {
    expect(ids(applyRoomOrder(rooms, ["gone", "b", "b", "a"]))).toEqual(["b", "a", "lobby", "c"]);
  });
});

describe("shiftRoom", () => {
  it("swaps a room with its neighbour and returns every room's id", () => {
    expect(shiftRoom(rooms, [], "b", -1)).toEqual(["lobby", "b", "a", "c"]);
    expect(shiftRoom(rooms, [], "b", 1)).toEqual(["lobby", "a", "c", "b"]);
  });

  it("moves within the displayed order, not the server's", () => {
    expect(shiftRoom(rooms, ["c", "lobby", "a", "b"], "lobby", -1)).toEqual(["lobby", "c", "a", "b"]);
  });

  it("returns null at either end and for an unknown room", () => {
    expect(shiftRoom(rooms, [], "lobby", -1)).toBeNull();
    expect(shiftRoom(rooms, [], "c", 1)).toBeNull();
    expect(shiftRoom(rooms, [], "gone", 1)).toBeNull();
  });

  it("drops an id of a room that no longer exists from what it saves", () => {
    expect(shiftRoom(rooms, ["gone", "a"], "lobby", 1)).toEqual(["a", "b", "lobby", "c"]);
  });
});

describe("loadRoomOrder and saveRoomOrder", () => {
  it("round-trips a list", () => {
    saveRoomOrder(["b", "a"]);
    expect(loadRoomOrder()).toEqual(["b", "a"]);
  });

  it("reads a missing, malformed or non-list value as no saved order", () => {
    expect(loadRoomOrder()).toEqual([]);
    localStorage.setItem(ROOM_ORDER_STORAGE_KEY, "{not json");
    expect(loadRoomOrder()).toEqual([]);
    localStorage.setItem(ROOM_ORDER_STORAGE_KEY, JSON.stringify({ a: 1 }));
    expect(loadRoomOrder()).toEqual([]);
  });

  it("keeps only the non-empty strings of a list", () => {
    localStorage.setItem(ROOM_ORDER_STORAGE_KEY, JSON.stringify(["a", 3, "", null, "b"]));
    expect(loadRoomOrder()).toEqual(["a", "b"]);
  });
});
