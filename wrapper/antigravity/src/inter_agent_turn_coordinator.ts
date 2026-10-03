import { randomUUID } from "node:crypto";

import {
  DEFAULT_INTER_AGENT_BACKLOG_MAX_ITEMS,
  DEFAULT_INTER_AGENT_BATCH_MAX_ITEMS,
  InterAgentAdmission,
  InterAgentInputLifecycle,
  canAddToCoalescedBatch,
  formatInboundMessage,
  formatInboundMessages,
} from "@kaoiro/agent-common";
import type {
  Envelope,
  InterAgentAdmissionReservation,
  InboundReplyMode,
  InterAgentMessagePayload,
  InterAgentInputLifecyclePort,
  BatchDisposition,
} from "@kaoiro/agent-common";

export interface AntigravityInterAgentBatchItem {
  envelope: Envelope;
  mode: InboundReplyMode;
  reservation?: InterAgentAdmissionReservation;
}

export interface DispatchedAntigravityInterAgentBatch {
  turnToken: string;
  peer: string;
  items: readonly AntigravityInterAgentBatchItem[];
  conversationIds: readonly string[];
  text: string;
}

interface PendingBatch {
  items: AntigravityInterAgentBatchItem[];
  bytes: number;
}

export interface AntigravityInterAgentTurnCoordinatorOptions {
  onDispatch: (batch: DispatchedAntigravityInterAgentBatch) => void;
  reclassifyQueued?: (item: AntigravityInterAgentBatchItem) => InboundReplyMode;
  onTerminalQueued?: (item: AntigravityInterAgentBatchItem) => void;
  createTurnToken?: () => string;
  admission?: InterAgentAdmission;
  inputLifecycle?: InterAgentInputLifecyclePort;
  maxBatchItems?: number;
}

/** Owns the Antigravity-side queue for one peer's inbound turns. */
export class AntigravityInterAgentTurnCoordinator {
  readonly #receiveOrder = new WeakMap<Envelope, number>();
  #nextReceiveOrder = 0;
  readonly #inputStarted = new Set<string>();
  readonly #recoveryLeases = new Set<readonly Envelope[]>();
  readonly #pendingBatches = new Map<string, PendingBatch[]>();
  readonly #batchByTurnToken = new Map<
    string,
    DispatchedAntigravityInterAgentBatch
  >();
  readonly #activeTokenByPeer = new Map<string, string>();
  readonly #onDispatch: (batch: DispatchedAntigravityInterAgentBatch) => void;
  readonly #reclassifyQueued: ((item: AntigravityInterAgentBatchItem) => InboundReplyMode) | undefined;
  readonly #onTerminalQueued: ((item: AntigravityInterAgentBatchItem) => void) | undefined;
  readonly #createTurnToken: () => string;
  #closed = false;
  readonly #inputLifecycle: InterAgentInputLifecyclePort;
  readonly #maxBatchItems: number;

  constructor(options: AntigravityInterAgentTurnCoordinatorOptions) {
    this.#onDispatch = options.onDispatch;
    this.#reclassifyQueued = options.reclassifyQueued;
    this.#onTerminalQueued = options.onTerminalQueued;
    this.#createTurnToken = options.createTurnToken ?? randomUUID;
    this.#inputLifecycle = options.inputLifecycle ?? new InterAgentInputLifecycle({
      maxPendingItems: DEFAULT_INTER_AGENT_BACKLOG_MAX_ITEMS,
      ...(options.admission === undefined ? {} : { admission: options.admission }),
    });
    this.#maxBatchItems = options.maxBatchItems ?? DEFAULT_INTER_AGENT_BATCH_MAX_ITEMS;
  }

  freezeForWatchdogFailStop(activeTurnToken?: string): {
    droppedDispatched: number;
    droppedPending: number;
  } {
    if (this.#closed) return { droppedDispatched: 0, droppedPending: 0 };
    this.#closed = true;
    let droppedDispatched = 0;
    let droppedPending = 0;
    for (const [turnToken, batch] of this.#batchByTurnToken) {
      if (activeTurnToken !== undefined && turnToken === activeTurnToken) continue;
      this.#batchByTurnToken.delete(turnToken);
      this.#releaseBatch(batch, "retired");
      if (this.#activeTokenByPeer.get(batch.peer) === turnToken) {
        this.#activeTokenByPeer.delete(batch.peer);
      }
      droppedDispatched += 1;
    }
    for (const batches of this.#pendingBatches.values()) {
      for (const item of batches.flatMap(batch => batch.items)) if (item.reservation !== undefined) this.#inputLifecycle.finish(item.reservation, { kind: "abandoned", reason: "watchdog_pending_unstarted" });
      droppedPending += batches.length;
    }
    this.#pendingBatches.clear();
    return { droppedDispatched, droppedPending };
  }

  unreadCount(activeToken: string | null): number {
    return [...this.#batchByTurnToken.values()].filter(batch => batch.turnToken !== activeToken).reduce((n, batch) => n + batch.items.length, 0)
      + [...this.#pendingBatches.values()].flat().reduce((n, batch) => n + batch.items.length, 0)
      + [...this.#recoveryLeases].reduce((n, items) => n + items.length, 0);
  }

  claimRecovery(cid: string, peer: string, activeToken: string | null, fit: (envelopes: readonly Envelope[]) => boolean): { envelopes: readonly Envelope[]; oversizedPending?: boolean; commit: () => void; rollback: () => void } | undefined {
    const selected: AntigravityInterAgentBatchItem[] = [];
    const candidates = [
      ...[...this.#batchByTurnToken.values()].filter(batch => batch.peer === peer && batch.turnToken !== activeToken && !this.#inputStarted.has(batch.turnToken)).flatMap(batch => batch.items),
      ...(this.#pendingBatches.get(peer) ?? []).flatMap(batch => batch.items),
    ];
    for (const item of candidates) {
      if (item.envelope.payload.conversation_id !== cid || item.envelope.agent_id !== peer || item.envelope.payload.notice_type !== undefined) continue;
      if (!fit([...selected, item].map(i => i.envelope))) {
        if (!selected.length) return { envelopes: [], oversizedPending: true, commit: () => {}, rollback: () => {} };
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
      commit: () => { settled = true; this.#recoveryLeases.delete(envelopes); },
      rollback: () => {
        if (settled) return; settled = true; this.#recoveryLeases.delete(envelopes);
        if (this.#closed) {
          this.#inputLifecycle.completeBatch(
            selected.flatMap(item => item.reservation === undefined ? [] : [item.reservation]),
            { kind: "abandoned", reason: "recovery_return_after_close" },
          );
          return;
        }
        const remaining = new Set(selected);
        const restore = (before: readonly AntigravityInterAgentBatchItem[], current: readonly AntigravityInterAgentBatchItem[]): AntigravityInterAgentBatchItem[] => {
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

  receive(envelope: Envelope, mode: InboundReplyMode, reservation?: InterAgentAdmissionReservation): boolean {
    if (this.#closed) {
      const held = reservation ?? this.#inputLifecycle.reservationFor(envelope);
      if (held !== undefined && this.#inputLifecycle.owns(held, envelope)) this.#inputLifecycle.finish(held, { kind: "abandoned", reason: "coordinator_closed_before_receive" });
      return false;
    }
    const held = reservation ?? this.#inputLifecycle.reservationFor(envelope) ?? this.#reserveDirect(envelope);
    if (!this.#inputLifecycle.owns(held, envelope)) throw new Error("inter-agent input reservation is missing, foreign, or released");
    if (!this.#receiveOrder.has(envelope)) this.#receiveOrder.set(envelope, this.#nextReceiveOrder++);
    const peer = envelope.agent_id;
    const item: AntigravityInterAgentBatchItem = { envelope, mode, reservation: held };
    const itemBytes = Buffer.byteLength(formatInboundMessage(envelope, { mode }), "utf8");
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
    return true;
  }

  settle(turnToken: string, disposition: BatchDisposition): DispatchedAntigravityInterAgentBatch | undefined {
    const batch = this.#batchByTurnToken.get(turnToken);
    if (batch === undefined) return undefined;
    this.#inputLifecycle.completeBatch(
      batch.items.flatMap(item => item.reservation === undefined ? [] : [item.reservation]),
      disposition,
    );
    this.#batchByTurnToken.delete(turnToken);
    this.#releaseBatch(batch, "retired");
    this.#inputStarted.delete(turnToken);
    if (this.#activeTokenByPeer.get(batch.peer) === turnToken) {
      this.#activeTokenByPeer.delete(batch.peer);
    }
    return batch;
  }

  handoff(turnToken: string, ownerToken = turnToken): void {
    const batch = this.#batchByTurnToken.get(turnToken);
    if (batch !== undefined) for (const item of batch.items) if (item.reservation !== undefined) {
      this.#inputLifecycle.finish(item.reservation, {
        kind: "observed", boundary: "antigravity_input_written", ownerToken,
      });
    }
  }

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

  inFlightHandles(turnToken?: string): readonly InterAgentAdmissionReservation[] {
    if (turnToken === undefined) return [];
    return this.#batchByTurnToken.get(turnToken)?.items.flatMap(item =>
      item.reservation === undefined ? [] : [item.reservation],
    ) ?? [];
  }

  deliverySequenceRangeForTurn(
    turnToken: string,
  ): { first: number; last: number } | undefined {
    const sequences = this.deliverySequencesForTurn(turnToken);
    if (sequences.length === 0) return undefined;
    return { first: Math.min(...sequences), last: Math.max(...sequences) };
  }

  turnTokenForDeliverySequence(deliverySeq: number): string | undefined {
    for (const [turnToken, batch] of this.#batchByTurnToken) {
      if (
        batch.items.some(
          (item) =>
            (item.envelope as { delivery_seq?: unknown }).delivery_seq === deliverySeq,
        )
      ) {
        return turnToken;
      }
    }
    return undefined;
  }

  dispatchNextForPeer(peer: string): void {
    this.#dispatchNext(peer);
  }

  /** Rechecks a host-queued batch synchronously at the SDK input boundary. */
  prepareInput(turnToken: string): { batch: DispatchedAntigravityInterAgentBatch | null; removedConversationIds: readonly string[] } | undefined {
    const batch = this.#batchByTurnToken.get(turnToken);
    if (batch === undefined) return undefined;
    this.#inputStarted.add(turnToken);
    const items: AntigravityInterAgentBatchItem[] = [];
    const removed: AntigravityInterAgentBatchItem[] = [];
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
      if (item.reservation !== undefined) this.#inputLifecycle.finish(item.reservation, { kind: "inline", reason: "terminal_skip" });
      this.#onTerminalQueued?.(item);
    }
    if (items.length === 0) return { batch: null, removedConversationIds };
    const prepared = { ...batch, items, conversationIds, text: formatInboundMessages(items) };
    this.#batchByTurnToken.set(turnToken, prepared);
    return { batch: prepared, removedConversationIds };
  }

  #dispatchNext(peer: string): void {
    if (this.#closed || this.#activeTokenByPeer.has(peer)) return;
    let items: AntigravityInterAgentBatchItem[];
    while (true) {
      const queue = this.#pendingBatches.get(peer);
      const pending = queue?.shift();
      if (pending === undefined) return;
      if (queue!.length === 0) this.#pendingBatches.delete(peer);
      items = [];
      for (const item of pending.items) {
        const mode = this.#reclassifyQueued?.(item) ?? item.mode;
        if (mode === "terminal") {
          if (item.reservation !== undefined) this.#inputLifecycle.finish(item.reservation, { kind: "inline", reason: "terminal_skip" });
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
          (item.envelope.payload as Partial<InterAgentMessagePayload>).conversation_id,
      )
      .filter((cid): cid is string => typeof cid === "string");
    const batch: DispatchedAntigravityInterAgentBatch = {
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

  #reserveDirect(envelope: Envelope): InterAgentAdmissionReservation {
    const result = this.#inputLifecycle.reserveDirect(envelope);
    if (result === undefined) throw new Error("inter-agent input capacity exceeded");
    return result;
  }

  #releaseItems(items: readonly AntigravityInterAgentBatchItem[], _reason: "handed_off" | "completed" | "retired"): void {
    this.#inputLifecycle.completeBatch(
      items.flatMap(item => item.reservation === undefined ? [] : [item.reservation]),
      { kind: "abandoned", reason: "coordinator_batch_removed" },
    );
  }

  #releaseBatch(batch: { items: readonly AntigravityInterAgentBatchItem[] }, reason: "handed_off" | "completed" | "retired"): void {
    this.#releaseItems(batch.items, reason);
  }
}
