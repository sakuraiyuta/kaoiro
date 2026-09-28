import type { DeliveryIntent, DeliveryStageReport, Envelope, InterAgentMessagePayload } from "@kaoiro/protocol";
import type { DeliveryTurnSource } from "./delivery_ack.js";

export interface DeliveryStageIdentity {
  incarnation: string;
  generation: string;
}

export type DeliveryStageSender = (
  report: Omit<DeliveryStageReport, "version">,
) => void;

interface TrackedDelivery {
  identity: DeliveryStageIdentity | null;
  mode?: DeliveryIntent;
  submitted: boolean;
  turnToken?: string;
}

const MAX_TRACKED_DELIVERIES = 512;

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

function sameIdentity(a: DeliveryStageIdentity | null, b: DeliveryStageIdentity | null): boolean {
  return a !== null && b !== null && a.incarnation === b.incarnation && a.generation === b.generation;
}

export class DeliveryStageReporter {
  readonly #send: DeliveryStageSender;
  readonly #identity: () => DeliveryStageIdentity | null;
  readonly #turns: DeliveryTurnSource;
  readonly #now: () => string;
  readonly #onOverflow: (() => void) | undefined;
  readonly #deliveries = new Map<number, TrackedDelivery[]>();
  readonly #sequencesByTurn = new Map<string, Map<number, TrackedDelivery>>();
  readonly #deliveryByEnvelope = new WeakMap<Envelope, TrackedDelivery>();
  #lastIdentity: DeliveryStageIdentity | null = null;
  #deliveryCount = 0;
  #warnedOverflow = false;

  constructor(options: {
    send: DeliveryStageSender;
    identity: () => DeliveryStageIdentity | null;
    turns: DeliveryTurnSource;
    now?: () => string;
    onOverflow?: () => void;
  }) {
    this.#send = options.send;
    this.#identity = options.identity;
    this.#turns = options.turns;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#onOverflow = options.onOverflow;
  }

  queued(envelope: Envelope): void {
    const sequence = sequenceOf(envelope);
    if (sequence === undefined) return;
    this.capture(envelope);
    const delivery = this.#deliveryByEnvelope.get(envelope);
    if (delivery === undefined) return;
    this.#report(sequence, delivery, "queued", delivery.mode === undefined ? {} : { mode: delivery.mode });
  }

  capture(envelope: Envelope): void {
    if (this.#deliveryByEnvelope.has(envelope)) return;
    const sequence = sequenceOf(envelope);
    if (sequence === undefined) return;
    const delivery = this.#track(sequence, modeOf(envelope));
    if (delivery !== null) this.#deliveryByEnvelope.set(envelope, delivery);
  }

  submitted(turnToken: string, handoff: "prompt_hook" | "exec_input_written"): void {
    for (const sequence of this.#turns.deliverySequencesForTurn(turnToken)) {
      this.#recordTurnSequence(turnToken, sequence);
    }
    this.#submit(turnToken, handoff);
  }

  submittedEnvelopes(turnToken: string, envelopes: readonly Envelope[], handoff: "tool_result"): void {
    for (const envelope of envelopes) {
      const sequence = sequenceOf(envelope);
      if (sequence === undefined) continue;
      this.capture(envelope);
      const delivery = this.#deliveryByEnvelope.get(envelope);
      if (delivery !== undefined) this.#recordTurnSequence(turnToken, sequence, delivery);
    }
    this.#submit(turnToken, handoff);
  }

  settled(turnToken: string): void {
    for (const sequence of this.#turns.deliverySequencesForTurn(turnToken)) {
      this.#recordTurnSequence(turnToken, sequence);
    }
    for (const [sequence, delivery] of this.#sequencesByTurn.get(turnToken) ?? []) {
      this.#report(sequence, delivery, "settled", {
        reason: delivery.submitted ? "turn_end" : "failed_before_handoff",
      });
      this.#removeDelivery(sequence, delivery);
    }
    this.#sequencesByTurn.delete(turnToken);
  }

  settleEnvelope(envelope: Envelope, reason: "terminal_skip" | "stale_skip"): void {
    const sequence = sequenceOf(envelope);
    if (sequence === undefined) return;
    this.capture(envelope);
    const delivery = this.#deliveryByEnvelope.get(envelope);
    if (delivery === undefined) return;
    this.#report(sequence, delivery, "settled", { reason });
    this.#removeDelivery(sequence, delivery);
  }

  #submit(
    turnToken: string,
    handoff: "prompt_hook" | "exec_input_written" | "tool_result",
  ): void {
    for (const [sequence, delivery] of this.#sequencesByTurn.get(turnToken) ?? []) {
      if (delivery.submitted) continue;
      delivery.submitted = true;
      this.#report(sequence, delivery, "submitted", {
        handoff,
        ...(delivery.mode === undefined ? {} : { mode: delivery.mode }),
      });
    }
  }

  #track(sequence: number, mode?: DeliveryIntent): TrackedDelivery | null {
    const current = this.#identity();
    if (current !== null) this.#lastIdentity = current;
    const capturedIdentity = current ?? this.#lastIdentity;
    const deliveries = this.#deliveries.get(sequence) ?? [];
    const existing = deliveries.find(delivery =>
      capturedIdentity === null
        ? delivery.identity === null
        : sameIdentity(delivery.identity, capturedIdentity),
    );
    if (existing !== undefined) return existing;
    if (this.#deliveryCount >= MAX_TRACKED_DELIVERIES) {
      if (!this.#warnedOverflow) {
        this.#warnedOverflow = true;
        this.#onOverflow?.();
      }
      return null;
    }
    this.#warnedOverflow = false;
    const delivery: TrackedDelivery = {
      identity: capturedIdentity,
      submitted: false,
      ...(mode === undefined ? {} : { mode }),
    };
    deliveries.push(delivery);
    this.#deliveries.set(sequence, deliveries);
    this.#deliveryCount += 1;
    return delivery;
  }

  #recordTurnSequence(turnToken: string, sequence: number, preferred?: TrackedDelivery): void {
    let deliveries = this.#sequencesByTurn.get(turnToken);
    if (deliveries === undefined) {
      deliveries = new Map();
      this.#sequencesByTurn.set(turnToken, deliveries);
    }
    if (deliveries.has(sequence)) return;
    const candidates = this.#deliveries.get(sequence) ?? [];
    const delivery = preferred ?? candidates.find(candidate => candidate.turnToken === undefined);
    if (delivery === undefined || (delivery.turnToken !== undefined && delivery.turnToken !== turnToken)) return;
    delivery.turnToken = turnToken;
    deliveries.set(sequence, delivery);
  }

  #removeDelivery(sequence: number, delivery: TrackedDelivery): void {
    const deliveries = this.#deliveries.get(sequence);
    if (deliveries === undefined) return;
    const index = deliveries.indexOf(delivery);
    if (index < 0) return;
    deliveries.splice(index, 1);
    this.#deliveryCount -= 1;
    if (deliveries.length === 0) this.#deliveries.delete(sequence);
    this.#warnedOverflow = false;
  }

  #report(
    delivery_seq: number,
    delivery: TrackedDelivery,
    stage: DeliveryStageReport["stage"],
    fields: Pick<DeliveryStageReport, "mode" | "handoff" | "reason"> = {},
  ): void {
    if (delivery.identity === null) return;
    const current = this.#identity();
    if (current !== null && !sameIdentity(delivery.identity, current)) {
      this.#removeDelivery(delivery_seq, delivery);
      return;
    }
    this.#send({
      incarnation: delivery.identity.incarnation,
      generation: delivery.identity.generation,
      delivery_seq,
      stage,
      ...fields,
      at: this.#now(),
    });
  }
}
