// Per-peer batching and dispatch ownership for Codex inbound inter-agent
// turns. The CLI provides the host/transport edge, while this production
// object owns every queue transition so lifecycle tests cannot reimplement
// it separately (issue #226).

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
}

/**
 * Owns same-peer batching and busy-turn dispatch. A peer may have exactly one
 * host turn in flight; arrivals while that turn runs append to its FIFO queue.
 * Host completion must call settle() before dispatchNextForPeer(), so a later
 * batch reusing a conversation ID cannot overwrite the prior pending record.
 */
export class CodexInterAgentTurnCoordinator {
  readonly #pendingBatches = new Map<string, PendingBatch[]>();
  readonly #inFlightBatchByPeer = new Map<string, DispatchedCodexInterAgentBatch>();
  readonly #inFlightCidPeer = new Map<string, string>();
  readonly #onDispatch: (batch: DispatchedCodexInterAgentBatch) => void;

  constructor(options: CodexInterAgentTurnCoordinatorOptions) {
    this.#onDispatch = options.onDispatch;
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
   * Release the in-flight batch identified by the host's conversation IDs.
   * Unrelated host turns return undefined and leave this coordinator untouched.
   */
  settle(
    conversationIds: readonly string[],
  ): DispatchedCodexInterAgentBatch | undefined {
    const peer =
      conversationIds.length > 0
        ? this.#inFlightCidPeer.get(conversationIds[0]!)
        : undefined;
    if (peer === undefined) return undefined;
    const batch = this.#inFlightBatchByPeer.get(peer);
    if (batch === undefined) return undefined;

    for (const cid of batch.conversationIds) this.#inFlightCidPeer.delete(cid);
    this.#inFlightBatchByPeer.delete(peer);
    return batch;
  }

  /** Dispatch the oldest batch that was waiting behind a settled peer turn. */
  dispatchNextForPeer(peer: string): void {
    this.#dispatchNext(peer);
  }

  #dispatchNext(peer: string): void {
    if (this.#inFlightBatchByPeer.has(peer)) return;
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
      peer,
      items: pending.items,
      conversationIds,
      text: formatInboundMessages(pending.items),
    };
    this.#inFlightBatchByPeer.set(peer, batch);
    for (const cid of conversationIds) this.#inFlightCidPeer.set(cid, peer);
    this.#onDispatch(batch);
  }
}
