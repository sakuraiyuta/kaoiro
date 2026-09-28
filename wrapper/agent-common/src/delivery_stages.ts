import type { DeliveryIntent, DeliveryStageReport, Envelope, InterAgentMessagePayload } from "@kaoiro/protocol";

export interface DeliveryStageIdentity {
  incarnation: string;
  generation: string;
}

export interface DeliveryStageTurnSource {
  deliveryEnvelopesForTurn(turnToken: string): readonly Envelope[];
}

export type DeliveryStageSender = (
  report: Omit<DeliveryStageReport, "version">,
) => void;

interface TrackedDelivery {
  key: string;
  identity: DeliveryStageIdentity | null;
  deliverySeq: number;
  mode?: DeliveryIntent;
  submitted: boolean;
  retired: boolean;
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

function deliveryKey(identity: DeliveryStageIdentity | null, sequence: number): string {
  return JSON.stringify([identity?.incarnation ?? null, identity?.generation ?? null, sequence]);
}

export class DeliveryStageReporter {
  readonly #send: DeliveryStageSender;
  readonly #identity: () => DeliveryStageIdentity | null;
  readonly #turns: DeliveryStageTurnSource;
  readonly #now: () => string;
  readonly #onOverflow: (() => void) | undefined;
  readonly #deliveries = new Map<string, TrackedDelivery>();
  readonly #deliveriesByTurn = new Map<string, Map<string, TrackedDelivery>>();
  readonly #deliveryByEnvelope = new WeakMap<Envelope, TrackedDelivery>();
  #lastIdentity: DeliveryStageIdentity | null = null;
  #warnedOverflow = false;

  constructor(options: {
    send: DeliveryStageSender;
    identity: () => DeliveryStageIdentity | null;
    turns: DeliveryStageTurnSource;
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
    this.#observeIdentity();
    const sequence = sequenceOf(envelope);
    if (sequence === undefined) return;
    this.capture(envelope);
    const delivery = this.#deliveryByEnvelope.get(envelope);
    if (delivery === undefined) return;
    this.#report(delivery, "queued", delivery.mode === undefined ? {} : { mode: delivery.mode });
  }

  capture(envelope: Envelope): void {
    this.#observeIdentity();
    if (this.#deliveryByEnvelope.has(envelope)) return;
    const sequence = sequenceOf(envelope);
    if (sequence === undefined) return;
    const delivery = this.#track(sequence, modeOf(envelope));
    if (delivery !== null) this.#deliveryByEnvelope.set(envelope, delivery);
  }

  submitted(turnToken: string, handoff: "prompt_hook" | "exec_input_written"): void {
    this.#observeIdentity();
    for (const envelope of this.#turns.deliveryEnvelopesForTurn(turnToken)) {
      this.#recordTurnEnvelope(turnToken, envelope);
    }
    this.#submit(turnToken, handoff);
  }

  submittedEnvelopes(turnToken: string, envelopes: readonly Envelope[], handoff: "tool_result"): void {
    this.#observeIdentity();
    for (const envelope of envelopes) this.#recordTurnEnvelope(turnToken, envelope);
    this.#submit(turnToken, handoff);
  }

  settled(turnToken: string): void {
    this.#observeIdentity();
    for (const envelope of this.#turns.deliveryEnvelopesForTurn(turnToken)) {
      this.#recordTurnEnvelope(turnToken, envelope);
    }
    for (const delivery of [...(this.#deliveriesByTurn.get(turnToken)?.values() ?? [])]) {
      this.#report(delivery, "settled", {
        reason: delivery.submitted ? "turn_end" : "failed_before_handoff",
      });
      this.#removeDelivery(delivery);
    }
    this.#deliveriesByTurn.delete(turnToken);
  }

  settleEnvelope(envelope: Envelope, reason: "terminal_skip" | "stale_skip"): void {
    this.#observeIdentity();
    this.capture(envelope);
    const delivery = this.#deliveryByEnvelope.get(envelope);
    if (delivery === undefined) return;
    this.#report(delivery, "settled", { reason });
    this.#removeDelivery(delivery);
  }

  #submit(
    turnToken: string,
    handoff: "prompt_hook" | "exec_input_written" | "tool_result",
  ): void {
    for (const delivery of this.#deliveriesByTurn.get(turnToken)?.values() ?? []) {
      if (delivery.submitted) continue;
      delivery.submitted = true;
      this.#report(delivery, "submitted", {
        handoff,
        ...(delivery.mode === undefined ? {} : { mode: delivery.mode }),
      });
    }
  }

  #observeIdentity(): DeliveryStageIdentity | null {
    const current = this.#identity();
    if (current !== null) {
      if (!sameIdentity(current, this.#lastIdentity)) {
        for (const delivery of [...this.#deliveries.values()]) {
          if (!sameIdentity(delivery.identity, current)) this.#removeDelivery(delivery);
        }
      }
      this.#lastIdentity = { incarnation: current.incarnation, generation: current.generation };
      return this.#lastIdentity;
    }
    return this.#lastIdentity;
  }

  #track(sequence: number, mode?: DeliveryIntent): TrackedDelivery | null {
    const capturedIdentity = this.#observeIdentity();
    const key = deliveryKey(capturedIdentity, sequence);
    const existing = this.#deliveries.get(key);
    if (existing !== undefined) return existing;
    if (this.#deliveries.size >= MAX_TRACKED_DELIVERIES) {
      if (!this.#warnedOverflow) {
        this.#warnedOverflow = true;
        this.#onOverflow?.();
      }
      return null;
    }
    this.#warnedOverflow = false;
    const delivery: TrackedDelivery = {
      key,
      identity: capturedIdentity === null ? null : { ...capturedIdentity },
      deliverySeq: sequence,
      submitted: false,
      retired: false,
      ...(mode === undefined ? {} : { mode }),
    };
    this.#deliveries.set(key, delivery);
    return delivery;
  }

  #recordTurnEnvelope(turnToken: string, envelope: Envelope): void {
    this.capture(envelope);
    const delivery = this.#deliveryByEnvelope.get(envelope);
    if (
      delivery === undefined ||
      delivery.retired ||
      this.#deliveries.get(delivery.key) !== delivery ||
      (delivery.turnToken !== undefined && delivery.turnToken !== turnToken)
    ) return;
    let deliveries = this.#deliveriesByTurn.get(turnToken);
    if (deliveries === undefined) {
      deliveries = new Map();
      this.#deliveriesByTurn.set(turnToken, deliveries);
    }
    delivery.turnToken = turnToken;
    deliveries.set(delivery.key, delivery);
  }

  #removeDelivery(delivery: TrackedDelivery): void {
    if (this.#deliveries.get(delivery.key) !== delivery) return;
    this.#deliveries.delete(delivery.key);
    delivery.retired = true;
    for (const [turnToken, deliveries] of this.#deliveriesByTurn) {
      deliveries.delete(delivery.key);
      if (deliveries.size === 0) this.#deliveriesByTurn.delete(turnToken);
    }
    this.#warnedOverflow = false;
  }

  #report(
    delivery: TrackedDelivery,
    stage: DeliveryStageReport["stage"],
    fields: Pick<DeliveryStageReport, "mode" | "handoff" | "reason"> = {},
  ): void {
    const current = this.#observeIdentity();
    if (
      delivery.retired ||
      this.#deliveries.get(delivery.key) !== delivery ||
      delivery.identity === null
    ) return;
    if (current !== null && !sameIdentity(delivery.identity, current)) {
      this.#removeDelivery(delivery);
      return;
    }
    this.#send({
      incarnation: delivery.identity.incarnation,
      generation: delivery.identity.generation,
      delivery_seq: delivery.deliverySeq,
      stage,
      ...fields,
      at: this.#now(),
    });
  }
}
