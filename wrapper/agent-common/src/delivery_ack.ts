import type { Envelope } from "./types.js";

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

/** The coordinator shape shared by both engine adapters.  Keeping this
 * structural avoids making agent-common depend on either adapter. */
export interface DeliveryTurnSource {
  deliverySequencesForTurn(turnToken: string): readonly number[];
}

/** Production acknowledgement composition for issue #247.  Both CLI
 * adapters hand this same object to their inbound handler and their actual
 * host `onTurnStart` hook; adapter tests import it rather than restating the
 * watermark loop in a fixture. */
export class DeliveryAcknowledgement {
  readonly #ledger = new DeliveryAcknowledger();
  readonly #send: (deliverySeq: number) => void;

  constructor(send: (deliverySeq: number) => void) {
    this.#send = send;
  }

  /** Reconcile the server's authoritative baseline after a join/rejoin. */
  observe(status: { acked_seq: number } | null): void {
    if (status === null) return;
    this.#sendIfAdvanced(this.#ledger.bind(status.acked_seq));
  }

  /** Intentional non-injection has completed locally and cannot reach SDK. */
  readonly acknowledgeEnvelope = (envelope: Envelope): void => {
    this.#sendIfAdvanced(
      this.#ledger.complete((envelope as Envelope & { delivery_seq?: unknown }).delivery_seq),
    );
  };

  /** Actual SDK turn start is the confirmation point for injected batches. */
  readonly acknowledgeTurnStart = (turnToken: string, turns: DeliveryTurnSource): void => {
    for (const seq of turns.deliverySequencesForTurn(turnToken)) {
      this.#sendIfAdvanced(this.#ledger.complete(seq));
    }
  };

  #sendIfAdvanced(ack: number | null): void {
    if (ack !== null) this.#send(ack);
  }
}
