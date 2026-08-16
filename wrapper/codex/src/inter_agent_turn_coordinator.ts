// Per-peer batching and dispatch ownership for Codex inbound inter-agent
// turns. The CLI provides the host/transport edge, while this production
// object owns every queue transition so lifecycle tests cannot reimplement
// it separately (issue #226).

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

export interface CodexInterAgentBatchItem {
  envelope: Envelope;
  mode: InboundReplyMode;
}

/** One batch accepted by the coordinator and assigned to a Codex turn. */
export interface DispatchedCodexInterAgentBatch {
  /** Immutable ownership capability for this exact queued SDK turn. */
  turnToken: string;
  peer: string;
  items: readonly CodexInterAgentBatchItem[];
  conversationIds: readonly string[];
  text: string;
}

interface PendingBatch {
  items: CodexInterAgentBatchItem[];
  bytes: number;
}

export interface CodexInterAgentTurnCoordinatorOptions {
  /** Runs synchronously once a free peer receives its oldest queued batch. */
  onDispatch: (batch: DispatchedCodexInterAgentBatch) => void;
  /** Injectable only for deterministic tests. Production uses UUIDs. */
  createTurnToken?: () => string;
}

/**
 * Owns same-peer batching and busy-turn dispatch. A peer may have exactly one
 * host turn in flight; arrivals while that turn runs append to its FIFO queue.
 * Host completion must call settle() before dispatchNextForPeer(), so a later
 * batch reusing a conversation ID cannot overwrite the prior pending record.
 */
export class CodexInterAgentTurnCoordinator {
  readonly #pendingBatches = new Map<string, PendingBatch[]>();
  readonly #batchByTurnToken = new Map<string, DispatchedCodexInterAgentBatch>();
  readonly #activeTokenByPeer = new Map<string, string>();
  readonly #onDispatch: (batch: DispatchedCodexInterAgentBatch) => void;
  readonly #createTurnToken: () => string;

  constructor(options: CodexInterAgentTurnCoordinatorOptions) {
    this.#onDispatch = options.onDispatch;
    this.#createTurnToken = options.createTurnToken ?? randomUUID;
  }

  /** Queue an accepted inbound and dispatch immediately if its peer is free. */
  receive(envelope: Envelope, mode: InboundReplyMode): void {
    const peer = envelope.agent_id;
    const item: CodexInterAgentBatchItem = { envelope, mode };
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
      !canAddToCoalescedBatch(open.items.length, open.bytes, itemBytes)
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
    if (this.#activeTokenByPeer.get(batch.peer) === turnToken) {
      this.#activeTokenByPeer.delete(batch.peer);
    }
    return batch;
  }

  /** Delivery sequences owned by the exact SDK turn.  Queueing is not an
   * acknowledgement: callers invoke this only from the host's turn-start
   * hook, after the SDK turn has actually begun (#247). */
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

  /** Dispatch the oldest batch that was waiting behind a settled peer turn. */
  dispatchNextForPeer(peer: string): void {
    this.#dispatchNext(peer);
  }

  #dispatchNext(peer: string): void {
    if (this.#activeTokenByPeer.has(peer)) return;
    const queue = this.#pendingBatches.get(peer);
    const pending = queue?.shift();
    if (pending === undefined) return;
    if (queue!.length === 0) this.#pendingBatches.delete(peer);

    const conversationIds = pending.items
      .map(
        (item) =>
          (item.envelope.payload as Partial<InterAgentMessagePayload>)
            .conversation_id,
      )
      .filter((cid): cid is string => typeof cid === "string");
    const batch: DispatchedCodexInterAgentBatch = {
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
