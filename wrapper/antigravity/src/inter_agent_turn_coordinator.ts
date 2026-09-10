import { randomUUID } from "node:crypto";

import {
  canAddToCoalescedBatch,
  formatInboundMessage,
  formatInboundMessages,
} from "@kaoiro/agent-common";
import type {
  Envelope,
  InboundReplyMode,
  InterAgentMessagePayload,
} from "@kaoiro/agent-common";

export interface AntigravityInterAgentBatchItem {
  envelope: Envelope;
  mode: InboundReplyMode;
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
  createTurnToken?: () => string;
}

/** Owns the Antigravity-side queue for one peer's inbound turns. */
export class AntigravityInterAgentTurnCoordinator {
  readonly #pendingBatches = new Map<string, PendingBatch[]>();
  readonly #batchByTurnToken = new Map<
    string,
    DispatchedAntigravityInterAgentBatch
  >();
  readonly #activeTokenByPeer = new Map<string, string>();
  readonly #onDispatch: (batch: DispatchedAntigravityInterAgentBatch) => void;
  readonly #createTurnToken: () => string;
  #closed = false;

  constructor(options: AntigravityInterAgentTurnCoordinatorOptions) {
    this.#onDispatch = options.onDispatch;
    this.#createTurnToken = options.createTurnToken ?? randomUUID;
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
      if (this.#activeTokenByPeer.get(batch.peer) === turnToken) {
        this.#activeTokenByPeer.delete(batch.peer);
      }
      droppedDispatched += 1;
    }
    for (const batches of this.#pendingBatches.values()) {
      droppedPending += batches.length;
    }
    this.#pendingBatches.clear();
    return { droppedDispatched, droppedPending };
  }

  receive(envelope: Envelope, mode: InboundReplyMode): void {
    if (this.#closed) return;
    const peer = envelope.agent_id;
    const item: AntigravityInterAgentBatchItem = { envelope, mode };
    const itemBytes = Buffer.byteLength(formatInboundMessage(envelope, { mode }), "utf8");
    let queue = this.#pendingBatches.get(peer);
    if (queue === undefined) {
      queue = [];
      this.#pendingBatches.set(peer, queue);
    }
    let open = queue[queue.length - 1];
    if (
      open === undefined ||
      !canAddToCoalescedBatch(open.items.length, open.bytes, itemBytes)
    ) {
      open = { items: [], bytes: 0 };
      queue.push(open);
    }
    open.items.push(item);
    open.bytes += itemBytes;
    this.#dispatchNext(peer);
  }

  settle(turnToken: string): DispatchedAntigravityInterAgentBatch | undefined {
    const batch = this.#batchByTurnToken.get(turnToken);
    if (batch === undefined) return undefined;
    this.#batchByTurnToken.delete(turnToken);
    if (this.#activeTokenByPeer.get(batch.peer) === turnToken) {
      this.#activeTokenByPeer.delete(batch.peer);
    }
    return batch;
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

  #dispatchNext(peer: string): void {
    if (this.#closed || this.#activeTokenByPeer.has(peer)) return;
    const queue = this.#pendingBatches.get(peer);
    const pending = queue?.shift();
    if (pending === undefined) return;
    if (queue!.length === 0) this.#pendingBatches.delete(peer);
    const conversationIds = pending.items
      .map(
        (item) =>
          (item.envelope.payload as Partial<InterAgentMessagePayload>).conversation_id,
      )
      .filter((cid): cid is string => typeof cid === "string");
    const batch: DispatchedAntigravityInterAgentBatch = {
      turnToken: this.#createTurnToken(),
      peer,
      items: pending.items,
      conversationIds,
      text: formatInboundMessages(pending.items),
    };
    this.#batchByTurnToken.set(batch.turnToken, batch);
    this.#activeTokenByPeer.set(peer, batch.turnToken);
    this.#onDispatch(batch);
  }
}
