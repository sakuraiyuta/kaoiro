import type { ConversationSummary, Envelope } from "./protocol";
import type { RoomsView } from "./rooms";

export type RoomCleanupTargets = {
  members: string[];
  conversationIds: string[];
  agentIds: string[];
};

export function copyRoomView(view: RoomsView): RoomsView {
  return view.kind === "none" ? view : {
    kind: "loaded", rooms: view.rooms.map((room) => ({ ...room })),
    memberships: new Map(view.memberships), incomplete: view.incomplete,
  };
}

export function sameRoomSnapshot(left: RoomsView, right: RoomsView): boolean {
  if (left.kind !== "loaded" || right.kind !== "loaded" || left.incomplete || right.incomplete) return false;
  const leftIds = left.rooms.map((room) => room.id).sort();
  const rightIds = right.rooms.map((room) => room.id).sort();
  return JSON.stringify(leftIds) === JSON.stringify(rightIds)
    && left.memberships.size === right.memberships.size
    && [...left.memberships].every(([id, room]) => right.memberships.get(id) === room);
}

export function roomCleanupTargets(
  roomId: string, view: RoomsView, agents: Record<string, Envelope>,
  conversations: readonly ConversationSummary[],
): RoomCleanupTargets | null {
  if (view.kind !== "loaded" || view.incomplete || !view.rooms.some((room) => room.id === roomId)) return null;
  const roomIds = new Set(view.rooms.map((room) => room.id));
  const resolved = (id: string): boolean => {
    const room = view.memberships.get(id);
    return room !== undefined && roomIds.has(room);
  };
  if (Object.keys(agents).some((id) => !resolved(id))) return null;
  const open = conversations.filter((item) => item.status === "open");
  if (open.some((item) => item.participants.length === 0 || item.participants.some((id) => !resolved(id)))) return null;
  return {
    members: [...view.memberships].filter(([, room]) => room === roomId).map(([id]) => id).sort(),
    conversationIds: open.filter((item) => item.participants.every((id) => view.memberships.get(id) === roomId))
      .map((item) => item.conversationId).sort(),
    agentIds: Object.entries(agents).filter(([id, agent]) => agent.state !== "disconnected" && view.memberships.get(id) === roomId)
      .map(([id]) => id).sort(),
  };
}

export function sameRoomTargets(left: RoomCleanupTargets, right: RoomCleanupTargets): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
