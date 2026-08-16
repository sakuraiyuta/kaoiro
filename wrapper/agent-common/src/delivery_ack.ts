/** Client-side contiguous-prefix tracker for issue #247.  Server state is
 * authoritative; this object only prevents a later coalesced batch from
 * acknowledging an earlier one that has not reached a real SDK turn yet. */
export class DeliveryAcknowledger {
  #acked = 0;
  readonly #completed = new Set<number>();

  /** Rejoin status may arrive after an envelope callback.  Keep completed
   * numbers until the authoritative baseline is known, then advance only a
   * contiguous prefix. */
  bind(ackedSeq: number): number | null {
    if (!Number.isSafeInteger(ackedSeq) || ackedSeq < this.#acked) return null;
    this.#acked = ackedSeq;
    return this.#advance();
  }

  complete(seq: unknown): number | null {
    if (
      typeof seq !== "number" ||
      !Number.isSafeInteger(seq) ||
      seq <= this.#acked ||
      seq <= 0
    ) return null;
    this.#completed.add(seq);
    return this.#advance();
  }

  #advance(): number | null {
    let advanced = false;
    while (this.#completed.delete(this.#acked + 1)) {
      this.#acked += 1;
      advanced = true;
    }
    return advanced ? this.#acked : null;
  }
}
