// Per-peer batching and dispatch ownership for Codex inbound inter-agent
// turns. The CLI provides the host/transport edge, while this production
// object owns every queue transition so lifecycle tests cannot reimplement
// it separately (issue #216).

import { randomUUID } from "node:crypto";

import {
  DEFAULT_INTER_AGENT_BACKLOG_MAX_ITEMS,
  DEFAULT_INTER_AGENT_BATCH_MAX_ITEMS,
  InterAgentAdmission,
  canAddToCoalescedBatch,
  formatInboundMessage,
  formatInboundMessages,
  ordinaryPeerInput,
} from "@kaoiro/agent-common";
import type {
  Envelope,
  InterAgentAdmissionReservation,
  InboundReplyMode,
  InterAgentMessagePayload,
} from "@kaoiro/agent-common";

export interface CodexInterAgentBatchItem {
  envelope: Envelope;
  mode: InboundReplyMode;
  reservation?: InterAgentAdmissionReservation;
}

/** One batch accepted by the coordinator and assigned to a Codex turn. */
export interface DispatchedCodexInterAgentBatch {
  /** Immutable ownership capability for this exact queued SDK turn. */
  turnToken: string;
  peer: string;
  items: readonly CodexInterAgentBatchItem[];
  conversationIds: readonly string[];
  text: string;
  fallbackId?: string;
}

interface PendingBatch {
  items: CodexInterAgentBatchItem[];
  bytes: number;
}

interface SteerReservation {
  id: string;
  envelope: Envelope;
  mode: InboundReplyMode;
  peer: string;
  arrival: number;
  slot: boolean;
  status: "steering" | "fallback";
  reservation: InterAgentAdmissionReservation;
}

const MAX_STEER_RECOVERY_RECORDS = 256;

export interface CodexInterAgentTurnCoordinatorOptions {
  /** Runs synchronously once a free peer receives its oldest queued batch. */
  onDispatch: (batch: DispatchedCodexInterAgentBatch) => unknown;
  reclassifyQueued?: (item: CodexInterAgentBatchItem) => InboundReplyMode;
  onTerminalQueued?: (item: CodexInterAgentBatchItem) => void;
  canDispatchPeer?: (peer: string) => boolean;
  /** Injectable only for deterministic tests. Production uses UUIDs. */
  createTurnToken?: () => string;
  createPlaceholder?: (id: string, arrival: number) => boolean;
  removePlaceholder?: (id: string) => void;
  retireDiscarded?: (envelopes: readonly Envelope[]) => void;
  onFallbackDispatchFailure?: (batch: DispatchedCodexInterAgentBatch) => void;
  admission?: InterAgentAdmission;
  maxBatchItems?: number;
}

/**
 * Owns same-peer batching and busy-turn dispatch. A peer may have exactly one
 * host turn in flight; arrivals while that turn runs append to its FIFO queue.
 * Host completion must call settle() before dispatchNextForPeer(), so a later
 * batch reusing a conversation ID cannot overwrite the prior pending record.
 */
export class CodexInterAgentTurnCoordinator {
  readonly #receiveOrder = new WeakMap<Envelope, number>();
  #nextReceiveOrder = 0;
  readonly #inputStarted = new Set<string>();
  readonly #recoveryLeases = new Set<readonly Envelope[]>();
  readonly #steeredRecovery = new Map<string, Envelope>();
  #steerRecoveryEvictions = 0;
  readonly #pendingBatches = new Map<string, PendingBatch[]>();
  readonly #steerReservations = new Map<string, SteerReservation>();
  readonly #frozenSteers = new Map<string, { envelope: Envelope; reservation: InterAgentAdmissionReservation }>();
  readonly #pendingFallbacks = new Map<string, SteerReservation[]>();
  readonly #batchByTurnToken = new Map<string, DispatchedCodexInterAgentBatch>();
  readonly #activeTokenByPeer = new Map<string, string>();
  readonly #onDispatch: (batch: DispatchedCodexInterAgentBatch) => unknown;
  readonly #reclassifyQueued: ((item: CodexInterAgentBatchItem) => InboundReplyMode) | undefined;
  readonly #onTerminalQueued: ((item: CodexInterAgentBatchItem) => void) | undefined;
  readonly #canDispatchPeer: ((peer: string) => boolean) | undefined;
  readonly #createTurnToken: () => string;
  readonly #createPlaceholder: ((id: string, arrival: number) => boolean) | undefined;
  readonly #removePlaceholder: ((id: string) => void) | undefined;
  readonly #onFallbackDispatchFailure: ((batch: DispatchedCodexInterAgentBatch) => void) | undefined;
  readonly #retired = new WeakSet<Envelope>();
  readonly #admission: InterAgentAdmission;
  readonly #maxBatchItems: number;
  #closed = false;
  #retireDiscarded: ((envelopes: readonly Envelope[]) => void) | undefined;

  constructor(options: CodexInterAgentTurnCoordinatorOptions) {
    this.#onDispatch = options.onDispatch;
    this.#reclassifyQueued = options.reclassifyQueued;
    this.#onTerminalQueued = options.onTerminalQueued;
    this.#canDispatchPeer = options.canDispatchPeer;
    this.#createTurnToken = options.createTurnToken ?? randomUUID;
    this.#createPlaceholder = options.createPlaceholder;
    this.#removePlaceholder = options.removePlaceholder;
    this.#retireDiscarded = options.retireDiscarded;
    this.#onFallbackDispatchFailure = options.onFallbackDispatchFailure;
    this.#admission = options.admission ?? new InterAgentAdmission(DEFAULT_INTER_AGENT_BACKLOG_MAX_ITEMS);
    this.#maxBatchItems = options.maxBatchItems ?? DEFAULT_INTER_AGENT_BATCH_MAX_ITEMS;
  }

  get pendingSteerReservationCount(): number { return this.#steerReservations.size; }
  get pendingFrozenSteerCount(): number { return this.#frozenSteers.size; }

  reserveSteer(id: string, envelope: Envelope, mode: InboundReplyMode, arrival: number, reservation?: InterAgentAdmissionReservation): boolean {
    if (this.#closed || this.#steerReservations.has(id)) return false;
    const held = reservation ?? this.#admission.reservationFor(envelope) ?? this.#reserveDirect(envelope);
    if (!this.#admission.owns(held, envelope)) return false;
    this.#steerReservations.set(id, { id, envelope, mode, peer: envelope.agent_id, arrival, slot: false, status: "steering", reservation: held });
    return true;
  }

  attachSteerPlaceholder(id: string): boolean {
    const reservation = this.#steerReservations.get(id);
    if (reservation === undefined || reservation.status !== "steering" || reservation.slot || this.#closed ||
        this.#createPlaceholder?.(id, reservation.arrival) !== true) return false;
    reservation.slot = true;
    return true;
  }

  discardSteerReservation(id: string): void {
    this.#frozenSteers.delete(id);
    const reservation = this.#steerReservations.get(id);
    this.#releaseSteerReservation(id);
    if (reservation !== undefined) this.#admission.release(reservation.reservation, "retired");
  }

  transferSteerReservation(id: string): InterAgentAdmissionReservation | undefined {
    const reservation = this.#steerReservations.get(id);
    if (reservation === undefined) return undefined;
    this.#frozenSteers.delete(id);
    this.#releaseSteerReservation(id);
    return reservation.reservation;
  }

  #releaseSteerReservation(id: string): void {
    const reservation = this.#steerReservations.get(id);
    if (reservation === undefined) return;
    this.#steerReservations.delete(id);
    this.#removePendingFallback(reservation);
    if (reservation.slot) this.#removePlaceholder?.(id);
  }

  settleSteerReservation(id: string, fallback: boolean, terminalReason: "handed_off" | "retired" = "handed_off"): void {
    const reservation = this.#steerReservations.get(id);
    if (reservation === undefined) {
      const frozen = this.#frozenSteers.get(id);
      this.#frozenSteers.delete(id);
      if (frozen !== undefined) {
        if (fallback) this.retireEnvelopes([frozen.envelope]);
        this.#admission.release(frozen.reservation, fallback ? "retired" : terminalReason);
      }
      return;
    }
    if (reservation.status !== "steering") return;
    if (!fallback) {
      this.#admission.release(reservation.reservation, terminalReason);
      this.#releaseSteerReservation(id);
      return;
    }
    if (!reservation.slot && !this.attachSteerPlaceholder(id)) {
      this.discardSteerReservation(id);
      this.retireEnvelopes([reservation.envelope]);
      return;
    }
    const item = { envelope: reservation.envelope, mode: reservation.mode, reservation: reservation.reservation };
    if ((this.#reclassifyQueued?.(item) ?? item.mode) === "terminal") {
      this.#onTerminalQueued?.(item);
      this.#releaseSteerReservation(id);
      this.#admission.release(reservation.reservation, "completed");
      return;
    }
    if (this.#closed) {
      this.#releaseSteerReservation(id);
      this.#admission.release(reservation.reservation, "retired");
      this.retireEnvelopes([reservation.envelope]);
      return;
    }
    reservation.status = "fallback";
    const queue = this.#pendingFallbacks.get(reservation.peer) ?? [];
    queue.push(reservation);
    queue.sort((a, b) => a.arrival - b.arrival);
    this.#pendingFallbacks.set(reservation.peer, queue);
    this.#dispatchNext(reservation.peer);
  }

  retireEnvelopes(envelopes: readonly Envelope[]): void {
    const fresh = envelopes.filter(envelope => {
      if (this.#retired.has(envelope)) return false;
      this.#retired.add(envelope);
      return true;
    });
    if (fresh.length > 0) this.#retireDiscarded?.(fresh);
  }

  #removePendingFallback(reservation: SteerReservation): void {
    const queue = this.#pendingFallbacks.get(reservation.peer);
    if (queue === undefined) return;
    const index = queue.indexOf(reservation);
    if (index !== -1) queue.splice(index, 1);
    if (queue.length === 0) this.#pendingFallbacks.delete(reservation.peer);
  }

  /** Stops future dispatch after a watchdog fail-stop while retaining the
   * exact SDK-active generation. Unstarted generations are deliberately
   * discarded; the active generation remains unresolved for supervisor
   * recovery and must not be acknowledged by a late callback. */
  freezeForWatchdogFailStop(activeTurnToken?: string, retire?: (envelopes: readonly Envelope[]) => void): {
    droppedDispatched: number;
    droppedPending: number;
  } {
    if (this.#closed) return { droppedDispatched: 0, droppedPending: 0 };
    this.#closed = true;
    if (retire !== undefined) this.#retireDiscarded = retire;
    let droppedDispatched = 0;
    let droppedPending = 0;
    for (const [turnToken, batch] of this.#batchByTurnToken) {
      if (activeTurnToken !== undefined && turnToken === activeTurnToken) continue;
      this.#batchByTurnToken.delete(turnToken);
      this.#releaseBatch(batch, "retired");
      if (this.#activeTokenByPeer.get(batch.peer) === turnToken) {
        this.#activeTokenByPeer.delete(batch.peer);
      }
      this.retireEnvelopes(batch.items.map((item) => item.envelope));
      droppedDispatched += 1;
    }
    for (const reservation of [...this.#steerReservations.values()]) {
      if (reservation.status === "steering") {
        this.#frozenSteers.set(reservation.id, { envelope: reservation.envelope, reservation: reservation.reservation });
      }
      this.#releaseSteerReservation(reservation.id);
      if (reservation.status === "fallback") {
        this.#admission.release(reservation.reservation, "retired");
        this.retireEnvelopes([reservation.envelope]);
      }
      droppedPending += 1;
    }
    for (const batches of this.#pendingBatches.values()) {
      for (const item of batches.flatMap(batch => batch.items)) if (item.reservation !== undefined) this.#admission.release(item.reservation, "retired");
      this.retireEnvelopes(batches.flatMap((batch) => batch.items.map((item) => item.envelope)));
      droppedPending += batches.length;
    }
    this.#pendingBatches.clear();
    return { droppedDispatched, droppedPending };
  }

  /** Queue an accepted inbound and dispatch immediately if its peer is free. */
  unreadCount(activeToken: string | null): number {
    return [...this.#batchByTurnToken.values()].filter(batch => batch.turnToken !== activeToken && batch.fallbackId === undefined).reduce((n, batch) => n + batch.items.length, 0)
      + [...this.#pendingBatches.values()].flat().reduce((n, batch) => n + batch.items.length, 0)
      + [...this.#recoveryLeases].reduce((n, items) => n + items.length, 0);
  }

  claimRecovery(cid: string, peer: string, activeToken: string | null, fit: (envelopes: readonly Envelope[]) => boolean, expectedTurn?: number): { envelopes: readonly Envelope[]; oversizedPending?: boolean; foldedEarlier?: true; recoverySource?: "handoff_queue" | "retained_fold"; commit: () => void; rollback: () => void } | undefined {
    if (expectedTurn !== undefined) {
      const retained = this.#steeredRecovery.get(JSON.stringify([cid, peer, expectedTurn]));
      if (retained !== undefined) {
        if (!fit([retained])) return { envelopes: [], oversizedPending: true, foldedEarlier: true, recoverySource: "retained_fold", commit: () => {}, rollback: () => {} };
        return { envelopes: [retained], foldedEarlier: true, recoverySource: "retained_fold", commit: () => {}, rollback: () => {} };
      }
    }
    const selected: CodexInterAgentBatchItem[] = [];
    const candidates = [
      ...[...this.#batchByTurnToken.values()].filter(batch => batch.peer === peer && batch.turnToken !== activeToken && !this.#inputStarted.has(batch.turnToken) && batch.fallbackId === undefined).flatMap(batch => batch.items),
      ...(this.#pendingBatches.get(peer) ?? []).flatMap(batch => batch.items),
    ];
    for (const item of candidates) {
      if (item.envelope.payload.conversation_id !== cid || item.envelope.agent_id !== peer || item.envelope.payload.notice_type !== undefined) continue;
      if (!fit([...selected, item].map(i => i.envelope))) {
        if (!selected.length) return { envelopes: [], oversizedPending: true, recoverySource: "handoff_queue", commit: () => {}, rollback: () => {} };
        break;
      }
      selected.push(item);
    }
    if (!selected.length) return undefined;
    const priorDispatched = new Map(this.#batchByTurnToken);
    const priorPending = (this.#pendingBatches.get(peer) ?? []).map(batch => ({ batch, items: [...batch.items] }));
    const taken = new Set(selected);
    for (const [token, batch] of this.#batchByTurnToken) {
      const items = batch.items.filter(item => !taken.has(item));
      if (items.length !== batch.items.length) this.#batchByTurnToken.set(token, { ...batch, items });
    }
    for (const batch of this.#pendingBatches.get(peer) ?? []) {
      batch.items = batch.items.filter(item => !taken.has(item));
      batch.bytes = Buffer.byteLength(formatInboundMessages(batch.items), "utf8");
    }
    const envelopes = selected.map(item => item.envelope);
    this.#recoveryLeases.add(envelopes);
    let settled = false;
    return { envelopes,
      commit: () => { settled = true; this.#recoveryLeases.delete(envelopes); this.#releaseItems(selected, "handed_off"); },
      rollback: () => {
        if (settled) return; settled = true; this.#recoveryLeases.delete(envelopes);
        if (this.#closed) { this.#releaseItems(selected, "retired"); this.retireEnvelopes(selected.map(item => item.envelope)); return; }
        const remaining = new Set(selected);
        const restore = (before: readonly CodexInterAgentBatchItem[], current: readonly CodexInterAgentBatchItem[]): CodexInterAgentBatchItem[] => {
          const restored = before.filter(item => remaining.delete(item));
          return [...current, ...restored].sort((a, b) => this.#receiveOrder.get(a.envelope)! - this.#receiveOrder.get(b.envelope)!);
        };
        for (const [token, before] of priorDispatched) {
          const current = this.#batchByTurnToken.get(token);
          if (current && !this.#inputStarted.has(token)) this.#batchByTurnToken.set(token, { ...current, items: restore(before.items, current.items) });
        }
        for (const { batch, items } of priorPending) if (this.#pendingBatches.get(peer)?.includes(batch)) {
          batch.items = restore(items, batch.items); batch.bytes = Buffer.byteLength(formatInboundMessages(batch.items), "utf8");
        }
        if (!remaining.size) return;
        const returned = [...remaining];
        const queue = this.#pendingBatches.get(peer) ?? [];
        queue.unshift({ items: returned, bytes: Buffer.byteLength(formatInboundMessages(returned), "utf8") });
        this.#pendingBatches.set(peer, queue);
        this.#dispatchNext(peer);
      },
    };
  }

  retainSteeredBody(envelopes: readonly Envelope[]): void {
    for (const envelope of envelopes) {
      if (!ordinaryPeerInput(envelope)) continue;
      const payload = envelope.payload as unknown as InterAgentMessagePayload;
      const key = JSON.stringify([payload.conversation_id, envelope.agent_id, payload.turn_number]);
      if (this.#steeredRecovery.has(key)) continue;
      if (this.#steeredRecovery.size >= MAX_STEER_RECOVERY_RECORDS) {
        const oldest = this.#steeredRecovery.keys().next().value;
        if (oldest !== undefined) this.#steeredRecovery.delete(oldest);
        this.#steerRecoveryEvictions++;
      }
      this.#steeredRecovery.set(key, envelope);
    }
  }

  creditSteeredBody(envelopes: readonly Envelope[]): void {
    for (const envelope of envelopes) {
      if (!ordinaryPeerInput(envelope)) continue;
      const payload = envelope.payload as unknown as InterAgentMessagePayload;
      this.#steeredRecovery.delete(JSON.stringify([payload.conversation_id, envelope.agent_id, payload.turn_number]));
    }
  }

  retireSteeredBeforeConfirmed(envelopes: readonly Envelope[]): void {
    for (const envelope of envelopes) {
      if (!ordinaryPeerInput(envelope)) continue;
      const payload = envelope.payload as unknown as InterAgentMessagePayload;
      for (const [key, prior] of this.#steeredRecovery) {
        const priorPayload = prior.payload as unknown as InterAgentMessagePayload;
        if (prior.agent_id === envelope.agent_id && priorPayload.conversation_id === payload.conversation_id && priorPayload.turn_number < payload.turn_number) {
          this.#steeredRecovery.delete(key);
        }
      }
    }
  }

  resetSteeredRecovery(): void { this.#steeredRecovery.clear(); }
  get steerRecoveryEvictions(): number { return this.#steerRecoveryEvictions; }

  #reserveDirect(envelope: Envelope): InterAgentAdmissionReservation {
    const result = this.#admission.admit(envelope);
    if (result.kind !== "reserved") throw new Error("inter-agent input capacity exceeded");
    return result.reservation;
  }

  #releaseItems(items: readonly CodexInterAgentBatchItem[], reason: "handed_off" | "completed" | "retired"): void {
    for (const item of items) if (item.reservation !== undefined) this.#admission.release(item.reservation, reason);
  }

  #releaseBatch(batch: { items: readonly CodexInterAgentBatchItem[] }, reason: "handed_off" | "completed" | "retired"): void {
    this.#releaseItems(batch.items, reason);
  }

  handoff(turnToken: string): void {
    const batch = this.#batchByTurnToken.get(turnToken);
    if (batch !== undefined) this.#releaseBatch(batch, "handed_off");
  }

  receive(envelope: Envelope, mode: InboundReplyMode, reservation?: InterAgentAdmissionReservation): void {
    if (this.#closed) {
      const held = reservation ?? this.#admission.reservationFor(envelope);
      if (held !== undefined && this.#admission.owns(held, envelope)) this.#admission.release(held, "retired");
      this.retireEnvelopes([envelope]); return;
    }
    const held = reservation ?? this.#admission.reservationFor(envelope) ?? this.#reserveDirect(envelope);
    if (!this.#admission.owns(held, envelope)) throw new Error("inter-agent input reservation is missing, foreign, or released");
    if (!this.#receiveOrder.has(envelope)) this.#receiveOrder.set(envelope, this.#nextReceiveOrder++);
    const peer = envelope.agent_id;
    const item: CodexInterAgentBatchItem = { envelope, mode, reservation: held };
    const itemBytes = Buffer.byteLength(
      formatInboundMessage(envelope, { mode }),
      "utf8",
    );
    let queue = this.#pendingBatches.get(peer);
    if (queue === undefined) {
      queue = [];
      this.#pendingBatches.set(peer, queue);
    }
    let open = queue[queue.length - 1];
    if (
      open === undefined ||
      !canAddToCoalescedBatch(open.items.length, open.bytes, itemBytes, this.#maxBatchItems)
    ) {
      open = { items: [], bytes: 0 };
      queue.push(open);
    }
    open.items.push(item);
    open.bytes += itemBytes;
    this.#dispatchNext(peer);
  }

  /**
   * Release the in-flight batch identified by the host's immutable turn
   * token. Conversation IDs deliberately do not identify ownership: a later
   * same-CID batch is valid protocol traffic and must not be settled by a
   * stale callback from the earlier turn.
   */
  settle(turnToken: string): DispatchedCodexInterAgentBatch | undefined {
    const batch = this.#batchByTurnToken.get(turnToken);
    if (batch === undefined) return undefined;
    this.#batchByTurnToken.delete(turnToken);
    this.#releaseBatch(batch, "retired");
    this.#inputStarted.delete(turnToken);
    if (this.#activeTokenByPeer.get(batch.peer) === turnToken) {
      this.#activeTokenByPeer.delete(batch.peer);
    }
    return batch;
  }

  /** Delivery sequences owned by the exact SDK turn.  Queueing is not an
   * acknowledgement: callers invoke this only from the host's turn-start
   * hook, after the SDK turn has actually begun (#237). */
  deliverySequencesForTurn(turnToken: string): readonly number[] {
    const batch = this.#batchByTurnToken.get(turnToken);
    if (batch === undefined) return [];
    return batch.items
      .map((item) => (item.envelope as { delivery_seq?: unknown }).delivery_seq)
      .filter(
        (seq): seq is number =>
          typeof seq === "number" && Number.isSafeInteger(seq) && seq > 0,
      );
  }

  deliveryEnvelopesForTurn(turnToken: string): readonly Envelope[] {
    return this.#batchByTurnToken.get(turnToken)?.items.map(item => item.envelope) ?? [];
  }

  /** Returns the min/max delivery sequence represented by one active batch. */
  deliverySequenceRangeForTurn(
    turnToken: string,
  ): { first: number; last: number } | undefined {
    const sequences = this.deliverySequencesForTurn(turnToken);
    if (sequences.length === 0) return undefined;
    return {
      first: Math.min(...sequences),
      last: Math.max(...sequences),
    };
  }

  /** Finds the active turn which owns an inbound delivery sequence. */
  turnTokenForDeliverySequence(deliverySeq: number): string | undefined {
    for (const [turnToken, batch] of this.#batchByTurnToken) {
      if (
        batch.items.some(
          (item) =>
            (item.envelope as { delivery_seq?: unknown }).delivery_seq ===
            deliverySeq,
        )
      ) {
        return turnToken;
      }
    }
    return undefined;
  }

  /** Dispatch the oldest batch that was waiting behind a settled peer turn. */
  dispatchNextForPeer(peer: string): void {
    this.#dispatchNext(peer);
  }

  hasQueuedForPeer(peer: string): boolean {
    return this.#activeTokenByPeer.has(peer) || (this.#pendingBatches.get(peer)?.length ?? 0) > 0 ||
      (this.#pendingFallbacks.get(peer)?.length ?? 0) > 0;
  }

  hasRootConversation(conversationId: string): boolean {
    const has = (items: readonly CodexInterAgentBatchItem[]) => items.some(item =>
      (item.envelope.payload as Partial<InterAgentMessagePayload>).conversation_id === conversationId);
    return [...this.#batchByTurnToken.values()].some(batch => has(batch.items)) ||
      [...this.#pendingBatches.values()].some(batches => batches.some(batch => has(batch.items))) ||
      [...this.#pendingFallbacks.values()].some(reservations => reservations.some(reservation =>
        reservation.envelope.payload.conversation_id === conversationId));
  }

  /** Rechecks a host-queued batch synchronously at the SDK input boundary. */
  prepareInput(turnToken: string): { batch: DispatchedCodexInterAgentBatch | null; removedConversationIds: readonly string[] } | undefined {
    const batch = this.#batchByTurnToken.get(turnToken);
    if (batch === undefined) return undefined;
    this.#inputStarted.add(turnToken);
    const items: CodexInterAgentBatchItem[] = [];
    const removed: CodexInterAgentBatchItem[] = [];
    for (const item of batch.items) {
      const mode = this.#reclassifyQueued?.(item) ?? item.mode;
      if (mode === "terminal") removed.push(item);
      else items.push(mode === item.mode ? item : { ...item, mode });
    }
    const conversationIds = items.map((item) => (item.envelope.payload as Partial<InterAgentMessagePayload>).conversation_id)
      .filter((cid): cid is string => typeof cid === "string");
    const survivingIds = new Set(conversationIds);
    const removedConversationIds = batch.conversationIds.filter(cid => !survivingIds.has(cid));
    for (const item of removed) {
      if (item.reservation !== undefined) this.#admission.release(item.reservation, "completed");
      this.#onTerminalQueued?.(item);
    }
    if (items.length === 0) return { batch: null, removedConversationIds };
    const prepared = { ...batch, items, conversationIds, text: formatInboundMessages(items) };
    this.#batchByTurnToken.set(turnToken, prepared);
    return { batch: prepared, removedConversationIds };
  }

  #dispatchNext(peer: string): void {
    if (this.#closed) return;
    if (this.#activeTokenByPeer.has(peer)) return;
    if (this.#canDispatchPeer?.(peer) === false) return;
    if ([...this.#steerReservations.values()].some(reservation =>
      reservation.peer === peer && reservation.status === "steering")) return;
    while (true) {
      const fallback = this.#pendingFallbacks.get(peer)?.[0];
      if (fallback === undefined) break;
      this.#removePendingFallback(fallback);
      const item = { envelope: fallback.envelope, mode: fallback.mode, reservation: fallback.reservation };
      const mode = this.#reclassifyQueued?.(item) ?? item.mode;
      if (mode === "terminal") {
        this.#onTerminalQueued?.(item);
        this.#releaseSteerReservation(fallback.id);
        this.#admission.release(fallback.reservation, "completed");
        continue;
      }
      const selected = mode === item.mode ? item : { ...item, mode };
      const conversationId = (selected.envelope.payload as Partial<InterAgentMessagePayload>).conversation_id;
      const batch: DispatchedCodexInterAgentBatch = {
        turnToken: this.#createTurnToken(), peer, items: [selected],
        conversationIds: typeof conversationId === "string" ? [conversationId] : [],
        text: formatInboundMessage(selected.envelope, { mode: selected.mode }),
        fallbackId: fallback.id,
      };
      this.#batchByTurnToken.set(batch.turnToken, batch);
      this.#activeTokenByPeer.set(peer, batch.turnToken);
      let replaced = false;
      try { replaced = this.#onDispatch(batch) === true; } catch { replaced = false; }
      if (replaced) {
        fallback.slot = false;
        this.#releaseSteerReservation(fallback.id);
        return;
      }
      this.#batchByTurnToken.delete(batch.turnToken);
      this.#activeTokenByPeer.delete(peer);
      try { this.#onFallbackDispatchFailure?.(batch); } catch { /* Diagnostic output cannot strand the slot. */ }
      this.discardSteerReservation(fallback.id);
      this.retireEnvelopes([fallback.envelope]);
    }
    let items: CodexInterAgentBatchItem[];
    while (true) {
      const queue = this.#pendingBatches.get(peer);
      const pending = queue?.shift();
      if (pending === undefined) return;
      if (queue!.length === 0) this.#pendingBatches.delete(peer);
      items = [];
      for (const item of pending.items) {
        const mode = this.#reclassifyQueued?.(item) ?? item.mode;
        if (mode === "terminal") {
          if (item.reservation !== undefined) this.#admission.release(item.reservation, "completed");
          this.#onTerminalQueued?.(item);
        } else {
          items.push(mode === item.mode ? item : { ...item, mode });
        }
      }
      if (items.length > 0) break;
    }

    const conversationIds = items
      .map(
        (item) =>
          (item.envelope.payload as Partial<InterAgentMessagePayload>)
            .conversation_id,
      )
      .filter((cid): cid is string => typeof cid === "string");
    const batch: DispatchedCodexInterAgentBatch = {
      turnToken: this.#createTurnToken(),
      peer,
      items,
      conversationIds,
      text: formatInboundMessages(items),
    };
    this.#batchByTurnToken.set(batch.turnToken, batch);
    this.#activeTokenByPeer.set(peer, batch.turnToken);
    this.#onDispatch(batch);
  }
}
