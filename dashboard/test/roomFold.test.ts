import "./isolation.setup";
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { loadRoomFold, saveRoomFold, ROOM_FOLD_STORAGE_KEY } from "../src/lib/roomFold";

afterEach(() => { vi.restoreAllMocks(); localStorage.removeItem(ROOM_FOLD_STORAGE_KEY); });

it("defaults to open and handles unavailable storage", () => {
  expect(loadRoomFold()).toEqual([]);
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw Error(); });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw Error(); });
  expect(loadRoomFold()).toEqual([]);
  expect(() => saveRoomFold(["room:a"])).not.toThrow();
});
