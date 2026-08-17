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

/** Delivery-acknowledgement semantics for issue #247. The runtime builder
 * below applies this object to each production component connection; focused
 * tests can exercise the watermark loop without duplicating it in a fixture. */
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

/** The three acknowledgement callbacks used by focused semantic tests. The
 * runtime builder below, not an adapter fixture, owns their production
 * connection to ServerLink, the inbound handler, and the host. */
export interface DeliveryAcknowledgementWiring {
  onInterAgentDeliveryStatus(status: { acked_seq: number } | null): void;
  acknowledgeDelivery(envelope: Envelope): void;
  onTurnStart(turnToken: string): void;
}

/** Builds focused delivery-ack callbacks for tests and internal callers. */
export function createDeliveryAcknowledgementWiring(
  send: (deliverySeq: number) => void,
  turns: DeliveryTurnSource,
): DeliveryAcknowledgementWiring {
  const acknowledgement = new DeliveryAcknowledgement(send);

  return {
    onInterAgentDeliveryStatus: (status) => acknowledgement.observe(status),
    acknowledgeDelivery: acknowledgement.acknowledgeEnvelope,
    onTurnStart: (turnToken) =>
      acknowledgement.acknowledgeTurnStart(turnToken, turns),
  };
}

/** The production composition boundary for delivery acknowledgements.  A
 * CLI gives this builder the options/context for its concrete ServerLink,
 * inbound handler, and host; the builder adds the three acknowledgement
 * connections as one unit.  This deliberately owns the connections rather
 * than returning callbacks for an adapter fixture to wire independently. */
export interface DeliveryAcknowledgementRuntime {
  withServerLinkOptions<TOptions extends object>(
    options: TOptions,
  ): TOptions & {
    onInterAgentDeliveryStatus(status: { acked_seq: number } | null): void;
  };
  withInboundContext<TContext extends object>(context: TContext): TContext & {
    acknowledgeDelivery(envelope: Envelope): void;
  };
  withHostOptions<TOptions extends object>(
    options: TOptions,
    afterTurnStart?: (turnToken: string) => void,
  ): TOptions & {
    onTurnStart(info: { turnToken: string }): void;
  };
}

/** Builds the actual three-way runtime connection for issue #247.  The
 * generic option/context wrappers keep agent-common independent of either
 * adapter's ServerLink and Host classes while ensuring their connection is
 * owned by production code in one place. */
export function createDeliveryAcknowledgementRuntime(
  send: (deliverySeq: number) => void,
  turns: DeliveryTurnSource,
): DeliveryAcknowledgementRuntime {
  const acknowledgement = new DeliveryAcknowledgement(send);

  return {
    withServerLinkOptions: (options) => ({
      ...options,
      onInterAgentDeliveryStatus: (status: { acked_seq: number } | null) =>
        acknowledgement.observe(status),
    }),
    withInboundContext: (context) => ({
      ...context,
      acknowledgeDelivery: acknowledgement.acknowledgeEnvelope,
    }),
    withHostOptions: (options, afterTurnStart) => ({
      ...options,
      onTurnStart: ({ turnToken }: { turnToken: string }) => {
        acknowledgement.acknowledgeTurnStart(turnToken, turns);
        afterTurnStart?.(turnToken);
      },
    }),
  };
}
