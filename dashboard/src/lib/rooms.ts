// Rooms (issue #537 Phase 0): reading `rooms_snapshot` and grouping agent tiles
// by room. The contract is docs/reference/inter-agent/rooms.md.
import { msg } from "./i18n/index.svelte";

export const LOBBY_ID = "lobby";

export interface Room {
  id: string;
  /** Null only for a lobby nobody renamed; a client shows its own default. */
  name: string | null;
}

export interface RoomsSnapshot {
  rooms: Room[];
  /** A Map, not an object: an agent id such as `__proto__` is a plain key. */
  memberships: ReadonlyMap<string, string>;
  /** The server cut memberships to the frame budget (or one was unreadable):
   *  an agent without an entry is then unknown, not in the lobby. */
  incomplete: boolean;
}

/** `none`: no snapshot on this connection (an older server, or rooms the
 *  server could not read). The grid stays flat and no room control is shown. */
export type RoomsView = { kind: "none" } | ({ kind: "loaded" } & RoomsSnapshot);

export type RoomRef = { kind: "room"; id: string } | { kind: "unknown" };

export interface RoomPreview {
  closingCount: number;
  memberCount: number;
}

export interface RoomChangeResult {
  closedCount: number;
  movedCount: number;
}

/** What the room dialog was opened for. `currentRoomId` is null when the
 *  agent's room is not confirmed, so every room is a destination. */
export type RoomRequest =
  | { mode: "create" }
  | { mode: "rename"; room: Room }
  | { mode: "move"; agentId: string; label: string; currentRoomId: string | null }
  | { mode: "delete"; room: Room };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function parseRoom(raw: unknown): Room | null {
  if (!isRecord(raw) || typeof raw.id !== "string" || raw.id === "") return null;
  if (raw.name !== null && typeof raw.name !== "string") return null;
  return { id: raw.id, name: raw.name };
}

/** Null when the payload is not a snapshot or has no lobby: the caller keeps
 *  what it held rather than guess. A malformed membership marks the snapshot
 *  incomplete, so a dropped entry never reads as "in the lobby". */
export function parseRoomsSnapshot(raw: unknown): RoomsSnapshot | null {
  if (!isRecord(raw) || !Array.isArray(raw.rooms) || !isRecord(raw.memberships)) return null;
  const rooms: Room[] = [];
  for (const entry of raw.rooms) {
    const room = parseRoom(entry);
    if (room !== null && !rooms.some((held) => held.id === room.id)) rooms.push(room);
  }
  if (!rooms.some((room) => room.id === LOBBY_ID)) return null;
  let incomplete = raw.snapshot_incomplete === true;
  const memberships = new Map<string, string>();
  for (const [agentId, roomId] of Object.entries(raw.memberships)) {
    if (typeof roomId === "string" && roomId !== "") memberships.set(agentId, roomId);
    else incomplete = true;
  }
  return { rooms, memberships, incomplete };
}

/** The reply to `create_room` / `rename_room`: `{ room: { id, name } }`. */
export function parseRoomReply(raw: unknown): Room | null {
  return isRecord(raw) ? parseRoom(raw.room) : null;
}

/** The reply to `preview_room_move` / `preview_room_delete`. */
export function parseRoomPreview(raw: unknown): RoomPreview | null {
  if (!isRecord(raw)) return null;
  const closingCount = count(raw.closing_count);
  const memberCount = count(raw.member_count);
  return closingCount === null || memberCount === null ? null : { closingCount, memberCount };
}

/** The reply to `move_agent` / `delete_room`. */
export function parseRoomChange(raw: unknown): RoomChangeResult | null {
  if (!isRecord(raw)) return null;
  const closedCount = count(raw.closed_count);
  const movedCount = count(raw.member_count);
  return closedCount === null || movedCount === null ? null : { closedCount, movedCount };
}

/** Where an agent is. Null when there is no snapshot. An agent the snapshot
 *  does not list is in the lobby only when the snapshot is complete: the
 *  server lists every agent it holds, so a missing one was created after the
 *  snapshot, and a new agent is in the lobby. */
export function roomOf(view: RoomsView, agentId: string): RoomRef | null {
  if (view.kind === "none") return null;
  const roomId = view.memberships.get(agentId);
  if (roomId === undefined) {
    return view.incomplete ? { kind: "unknown" } : { kind: "room", id: LOBBY_ID };
  }
  return view.rooms.some((room) => room.id === roomId)
    ? { kind: "room", id: roomId }
    : { kind: "unknown" };
}

export interface RoomGroup<T> {
  key: string;
  /** `null`: no snapshot, one flat group. `"unknown"`: not confirmed. */
  room: Room | "unknown" | null;
  items: T[];
}

/** Lobby first, then the other rooms in the server's order, then agents whose
 *  room is not confirmed. `includeEmpty` keeps a room with no tile (the live
 *  grid shows it so the operator can manage it). */
export function groupByRoom<T>(
  view: RoomsView,
  items: T[],
  idOf: (item: T) => string,
  includeEmpty: boolean,
): RoomGroup<T>[] {
  if (view.kind === "none") return [{ key: "flat", room: null, items }];
  const byRoom = new Map<string, T[]>(view.rooms.map((room) => [room.id, []]));
  const unknown: T[] = [];
  for (const item of items) {
    const ref = roomOf(view, idOf(item));
    if (ref?.kind === "room") byRoom.get(ref.id)?.push(item);
    else unknown.push(item);
  }
  const groups: RoomGroup<T>[] = view.rooms
    .map((room) => ({ key: `room:${room.id}`, room, items: byRoom.get(room.id) ?? [] }))
    .filter((group) => includeEmpty || group.items.length > 0);
  if (unknown.length > 0) groups.push({ key: "unknown", room: "unknown", items: unknown });
  return groups;
}

/** Read inside a template or a function only (see the i18n rules). */
export function roomName(room: Room): string {
  return room.name ?? (room.id === LOBBY_ID ? msg().rooms.lobbyDefaultName : room.id);
}

/** After these the change may or may not have been applied: the operator must
 *  read the rooms again. */
export function isUnconfirmed(code: string): boolean {
  return code === "room_change_unconfirmed" || code === "timeout" || code === "invalid_reply";
}

/** A known server code has its own message; an unknown one is printed as is. */
export function roomErrorText(code: string): string {
  const table: Record<string, string> = msg().rooms.error;
  const known = Object.hasOwn(table, code) ? table[code] : undefined;
  return known ?? msg().rooms.errorUnknown({ code });
}
