import type { Envelope } from "./types.js";

export const DEFAULT_INTER_AGENT_BATCH_MAX_ITEMS = 10;
export const DEFAULT_INTER_AGENT_BACKLOG_MAX_ITEMS = 100;
export const MAX_PENDING_LOSS_NOTICE_ITEMS = 16;
const MAX_COMPLETED_LOSS_IDS = 10_000;

const reservationBrand: unique symbol = Symbol("inter-agent-admission-reservation");

export interface InterAgentAdmissionReservation {
  readonly [reservationBrand]: true;
}

export type InterAgentReservationClass = "ordinary" | "waiter" | "control";
export type InterAgentReleaseReason = "handed_off" | "completed" | "retired";

export type InterAgentAdmissionResult =
  | { kind: "reserved"; reservation: InterAgentAdmissionReservation }
  | { kind: "duplicate_loss" }
  | { kind: "refused" };

export interface InterAgentDeliveryIdentity {
  incarnation?: string;
  generation?: string;
  delivery_seq?: number;
}

interface ReservationState {
  envelope: Envelope;
  reservationClass: InterAgentReservationClass;
  deliveryIdentity?: InterAgentDeliveryIdentity;
  lossId?: string;
}

export interface InterAgentAdmissionCounts {
  total: number;
  ordinary: number;
  waiter: number;
  control: number;
}

export class InterAgentAdmission {
  readonly #maxPendingItems: number;
  readonly #active = new Map<InterAgentAdmissionReservation, ReservationState>();
  readonly #byEnvelope = new WeakMap<Envelope, InterAgentAdmissionReservation>();
  readonly #deliveryIdentityByEnvelope = new WeakMap<Envelope, InterAgentDeliveryIdentity>();
  readonly #pendingLossIds = new Map<string, InterAgentAdmissionReservation>();
  readonly #completedLossIds = new Map<string, true>();
  #ordinary = 0;
  #waiter = 0;
  #control = 0;
  #refusedLosses = 0;

  constructor(maxPendingItems = DEFAULT_INTER_AGENT_BACKLOG_MAX_ITEMS) {
    if (!Number.isSafeInteger(maxPendingItems) || maxPendingItems < 1) {
      throw new RangeError("maxPendingItems must be a positive safe integer");
    }
    this.#maxPendingItems = maxPendingItems;
  }

  admit(
    envelope: Envelope,
    options: { waiter?: boolean; lossId?: string; control?: boolean } = {},
  ): InterAgentAdmissionResult {
    const existing = this.#byEnvelope.get(envelope);
    if (existing !== undefined && this.#active.has(existing)) {
      return { kind: "reserved", reservation: existing };
    }

    const deliveryIdentity = this.captureDeliveryIdentity(envelope);
    const lossId = options.lossId;
    if (lossId !== undefined) {
      if (!this.#isEligibleLoss(envelope, lossId)) {
        throw new TypeError("loss reservations require server provenance");
      }
      if (this.#pendingLossIds.has(lossId) || this.#completedLossIds.has(lossId)) {
        return { kind: "duplicate_loss" };
      }
    }

    const reservationClass: InterAgentReservationClass | undefined = options.waiter
      ? "waiter"
      : lossId !== undefined
        ? this.#ordinary + this.#waiter + this.#control < this.#maxPendingItems
          ? "ordinary"
          : options.control !== false && this.#control < MAX_PENDING_LOSS_NOTICE_ITEMS
            ? "control"
            : undefined
        : this.#ordinary + this.#waiter + this.#control < this.#maxPendingItems
          ? "ordinary"
          : undefined;
    if (reservationClass === undefined) return { kind: "refused" };

    const reservation = Object.freeze({ [reservationBrand]: true }) as InterAgentAdmissionReservation;
    this.#active.set(reservation, {
      envelope,
      reservationClass,
      ...(deliveryIdentity === undefined ? {} : { deliveryIdentity }),
      ...(lossId === undefined ? {} : { lossId }),
    });
    this.#byEnvelope.set(envelope, reservation);
    if (reservationClass === "ordinary") this.#ordinary += 1;
    else if (reservationClass === "waiter") this.#waiter += 1;
    else this.#control += 1;
    if (lossId !== undefined) this.#pendingLossIds.set(lossId, reservation);
    return { kind: "reserved", reservation };
  }

  reservationFor(envelope: Envelope): InterAgentAdmissionReservation | undefined {
    const reservation = this.#byEnvelope.get(envelope);
    return reservation !== undefined && this.#active.has(reservation) ? reservation : undefined;
  }

  isLossDuplicate(lossId: string): boolean {
    return this.#pendingLossIds.has(lossId) || this.#completedLossIds.has(lossId);
  }

  owns(reservation: InterAgentAdmissionReservation, envelope: Envelope): boolean {
    return this.#active.get(reservation)?.envelope === envelope;
  }

  captureDeliveryIdentity(
    envelope: Envelope,
    transportIdentity?: { incarnation: string; generation: string } | null,
  ): InterAgentDeliveryIdentity | undefined {
    const existing = this.#deliveryIdentityByEnvelope.get(envelope);
    if (existing !== undefined) return { ...existing };
    const sequence = (envelope as Envelope & { delivery_seq?: unknown }).delivery_seq;
    const identity: InterAgentDeliveryIdentity = {
      ...(transportIdentity?.incarnation === undefined ? {} : { incarnation: transportIdentity.incarnation }),
      ...(transportIdentity?.generation === undefined ? {} : { generation: transportIdentity.generation }),
      ...(typeof sequence === "number" && Number.isSafeInteger(sequence) && sequence > 0 ? { delivery_seq: sequence } : {}),
    };
    if (Object.keys(identity).length === 0) return undefined;
    this.#deliveryIdentityByEnvelope.set(envelope, identity);
    return { ...identity };
  }

  deliveryIdentityFor(envelope: Envelope): InterAgentDeliveryIdentity | undefined {
    const identity = this.#deliveryIdentityByEnvelope.get(envelope);
    return identity === undefined ? undefined : { ...identity };
  }

  release(
    reservation: InterAgentAdmissionReservation,
    reason: InterAgentReleaseReason,
  ): boolean {
    const state = this.#active.get(reservation);
    if (state === undefined) return false;
    this.#active.delete(reservation);
    if (this.#byEnvelope.get(state.envelope) === reservation) this.#byEnvelope.delete(state.envelope);
    if (state.reservationClass === "ordinary") this.#ordinary -= 1;
    else if (state.reservationClass === "waiter") this.#waiter -= 1;
    else this.#control -= 1;
    if (state.lossId !== undefined && this.#pendingLossIds.get(state.lossId) === reservation) {
      this.#pendingLossIds.delete(state.lossId);
      if (reason === "handed_off" || reason === "completed") this.#completeLoss(state.lossId);
    }
    return true;
  }

  releaseEnvelope(envelope: Envelope, reason: InterAgentReleaseReason): boolean {
    const reservation = this.reservationFor(envelope);
    return reservation === undefined ? false : this.release(reservation, reason);
  }

  completeLoss(lossId: string): void {
    this.#completeLoss(lossId);
  }

  recordRefusedLoss(): number {
    this.#refusedLosses += 1;
    return this.#refusedLosses;
  }

  get refusedLosses(): number {
    return this.#refusedLosses;
  }

  get maxPendingItems(): number {
    return this.#maxPendingItems;
  }

  admitFallback(envelope: Envelope): InterAgentAdmissionResult & { lossId?: string; retirementAttemptCount?: number } {
    const payload = envelope.payload as { loss_id?: unknown; turn_number?: unknown };
    const lossId = envelope.agent_id === "server" && payload.turn_number === 0 && typeof payload.loss_id === "string"
      ? payload.loss_id
      : undefined;
    const result = this.admit(envelope, {
      control: false,
      ...(lossId === undefined ? {} : { lossId }),
    });
    if (result.kind !== "refused" || lossId === undefined) return { ...result, ...(lossId === undefined ? {} : { lossId }) };
    return { ...result, lossId, retirementAttemptCount: this.recordRefusedLoss() };
  }

  counts(): InterAgentAdmissionCounts {
    return {
      total: this.#ordinary + this.#waiter + this.#control,
      ordinary: this.#ordinary,
      waiter: this.#waiter,
      control: this.#control,
    };
  }

  #completeLoss(lossId: string): void {
    this.#completedLossIds.delete(lossId);
    this.#completedLossIds.set(lossId, true);
    while (this.#completedLossIds.size > MAX_COMPLETED_LOSS_IDS) {
      const oldest = this.#completedLossIds.keys().next().value;
      if (oldest === undefined) break;
      this.#completedLossIds.delete(oldest);
    }
  }

  #isEligibleLoss(envelope: Envelope, lossId: string): boolean {
    const payload = envelope.payload as { loss_id?: unknown; turn_number?: unknown };
    return envelope.agent_id === "server" && payload.turn_number === 0 && payload.loss_id === lossId;
  }
}
