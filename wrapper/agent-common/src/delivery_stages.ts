import type { DeliveryIntent, DeliveryStageReport, Envelope, InterAgentMessagePayload } from "@kaoiro/protocol";
import type { DeliveryTurnSource } from "./delivery_ack.js";

export interface DeliveryStageIdentity {
  incarnation: string;
  generation: string;
}

export type DeliveryStageSender = (
  report: Omit<DeliveryStageReport, "version">,
) => void;

function sequenceOf(envelope: Envelope): number | undefined {
  const value = (envelope as Envelope & { delivery_seq?: unknown }).delivery_seq;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function modeOf(envelope: Envelope): DeliveryIntent | undefined {
  if (envelope.type !== "inter_agent_message") return undefined;
  const payload = envelope.payload as unknown as InterAgentMessagePayload;
  const mode = payload.delivery_authority?.granted;
  return mode === "normal" || mode === "early" || mode === "yield" ? mode : undefined;
}

export class DeliveryStageReporter {
  readonly #send: DeliveryStageSender;
  readonly #identity: () => DeliveryStageIdentity | null;
  readonly #turns: DeliveryTurnSource;
  readonly #now: () => string;
  readonly #modeBySequence = new Map<number, DeliveryIntent>();
  readonly #submitted = new Set<number>();

  constructor(options: {
    send: DeliveryStageSender;
    identity: () => DeliveryStageIdentity | null;
    turns: DeliveryTurnSource;
    now?: () => string;
  }) {
    this.#send = options.send;
    this.#identity = options.identity;
    this.#turns = options.turns;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  queued(envelope: Envelope): void {
    const sequence = sequenceOf(envelope);
    if (sequence === undefined) return;
    const mode = modeOf(envelope);
    if (mode !== undefined) this.#modeBySequence.set(sequence, mode);
    this.#report(sequence, "queued", { ...(mode === undefined ? {} : { mode }) });
  }

  submitted(turnToken: string, handoff: "prompt_hook" | "exec_input_written"): void {
    for (const sequence of this.#turns.deliverySequencesForTurn(turnToken)) {
      if (this.#submitted.has(sequence)) continue;
      this.#submitted.add(sequence);
      const mode = this.#modeBySequence.get(sequence);
      this.#report(sequence, "submitted", {
        handoff,
        ...(mode === undefined ? {} : { mode }),
      });
    }
  }

  settled(turnToken: string): void {
    for (const sequence of this.#turns.deliverySequencesForTurn(turnToken)) {
      this.#settleSequence(sequence, this.#submitted.has(sequence) ? "turn_end" : "failed_before_handoff");
    }
  }

  settleEnvelope(envelope: Envelope, reason: "terminal_skip" | "stale_skip"): void {
    const sequence = sequenceOf(envelope);
    if (sequence !== undefined) this.#settleSequence(sequence, reason);
  }

  #settleSequence(sequence: number, reason: string): void {
    this.#report(sequence, "settled", { reason });
    this.#modeBySequence.delete(sequence);
    this.#submitted.delete(sequence);
  }

  #report(
    delivery_seq: number,
    stage: DeliveryStageReport["stage"],
    fields: Pick<DeliveryStageReport, "mode" | "handoff" | "reason"> = {},
  ): void {
    const identity = this.#identity();
    if (identity === null) return;
    this.#send({
      incarnation: identity.incarnation,
      generation: identity.generation,
      delivery_seq,
      stage,
      ...fields,
      at: this.#now(),
    });
  }
}
