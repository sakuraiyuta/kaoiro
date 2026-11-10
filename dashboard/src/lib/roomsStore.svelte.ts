// The dashboard's copy of the rooms (issue #537 Phase 0). One snapshot is
// pushed after the join and after every room change; there is no request to
// read it again, so a rejoin is the only way to refresh it.
import { groupByRoom, roomOf, type RoomGroup, type RoomRef, type RoomsSnapshot, type RoomsView } from "./rooms";

export class RoomsStore {
  #view = $state<RoomsView>({ kind: "none" });

  get view(): RoomsView {
    return this.#view;
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
    return roomOf(this.#view, agentId);
  }

  group<T>(items: T[], idOf: (item: T) => string, includeEmpty: boolean): RoomGroup<T>[] {
    return groupByRoom(this.#view, items, idOf, includeEmpty);
  }
}
