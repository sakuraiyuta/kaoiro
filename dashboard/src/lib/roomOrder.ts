// This browser's own order of the rooms. The server lists rooms in id order
// (lobby first), which is stable but not meaningful, and has no order to
// change, so a reorder here is a display preference kept in localStorage and
// never reaches the server or another device. The order is held as a list of
// room ids so it can move to the server later without changing its shape.
export const ROOM_ORDER_STORAGE_KEY = "kaoiro.roomOrder.v1";

/** A missing key, malformed JSON or a non-list value reads as "no saved order". */
export function loadRoomOrder(): string[] {
  try {
    const raw = localStorage.getItem(ROOM_ORDER_STORAGE_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === "string" && id !== "");
  } catch {
    return [];
  }
}

/** Best effort: a write failure (quota, private mode) leaves the order in
 *  memory for this page and never breaks the UI. */
export function saveRoomOrder(order: readonly string[]): void {
  try {
    localStorage.setItem(ROOM_ORDER_STORAGE_KEY, JSON.stringify(order));
  } catch {
    // best-effort persistence
  }
}

/** The saved order first (an id the server no longer lists is skipped), then
 *  every room the saved order does not name, in the server's order. With no
 *  saved order this is the server's order unchanged. */
export function applyRoomOrder<T extends { id: string }>(rooms: readonly T[], order: readonly string[]): T[] {
  const byId = new Map(rooms.map((room) => [room.id, room]));
  const placed = new Set<string>();
  const ordered: T[] = [];
  for (const id of order) {
    const room = byId.get(id);
    if (room !== undefined && !placed.has(id)) {
      ordered.push(room);
      placed.add(id);
    }
  }
  for (const room of rooms) if (!placed.has(room.id)) ordered.push(room);
  return ordered;
}

/** The whole order after moving `roomId` one place (`-1` up, `1` down), or null
 *  when it is unknown or already at that end. The result names every room, so
 *  saving it also drops ids of rooms that no longer exist. */
export function shiftRoom(
  rooms: readonly { id: string }[],
  order: readonly string[],
  roomId: string,
  delta: -1 | 1,
): string[] | null {
  const ids = applyRoomOrder(rooms, order).map((room) => room.id);
  const from = ids.indexOf(roomId);
  const to = from + delta;
  if (from === -1 || to < 0 || to >= ids.length) return null;
  [ids[from], ids[to]] = [ids[to]!, ids[from]!];
  return ids;
}
