import type { DeliveryIntent, DeliveryStageReport, Envelope, InterAgentMessagePayload, YieldDisposition } from "@kaoiro/protocol";

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
  steer?: boolean;
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
  /** A rejected capture still owns its first join identity; a late callback must not borrow a reused sequence. */
  readonly #capturedIdentityByEnvelope = new WeakMap<Envelope, DeliveryStageIdentity | null>();
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
    const sequence = sequenceOf(envelope);
    if (sequence === undefined) return;
    if (this.#capturedIdentityByEnvelope.has(envelope)) return;
    const capturedIdentity = this.#observeIdentity();
    const receiptIdentity = capturedIdentity === null ? null : { ...capturedIdentity };
    this.#capturedIdentityByEnvelope.set(envelope, receiptIdentity);
    const delivery = this.#track(sequence, modeOf(envelope), receiptIdentity);
    if (delivery !== null) this.#deliveryByEnvelope.set(envelope, delivery);
  }

  submitted(turnToken: string, handoff: "prompt_hook" | "exec_input_written" | "turn_start_accepted"): void {
    this.#observeIdentity();
    for (const envelope of this.#turns.deliveryEnvelopesForTurn(turnToken)) {
      this.#recordTurnEnvelope(turnToken, envelope);
    }
    this.#submit(turnToken, handoff);
  }

  submittedEnvelopes(turnToken: string, envelopes: readonly Envelope[], handoff: "tool_result" | "fold_hook" | "prompt_hook"): void {
    this.#observeIdentity();
    for (const envelope of envelopes) this.#recordTurnEnvelope(turnToken, envelope);
    this.#submit(turnToken, handoff);
  }

  steerSubmitted(turnToken: string, envelopes: readonly Envelope[], handoff: "turn_steer_accepted" | "turn_steer_item_observed"): void {
    this.#observeIdentity();
    for (const envelope of envelopes) {
      this.#recordTurnEnvelope(turnToken, envelope);
      const delivery = this.#deliveryByEnvelope.get(envelope);
      if (delivery === undefined || delivery.submitted) continue;
      delivery.steer = true;
      delivery.submitted = true;
      this.#report(delivery, "submitted", { handoff,
        ...(delivery.mode === undefined ? {} : { mode: delivery.mode }) });
    }
  }

  steerUnknown(envelopes: readonly Envelope[], reason: string, handoff: "turn_steer_write_uncertain" | "turn_steer_accepted" | "turn_steer_item_observed"): void {
    this.#observeIdentity();
    for (const envelope of envelopes) {
      this.capture(envelope);
      const delivery = this.#deliveryByEnvelope.get(envelope);
      if (delivery === undefined) continue;
      this.#report(delivery, "unknown", { reason, mode: "early",
        ...(delivery.submitted ? {} : { handoff }) });
      this.#removeDelivery(delivery);
    }
  }

  steerSettled(envelopes: readonly Envelope[]): void {
    this.#observeIdentity();
    for (const envelope of envelopes) {
      this.capture(envelope);
      const delivery = this.#deliveryByEnvelope.get(envelope);
      if (delivery === undefined) continue;
      this.#report(delivery, "settled", { reason: "turn_end" });
      this.#removeDelivery(delivery);
    }
  }

  includedEnvelopes(envelopes: readonly Envelope[]): void {
    this.#observeIdentity();
    for (const envelope of envelopes) {
      this.capture(envelope);
      const delivery = this.#deliveryByEnvelope.get(envelope);
      if (delivery !== undefined) this.#report(delivery, "included", { evidence: "ticket_used" });
    }
  }

  unknownEnvelopes(envelopes: readonly Envelope[], reason: string): void {
    this.#observeIdentity();
    for (const envelope of envelopes) {
      this.capture(envelope);
      const delivery = this.#deliveryByEnvelope.get(envelope);
      if (delivery === undefined) continue;
      this.#report(delivery, "unknown", { reason });
      this.#removeDelivery(delivery);
    }
  }

  yieldDisposition(envelope: Envelope, disposition: YieldDisposition): void {
    this.#observeIdentity();
    this.capture(envelope);
    const delivery = this.#deliveryByEnvelope.get(envelope);
    if (delivery !== undefined) this.#report(delivery, "queued", { yield_disposition: disposition });
  }

  settled(turnToken: string): void {
    this.#observeIdentity();
    for (const envelope of this.#turns.deliveryEnvelopesForTurn(turnToken)) {
      this.#recordTurnEnvelope(turnToken, envelope);
    }
    for (const delivery of [...(this.#deliveriesByTurn.get(turnToken)?.values() ?? [])]) {
      if (delivery.steer) continue;
      this.#report(delivery, "settled", {
        reason: delivery.submitted ? "turn_end" : "failed_before_handoff",
      });
      this.#removeDelivery(delivery);
    }
    this.#deliveriesByTurn.delete(turnToken);
  }

  /** The turn's input may have reached the engine but its outcome cannot be
   * established. The delivery ends on `unknown`, with no later `settled`: the
   * server keeps a single last-written `reason`, which a `settled` would replace. */
  unknownTurn(turnToken: string, reason: string): void {
    this.#observeIdentity();
    for (const envelope of this.#turns.deliveryEnvelopesForTurn(turnToken)) {
      this.#recordTurnEnvelope(turnToken, envelope);
    }
    for (const delivery of [...(this.#deliveriesByTurn.get(turnToken)?.values() ?? [])]) {
      if (delivery.steer) continue;
      // Unreachable while the unknown outcome exists only before the reply,
      // hence before `submitted`; kept so a submitted delivery is never
      // reported as unknown.
      if (delivery.submitted) this.#report(delivery, "settled", { reason: "turn_end" });
      else this.#report(delivery, "unknown", { reason });
      this.#removeDelivery(delivery);
    }
    this.#deliveriesByTurn.delete(turnToken);
  }

  settleEnvelope(envelope: Envelope, reason: "terminal_skip" | "stale_skip" | "receiver_overloaded"): void {
    this.#observeIdentity();
    this.capture(envelope);
    const delivery = this.#deliveryByEnvelope.get(envelope);
    if (delivery === undefined) return;
    this.#report(delivery, "settled", { reason });
    this.#removeDelivery(delivery);
  }

  #submit(
    turnToken: string,
    handoff: "prompt_hook" | "fold_hook" | "exec_input_written" | "turn_start_accepted" | "tool_result" | "turn_steer_accepted" | "turn_steer_item_observed",
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

  #track(
    sequence: number,
    mode: DeliveryIntent | undefined,
    capturedIdentity: DeliveryStageIdentity | null,
  ): TrackedDelivery | null {
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
    fields: Pick<DeliveryStageReport, "mode" | "handoff" | "reason" | "evidence" | "yield_disposition"> = {},
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
