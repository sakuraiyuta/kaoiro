// The dashboard's copy of every agent's latest status line (issue 482). Kept
// here, keyed by agent id and independent of the card set: a line can arrive
// before the envelope that creates its card, because the server announces an
// agent that just became visible from inside the write that made it so.
import {
  isNewer,
  type StatusLineRow,
  type StatusLineView,
} from "./statusLine";
import { trimIncompleteMarkdown } from "./truncatedMarkdown";

export class StatusLines {
  #rows = $state<Record<string, StatusLineRow>>({});
  /** A snapshot has arrived on this connection. */
  #loaded = $state(false);
  /** The snapshot said it could not vouch for the whole set. */
  #incomplete = $state(false);
  /** The trim of each agent's last truncated head. A view is built again
   *  whenever any row changes, and a hostile head takes tens of milliseconds. */
  #trims = new Map<string, { head: string; shown: string }>();

  /** Replaces everything with the join snapshot, including an earlier
   *  incomplete state: a complete snapshot on rejoin clears it. */
  applySnapshot(rows: Record<string, StatusLineRow>, incomplete: boolean): void {
    this.#rows = rows;
    this.#incomplete = incomplete;
    this.#loaded = true;
    this.#trims.clear();
  }

  /** A live event, applied only if strictly newer than what is held. An older
   *  event arriving after a newer snapshot, or after a stamped clear, is
   *  ignored. A clear is stored as a row, never removed, for that reason. */
  applyLive(agentId: string, row: StatusLineRow): void {
    const held = this.#rows[agentId];
    if (held !== undefined && !isNewer(row, held)) return;
    this.#rows = { ...this.#rows, [agentId]: row };
  }

  /** `agent_deleted`: the agent and its line are gone. */
  remove(agentId: string): void {
    this.#trims.delete(agentId);
    if (!(agentId in this.#rows)) return;
    const { [agentId]: _removed, ...rest } = this.#rows;
    this.#rows = rest;
  }

  /** A new connection or a logout: nothing held belongs to the next join. */
  reset(): void {
    this.#rows = {};
    this.#loaded = false;
    this.#incomplete = false;
    this.#trims.clear();
  }

  #trimmed(agentId: string, head: string): string {
    const held = this.#trims.get(agentId);
    if (held !== undefined && held.head === head) return held.shown;
    const shown = trimIncompleteMarkdown(head);
    this.#trims.set(agentId, { head, shown });
    return shown;
  }

  /** The stamp of an agent's held row, for a dialog to notice a new line. */
  stampOf(agentId: string): string | null {
    const row = this.#rows[agentId];
    return row === undefined ? null : `${row.updatedAt}#${row.seq}`;
  }

  view(agentId: string): StatusLineView {
    const row = this.#rows[agentId];
    if (row !== undefined) {
      return row.cleared
        ? { kind: "unset", cleared: true }
        : {
            kind: "set",
            // A head the server cut may stop inside markup; a complete line is
            // drawn as written.
            head: row.truncated ? this.#trimmed(agentId, row.head) : row.head,
            truncated: row.truncated,
            bytes: row.bytes,
            updatedAt: row.updatedAt,
          };
    }
    return this.#loaded && !this.#incomplete
      ? { kind: "unset", cleared: false }
      : { kind: "none" };
  }
}
