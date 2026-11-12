// The dashboard's copy of the rooms (issue #537 Phase 0). One snapshot is
// pushed after the join and after every room change; there is no request to
// read it again, so a rejoin is the only way to refresh it.
import { groupByRoom, roomOf, type RoomGroup, type RoomRef, type RoomsSnapshot, type RoomsView } from "./rooms";
import { applyRoomOrder, loadRoomOrder, saveRoomOrder, shiftRoom } from "./roomOrder";

export class RoomsStore {
  #view = $state<RoomsView>({ kind: "none" });
  /** This browser's room order (see roomOrder.ts); empty means the server's. */
  #order = $state<string[]>(loadRoomOrder());
  readonly #listsEveryAgent: () => boolean;

  /** `listsEveryAgent`: the snapshot names every agent the server holds only for
   *  an operator. A viewer's omits agents the server has not (re)registered, so
   *  for a viewer an omission is never read as "in the lobby". */
  constructor(listsEveryAgent: () => boolean) {
    this.#listsEveryAgent = listsEveryAgent;
  }

  get view(): RoomsView {
    return this.#view;
  }

  #placement(): RoomsView {
    const view = this.#view;
    if (view.kind !== "loaded") return view;
    const rooms = applyRoomOrder(view.rooms, this.#order);
    return !view.incomplete && !this.#listsEveryAgent()
      ? { ...view, rooms, incomplete: true }
      : { ...view, rooms };
  }

  /** Whether `roomId` can move one place that way in the displayed order. */
  canMoveRoom(roomId: string, delta: -1 | 1): boolean {
    const view = this.#view;
    return view.kind === "loaded" && shiftRoom(view.rooms, this.#order, roomId, delta) !== null;
  }

  /** Moves a room one place up (`-1`) or down (`1`) and keeps the result in
   *  this browser. Nothing is sent to the server. */
  moveRoom(roomId: string, delta: -1 | 1): void {
    const view = this.#view;
    if (view.kind !== "loaded") return;
    const next = shiftRoom(view.rooms, this.#order, roomId, delta);
    if (next === null) return;
    this.#order = next;
    saveRoomOrder(next);
  }

  /** Replaces everything: each snapshot is the whole state. */
  apply(snapshot: RoomsSnapshot): void {
    this.#view = { kind: "loaded", ...snapshot };
  }

  /** A new connection or a logout: nothing held belongs to the next join. */
  reset(): void {
    this.#view = { kind: "none" };
  }

  roomOf(agentId: string): RoomRef | null {
    return roomOf(this.#placement(), agentId);
  }

  group<T>(items: T[], idOf: (item: T) => string, includeEmpty: boolean): RoomGroup<T>[] {
    return groupByRoom(this.#placement(), items, idOf, includeEmpty);
  }
}
