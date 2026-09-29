/** Response-side finals of one `turn/steer` request (design r3 §1). */
export type SteerResponse =
  | { kind: "A" }
  | { kind: "V"; turnId: string }
  | { kind: "P"; reason: string }
  | { kind: "E"; code: number; message: string }
  | { kind: "C" };

/** Terminal-side finals: `turn/completed` of the owning turn, or a stream
 * that ended without one (connection failure, close, watchdog fail-stop). */
export type SteerTerminal = "T" | "X";

export type SteerOutcome =
  | { kind: "included" }
  | { kind: "requeued"; reason: string }
  | { kind: "refused"; code: number; message: string }
  | { kind: "unknown"; reason: "not_observed" | "connection" | "protocol_violation" | "protocol_contradiction" };

/** The settlement table of design r3 §1. Order-independent by construction:
 * it sees only the response kind, whether the input item was observed before
 * the terminal side became final, and the terminal kind. */
export function settleSteer(response: SteerResponse, observed: boolean, terminal: SteerTerminal): SteerOutcome {
  switch (response.kind) {
    case "A": return observed ? { kind: "included" }
      : { kind: "unknown", reason: terminal === "T" ? "not_observed" : "connection" };
    case "V": return { kind: "unknown", reason: "protocol_violation" };
    case "P": return observed ? { kind: "unknown", reason: "protocol_contradiction" }
      : { kind: "requeued", reason: response.reason };
    case "E": return observed ? { kind: "unknown", reason: "protocol_contradiction" }
      : { kind: "refused", code: response.code, message: response.message };
    case "C": return observed ? { kind: "included" } : { kind: "unknown", reason: "connection" };
  }
}

export interface SteerRecordOptions {
  /** Runs synchronously after the response side latches and before any
   * settlement, so work that must precede settlement (the P placeholder)
   * happens in the response's own synchronous section. */
  onResponse?: (response: SteerResponse) => void;
  onSettle: (outcome: SteerOutcome) => void;
}

/** One steered input. Each side keeps only its first final event; settlement
 * happens on the single write that makes both sides final, which is why no
 * separate "settled" flag exists: each latch is load-bearing. */
export class SteerRecord {
  #response: SteerResponse | null = null;
  #terminal: SteerTerminal | null = null;
  #observed = false;
  readonly #options: SteerRecordOptions;

  constructor(readonly clientUserMessageId: string, readonly turnId: string, options: SteerRecordOptions) {
    this.#options = options;
  }

  get settled(): boolean { return this.#response !== null && this.#terminal !== null; }

  /** Returns false when the response side was already final. */
  respond(response: SteerResponse): boolean {
    if (this.#response !== null) return false;
    this.#response = response;
    this.#options.onResponse?.(response);
    this.#settleIfFinal();
    return true;
  }

  /** An input item seen after the terminal side is final never counts. */
  observe(): boolean {
    if (this.#terminal !== null || this.#observed) return false;
    this.#observed = true;
    return true;
  }

  /** Returns false when the terminal side was already final. */
  end(terminal: SteerTerminal): boolean {
    if (this.#terminal !== null) return false;
    this.#terminal = terminal;
    this.#settleIfFinal();
    return true;
  }

  #settleIfFinal(): void {
    if (this.#response === null || this.#terminal === null) return;
    this.#options.onSettle(settleSteer(this.#response, this.#observed, this.#terminal));
  }
}
