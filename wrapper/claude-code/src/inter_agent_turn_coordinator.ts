// Per-peer inter-agent batching and turn ownership for the Claude wrapper.
//
// A conversation_id is protocol payload, not a generation identifier: the
// same conversation can legitimately produce a later batch before a stale
// callback from an earlier batch arrives. This coordinator therefore owns
// batches by an opaque turn token and keeps peer busy state token-scoped.

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

export interface InterAgentBatchItem {
  envelope: Envelope;
  mode: InboundReplyMode;
}

/** A batch that has been assigned to exactly one SDK turn. */
export interface DispatchedInterAgentBatch {
  turnToken: string;
  peer: string;
  items: readonly InterAgentBatchItem[];
  conversationIds: readonly string[];
  text: string;
}

/** A batch that never received (or never completed) an SDK turn before the
 * host terminated. Its token is a local terminal-resolution lease, not an
 * SDK turn: it only lets the shared pending map resolve this exact batch
 * without confusing it with a later same-CID generation. */
export interface DrainedInterAgentBatch {
  turnToken: string;
  peer: string;
  items: readonly InterAgentBatchItem[];
  conversationIds: readonly string[];
}

interface PendingBatch {
  items: InterAgentBatchItem[];
  bytes: number;
}

export type InterAgentTurnSettlement =
  | { kind: "settled"; batch: DispatchedInterAgentBatch }
  | { kind: "stale"; turnToken: string }
  | { kind: "untracked"; turnToken: string };

export interface InterAgentTurnCoordinatorOptions {
  /** Called synchronously once a free peer's oldest batch owns a turn. */
  onDispatch: (batch: DispatchedInterAgentBatch) => void;
  /** Injectable only for deterministic tests. Production uses UUIDs. */
  createTurnToken?: () => string;
}

/** A handler lease begins before `receiveInbound()`'s first await. It is not
 * turn ownership — no SDK turn may ever be created — but it closes the gap
 * between transport receipt and coordinator ownership when the host ends
 * during InterAgentTool's pending-done gate (issue #246). */
export interface InterAgentIngressLease {
  id: number;
  generation: number;
}

/** Owns the terminal generation of fire-and-forget inbound handlers. A late
 * handler observes a closed generation after its await and exits before it
 * can call InterAgentTurnCoordinator#receive. */
export class InterAgentIngressGate {
  #closed = false;
  #generation = 0;
  #nextId = 0;
  readonly #pending = new Set<number>();

  begin(): InterAgentIngressLease {
    const lease = { id: ++this.#nextId, generation: this.#generation };
    this.#pending.add(lease.id);
    return lease;
  }

  isTerminal(lease: InterAgentIngressLease): boolean {
    return this.#closed || lease.generation !== this.#generation;
  }

  finish(lease: InterAgentIngressLease): void {
    this.#pending.delete(lease.id);
  }

  /** Makes all existing and future leases terminal. Pending handlers stay
   * registered only until their own finally runs, so the count is diagnostic
   * rather than a second ownership ledger. */
  close(): number {
    if (!this.#closed) {
      this.#closed = true;
      this.#generation += 1;
    }
    return this.#pending.size;
  }
}

/**
 * Owns same-peer coalescing and the exact turn which is currently answering
 * each peer. This is deliberately a small standalone unit: CLI glue supplies
 * transport I/O, while tests exercise this production ownership state
 * directly instead of reimplementing it in a harness (issue #246).
 */
export class InterAgentTurnCoordinator {
  readonly #pendingBatches = new Map<string, PendingBatch[]>();
  readonly #batchByTurnToken = new Map<string, DispatchedInterAgentBatch>();
  readonly #activeTokenByPeer = new Map<string, string>();
  /** Tokens that once belonged to us. Retain a bounded history solely so a
   * late callback is diagnosable rather than indistinguishable from an
   * ordinary operator turn. */
  readonly #retiredTurnTokens = new Set<string>();
  readonly #onDispatch: (batch: DispatchedInterAgentBatch) => void;
  readonly #createTurnToken: () => string;
  #closed = false;

  constructor(options: InterAgentTurnCoordinatorOptions) {
    this.#onDispatch = options.onDispatch;
    this.#createTurnToken = options.createTurnToken ?? randomUUID;
  }

  /** Adds one accepted inbound envelope and starts it immediately when that
   * peer has no active generation. Later arrivals for a busy peer accumulate
   * behind its active turn, preserving the issue #221 busy-trigger behaviour.
   */
  receive(envelope: Envelope, mode: InboundReplyMode): void {
    if (this.#closed) {
      throw new Error("inter-agent turn coordinator is closed");
    }
    const peer = envelope.agent_id;
    const item: InterAgentBatchItem = { envelope, mode };
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
   * Settles exactly one dispatched generation. A late callback for a retired
   * token can never release a peer's newer generation.
   */
  settle(turnToken: string): InterAgentTurnSettlement {
    const batch = this.#batchByTurnToken.get(turnToken);
    if (batch === undefined) {
      return this.#retiredTurnTokens.has(turnToken)
        ? { kind: "stale", turnToken }
        : { kind: "untracked", turnToken };
    }

    this.#batchByTurnToken.delete(turnToken);
    this.#retire(turnToken);
    // A mismatched active token is an invariant violation. Do not free the
    // peer: its current generation might still be live. The old token is now
    // retired, so any repeated callback becomes an explicit stale no-op.
    if (this.#activeTokenByPeer.get(batch.peer) !== turnToken) {
      return { kind: "stale", turnToken };
    }

    this.#activeTokenByPeer.delete(batch.peer);
    return { kind: "settled", batch };
  }

  /** Starts the peer's next pending batch after the caller has resolved the
   * settled generation's CIDs. That order is essential for a same-CID next
   * batch: InterAgentTool keeps one pending record per CID, so dispatching
   * its successor before resolving the predecessor would overwrite it. */
  dispatchNextForPeer(peer: string): void {
    this.#dispatchNext(peer);
  }

  /** Stops future dispatch after a watchdog fail-stop while retaining the
   * exact SDK-active generation. Its outcome remains unknown until a real
   * ResultMessage/EOF, so resolving it (or a same-CID successor) here would
   * violate generation ordering. Unstarted batches are discarded from local
   * ownership and reported through the caller's controlled-recovery warning;
   * server disconnect remains the peer-visible fallback on operator restore.
   */
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
      this.#retire(turnToken);
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

  /**
   * Stops dispatch permanently and returns every batch that remains owned by
   * the coordinator. Callers first settle host-owned turns, then register and
   * resolve these batches synchronously, enqueueing their notices before
   * closing transport. This cannot guarantee transport acceptance; a closed
   * link falls back to the server's disconnected notice. For a peer, a
   * previously dispatched generation is returned before its FIFO pending
   * batches, preserving same-CID generation order (issue #246).
   */
  closeAndDrain(): readonly DrainedInterAgentBatch[] {
    if (this.#closed) return [];
    this.#closed = true;

    const drained: DrainedInterAgentBatch[] = [];
    const emittedTokens = new Set<string>();
    const peers = new Set([
      ...this.#activeTokenByPeer.keys(),
      ...this.#pendingBatches.keys(),
    ]);

    for (const peer of peers) {
      const activeToken = this.#activeTokenByPeer.get(peer);
      if (activeToken !== undefined) {
        const batch = this.#batchByTurnToken.get(activeToken);
        if (batch !== undefined) {
          drained.push(batch);
          emittedTokens.add(activeToken);
          this.#retire(activeToken);
        }
      }
      for (const pending of this.#pendingBatches.get(peer) ?? []) {
        drained.push(this.#drainedBatch(peer, pending));
      }
    }

    // No normal path creates an orphan, but return it rather than silently
    // forgetting a previously accepted token if an ownership invariant was
    // already broken before terminal teardown.
    for (const [turnToken, batch] of this.#batchByTurnToken) {
      if (emittedTokens.has(turnToken)) continue;
      drained.push(batch);
      this.#retire(turnToken);
    }

    this.#activeTokenByPeer.clear();
    this.#batchByTurnToken.clear();
    this.#pendingBatches.clear();
    return drained;
  }

  #dispatchNext(peer: string): void {
    if (this.#closed) return;
    if (this.#activeTokenByPeer.has(peer)) return;
    const queue = this.#pendingBatches.get(peer);
    const pending = queue?.shift();
    if (pending === undefined) return;
    if (queue!.length === 0) this.#pendingBatches.delete(peer);

    const turnToken = this.#createTurnToken();
    const conversationIds = pending.items
      .map(
        (item) =>
          (item.envelope.payload as Partial<InterAgentMessagePayload>)
            .conversation_id,
      )
      .filter((cid): cid is string => typeof cid === "string");
    const batch: DispatchedInterAgentBatch = {
      turnToken,
      peer,
      items: pending.items,
      conversationIds,
      text: formatInboundMessages(pending.items),
    };
    this.#batchByTurnToken.set(turnToken, batch);
    this.#activeTokenByPeer.set(peer, turnToken);
    this.#onDispatch(batch);
  }

  #drainedBatch(peer: string, pending: PendingBatch): DrainedInterAgentBatch {
    const conversationIds = pending.items
      .map(
        (item) =>
          (item.envelope.payload as Partial<InterAgentMessagePayload>)
            .conversation_id,
      )
      .filter((cid): cid is string => typeof cid === "string");
    return {
      turnToken: this.#createTurnToken(),
      peer,
      items: pending.items,
      conversationIds,
    };
  }

  #retire(turnToken: string): void {
    this.#retiredTurnTokens.add(turnToken);
    // A diagnostic history must not become unbounded in a long-lived wrapper.
    if (this.#retiredTurnTokens.size > 1024) {
      const oldest = this.#retiredTurnTokens.values().next().value;
      if (typeof oldest === "string") this.#retiredTurnTokens.delete(oldest);
    }
  }
}
