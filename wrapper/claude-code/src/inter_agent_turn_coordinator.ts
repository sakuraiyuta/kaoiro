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
  ordinaryPeerInput,
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

interface FoldedRecoveryRecord {
  envelope: Envelope;
  ownerToken: string;
}

const MAX_FOLDED_RECOVERY_RECORDS = 256;

export type InterAgentTurnSettlement =
  | { kind: "settled"; batch: DispatchedInterAgentBatch }
  | { kind: "stale"; turnToken: string }
  | { kind: "untracked"; turnToken: string };

export interface InterAgentTurnCoordinatorOptions {
  /** Called synchronously for an ordinary free-peer batch or a priority lease. */
  onDispatch: (batch: DispatchedInterAgentBatch) => void;
  reclassifyQueued?: (item: InterAgentBatchItem) => InboundReplyMode;
  onTerminalQueued?: (item: InterAgentBatchItem) => void;
  onFoldRecoveryEvicted?: (reason: "fold_recovery_capacity") => void;
  /** Injectable only for deterministic tests. Production uses UUIDs. */
  createTurnToken?: () => string;
}

/** A handler lease begins before `receiveInbound()`'s first await. It is not
 * turn ownership — no SDK turn may ever be created — but it closes the gap
 * between transport receipt and coordinator ownership when the host ends
 * during InterAgentTool's pending-done gate (issue #236). */
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
  readonly #pending = new Map<number, Envelope | undefined>();
  #retire: ((envelopes: readonly Envelope[]) => void) | undefined;

  begin(envelope?: Envelope): InterAgentIngressLease {
    const lease = { id: ++this.#nextId, generation: this.#generation };
    this.#pending.set(lease.id, envelope);
    if (this.#closed && envelope !== undefined) this.#retire?.([envelope]);
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
  close(retire?: (envelopes: readonly Envelope[]) => void): number {
    if (!this.#closed) {
      this.#closed = true;
      this.#retire = retire;
      retire?.([...this.#pending.values()].filter((envelope): envelope is Envelope => envelope !== undefined));
      this.#generation += 1;
    }
    return this.#pending.size;
  }
}

/**
 * Owns same-peer coalescing and the exact turn which is currently answering
 * each peer. This is deliberately a small standalone unit: CLI glue supplies
 * transport I/O, while tests exercise this production ownership state
 * directly instead of reimplementing it in a harness (issue #236).
 */
export class InterAgentTurnCoordinator {
  readonly #receiveOrder = new WeakMap<Envelope, number>();
  #nextReceiveOrder = 0;
  readonly #inputStarted = new Set<string>();
  readonly #recoveryLeases = new Set<readonly Envelope[]>();
  readonly #foldedRecovery = new Map<string, FoldedRecoveryRecord>();
  readonly #pendingBatches = new Map<string, PendingBatch[]>();
  readonly #batchByTurnToken = new Map<string, DispatchedInterAgentBatch>();
  readonly #activeTokenByPeer = new Map<string, string>();
  readonly #priorityLeases = new Set<string>();
  readonly #pushedPriorityLeases = new Set<string>();
  readonly #suspendedTokenByPeer = new Map<string, string>();
  /** Tokens that once belonged to us. Retain a bounded history solely so a
   * late callback is diagnosable rather than indistinguishable from an
   * ordinary operator turn. */
  readonly #retiredTurnTokens = new Set<string>();
  readonly #onDispatch: (batch: DispatchedInterAgentBatch) => void;
  readonly #reclassifyQueued: ((item: InterAgentBatchItem) => InboundReplyMode) | undefined;
  readonly #onTerminalQueued: ((item: InterAgentBatchItem) => void) | undefined;
  readonly #onFoldRecoveryEvicted: ((reason: "fold_recovery_capacity") => void) | undefined;
  readonly #createTurnToken: () => string;
  #closed = false;

  constructor(options: InterAgentTurnCoordinatorOptions) {
    this.#onDispatch = options.onDispatch;
    this.#reclassifyQueued = options.reclassifyQueued;
    this.#onTerminalQueued = options.onTerminalQueued;
    this.#onFoldRecoveryEvicted = options.onFoldRecoveryEvicted;
    this.#createTurnToken = options.createTurnToken ?? randomUUID;
  }

  /** Ordinary input waits behind a busy peer; priority input gets its own
   * lease so it can be folded into that peer's live turn. The lease has no
   * SDK turn token until a matched root hook adopts it.
   */
  unreadCount(activeToken: string | null): number {
    return [...this.#batchByTurnToken.values()].filter(batch => batch.turnToken !== activeToken).reduce((n, batch) => n + batch.items.length, 0)
      + [...this.#pendingBatches.values()].flat().reduce((n, batch) => n + batch.items.length, 0)
      + [...this.#recoveryLeases].reduce((n, items) => n + items.length, 0);
  }

  claimRecovery(cid: string, peer: string, activeToken: string | null, fit: (envelopes: readonly Envelope[]) => boolean, expectedTurn?: number): { envelopes: readonly Envelope[]; oversizedPending?: boolean; foldedEarlier?: true; recoverySource?: "handoff_queue" | "retained_fold"; commit: () => void; rollback: () => void } | undefined {
    if (expectedTurn !== undefined) {
      const folded = this.#foldedRecovery.get(JSON.stringify([cid, peer, expectedTurn]));
      if (folded !== undefined) {
        const envelopes = [folded.envelope];
        if (!fit(envelopes)) return { envelopes: [], oversizedPending: true, foldedEarlier: true, recoverySource: "retained_fold", commit: () => {}, rollback: () => {} };
        return { envelopes, foldedEarlier: true, commit: () => {}, rollback: () => {} };
      }
    }
    const selected: InterAgentBatchItem[] = [];
    const candidates = [
      ...[...this.#batchByTurnToken.values()].filter(batch => batch.peer === peer && batch.turnToken !== activeToken && !this.#inputStarted.has(batch.turnToken)).flatMap(batch => batch.items),
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
      commit: () => { settled = true; this.#recoveryLeases.delete(envelopes); },
      rollback: () => {
        if (settled) return; settled = true; this.#recoveryLeases.delete(envelopes);
        if (this.#closed) return;
        const remaining = new Set(selected);
        const restore = (before: readonly InterAgentBatchItem[], current: readonly InterAgentBatchItem[]): InterAgentBatchItem[] => {
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

  retainFolded(envelopes: readonly Envelope[], ownerToken: string): void {
    for (const envelope of envelopes) {
      if (!ordinaryPeerInput(envelope)) continue;
      const payload = envelope.payload as unknown as InterAgentMessagePayload;
      const key = JSON.stringify([payload.conversation_id, envelope.agent_id, payload.turn_number]);
      if (this.#foldedRecovery.has(key)) continue;
      if (this.#foldedRecovery.size >= MAX_FOLDED_RECOVERY_RECORDS) {
        const oldest = this.#foldedRecovery.keys().next().value;
        if (typeof oldest === "string") this.#foldedRecovery.delete(oldest);
        this.#onFoldRecoveryEvicted?.("fold_recovery_capacity");
      }
      this.#foldedRecovery.set(key, { envelope, ownerToken });
    }
  }

  creditFolded(envelopes: readonly Envelope[]): void {
    for (const envelope of envelopes) {
      if (!ordinaryPeerInput(envelope)) continue;
      const payload = envelope.payload as unknown as InterAgentMessagePayload;
      this.#foldedRecovery.delete(JSON.stringify([payload.conversation_id, envelope.agent_id, payload.turn_number]));
    }
  }

  retireFoldedBeforeConfirmed(envelopes: readonly Envelope[]): void {
    for (const envelope of envelopes) {
      if (!ordinaryPeerInput(envelope)) continue;
      const payload = envelope.payload as unknown as InterAgentMessagePayload;
      for (const [key, record] of this.#foldedRecovery) {
        const prior = record.envelope.payload as unknown as InterAgentMessagePayload;
        if (record.envelope.agent_id === envelope.agent_id && prior.conversation_id === payload.conversation_id && prior.turn_number < payload.turn_number) {
          this.#foldedRecovery.delete(key);
        }
      }
    }
  }

  resetFoldedRecovery(): void {
    this.#foldedRecovery.clear();
  }

  receive(envelope: Envelope, mode: InboundReplyMode, priority = false): void {
    if (this.#closed) {
      throw new Error("inter-agent turn coordinator is closed");
    }
    if (!this.#receiveOrder.has(envelope)) this.#receiveOrder.set(envelope, this.#nextReceiveOrder++);
    const peer = envelope.agent_id;
    const item: InterAgentBatchItem = { envelope, mode };
    if (priority) {
      const turnToken = this.#createTurnToken();
      const cid = (envelope.payload as Partial<InterAgentMessagePayload>).conversation_id;
      const batch: DispatchedInterAgentBatch = {
        turnToken, peer, items: [item],
        conversationIds: typeof cid === "string" ? [cid] : [],
        text: formatInboundMessages([item]),
      };
      this.#batchByTurnToken.set(turnToken, batch);
      this.#priorityLeases.add(turnToken);
      this.#onDispatch(batch);
      this.#dispatchNext(peer);
      return;
    }
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
    this.#inputStarted.delete(turnToken);
    const priorityLease = this.#priorityLeases.delete(turnToken);
    this.#pushedPriorityLeases.delete(turnToken);
    this.#retire(turnToken);
    // A mismatched active token is an invariant violation. Do not free the
    // peer: its current generation might still be live. The old token is now
    // retired, so any repeated callback becomes an explicit stale no-op.
    if (this.#activeTokenByPeer.get(batch.peer) !== turnToken) {
      if (this.#suspendedTokenByPeer.get(batch.peer) === turnToken) {
        this.#suspendedTokenByPeer.delete(batch.peer);
        return { kind: "settled", batch };
      }
      return priorityLease ? { kind: "settled", batch } : { kind: "stale", turnToken };
    }

    const suspended = this.#suspendedTokenByPeer.get(batch.peer);
    this.#suspendedTokenByPeer.delete(batch.peer);
    if (suspended !== undefined && this.#batchByTurnToken.has(suspended)) {
      this.#activeTokenByPeer.set(batch.peer, suspended);
    } else {
      this.#activeTokenByPeer.delete(batch.peer);
    }
    return { kind: "settled", batch };
  }

  /** A matched pushed root is an SDK turn. Its lease becomes that peer's
   * active generation before a later ordinary batch may be dispatched. */
  adoptPushedRoot(leaseToken: string, rootToken: string): DispatchedInterAgentBatch | undefined {
    const batch = this.#batchByTurnToken.get(leaseToken);
    if (batch === undefined || this.#batchByTurnToken.has(rootToken)) return undefined;
    this.#batchByTurnToken.delete(leaseToken);
    this.#inputStarted.delete(leaseToken);
    this.#priorityLeases.delete(leaseToken);
    this.#pushedPriorityLeases.delete(leaseToken);
    this.#retire(leaseToken);
    const current = this.#activeTokenByPeer.get(batch.peer);
    if (current !== undefined && current !== leaseToken) {
      this.#suspendedTokenByPeer.set(batch.peer, current);
    }
    const root = { ...batch, turnToken: rootToken };
    this.#batchByTurnToken.set(rootToken, root);
    this.#inputStarted.add(rootToken);
    this.#activeTokenByPeer.set(batch.peer, rootToken);
    return root;
  }

  /** Starts the peer's next pending batch after the caller has resolved the
   * settled generation's CIDs. That order is essential for a same-CID next
   * batch: InterAgentTool keeps one pending record per CID, so dispatching
   * its successor before resolving the predecessor would overwrite it. */
  dispatchNextForPeer(peer: string): void {
    this.#dispatchNext(peer);
  }

  /** Rechecks a host-queued batch synchronously at the SDK input boundary. */
  prepareInput(turnToken: string, asRoot = true): { batch: DispatchedInterAgentBatch | null; removedConversationIds: readonly string[] } | undefined {
    const batch = this.#batchByTurnToken.get(turnToken);
    if (batch === undefined) return undefined;
    if (asRoot && this.#priorityLeases.delete(turnToken) && this.#activeTokenByPeer.get(batch.peer) !== turnToken) {
      const current = this.#activeTokenByPeer.get(batch.peer);
      if (current !== undefined) this.#suspendedTokenByPeer.set(batch.peer, current);
      this.#activeTokenByPeer.set(batch.peer, turnToken);
    }
    if (asRoot) this.#inputStarted.add(turnToken);
    const items: InterAgentBatchItem[] = [];
    const removed: InterAgentBatchItem[] = [];
    for (const item of batch.items) {
      const mode = this.#reclassifyQueued?.(item) ?? item.mode;
      if (mode === "terminal") removed.push(item);
      else items.push(mode === item.mode ? item : { ...item, mode });
    }
    const conversationIds = items.map((item) => (item.envelope.payload as Partial<InterAgentMessagePayload>).conversation_id)
      .filter((cid): cid is string => typeof cid === "string");
    const survivingIds = new Set(conversationIds);
    const removedConversationIds = batch.conversationIds.filter(cid => !survivingIds.has(cid));
    for (const item of removed) this.#onTerminalQueued?.(item);
    if (items.length === 0) return { batch: null, removedConversationIds };
    const prepared = { ...batch, items, conversationIds, text: formatInboundMessages(items) };
    this.#batchByTurnToken.set(turnToken, prepared);
    return { batch: prepared, removedConversationIds };
  }

  markPushed(turnToken: string): void {
    if (this.#batchByTurnToken.has(turnToken)) {
      this.#inputStarted.add(turnToken);
      if (this.#priorityLeases.has(turnToken)) this.#pushedPriorityLeases.add(turnToken);
    }
  }

  /** The queue has accepted these items, but only the host turn-start boundary
   * is allowed to confirm their dispatch to the server (#237). */
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

  /** Stops future dispatch after a watchdog fail-stop while retaining the
   * exact SDK-active generation. Its outcome remains unknown until a real
   * ResultMessage/EOF, so resolving it (or a same-CID successor) here would
   * violate generation ordering. Unstarted batches are discarded from local
   * ownership and reported through the caller's controlled-recovery warning;
   * server disconnect remains the peer-visible fallback on operator restore.
   */
  freezeForWatchdogFailStop(activeTurnToken?: string, retire?: (envelopes: readonly Envelope[]) => void): {
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
      retire?.(batch.items.map((item) => item.envelope));
      droppedDispatched += 1;
    }
    for (const batches of this.#pendingBatches.values()) {
      retire?.(batches.flatMap((batch) => batch.items.map((item) => item.envelope)));
      droppedPending += batches.length;
    }
    this.#pendingBatches.clear();
    this.#priorityLeases.clear();
    this.#pushedPriorityLeases.clear();
    this.#suspendedTokenByPeer.clear();
    return { droppedDispatched, droppedPending };
  }

  /**
   * Stops dispatch permanently and returns every batch that remains owned by
   * the coordinator. Callers first settle host-owned turns, then register and
   * resolve these batches synchronously, enqueueing their notices before
   * closing transport. This cannot guarantee transport acceptance; a closed
   * link falls back to the server's disconnected notice. For a peer, a
   * previously dispatched generation is returned before its FIFO pending
   * batches, preserving same-CID generation order (issue #236).
   */
  closeAndDrain(): readonly DrainedInterAgentBatch[] {
    if (this.#closed) return [];
    this.#closed = true;

    const drained: DrainedInterAgentBatch[] = [];
    const emittedTokens = new Set<string>();
    const peers = new Set([
      ...this.#activeTokenByPeer.keys(),
      ...this.#pendingBatches.keys(),
      ...[...this.#batchByTurnToken.values()].map(batch => batch.peer),
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
      const waiting: Array<{ order: number; dispatched?: DispatchedInterAgentBatch; pending?: PendingBatch }> = [
        ...[...this.#batchByTurnToken.values()]
          .filter(batch => batch.peer === peer && !emittedTokens.has(batch.turnToken))
          .map(batch => ({ order: batch.items[0] === undefined ? Number.MAX_SAFE_INTEGER : this.#receiveOrder.get(batch.items[0].envelope) ?? Number.MAX_SAFE_INTEGER, dispatched: batch })),
        ...(this.#pendingBatches.get(peer) ?? [])
          .map(pending => ({ order: pending.items[0] === undefined ? Number.MAX_SAFE_INTEGER : this.#receiveOrder.get(pending.items[0].envelope) ?? Number.MAX_SAFE_INTEGER, pending })),
      ].sort((a, b) => a.order - b.order);
      for (const item of waiting) {
        if (item.dispatched !== undefined) {
          drained.push(item.dispatched);
          emittedTokens.add(item.dispatched.turnToken);
          this.#retire(item.dispatched.turnToken);
        } else if (item.pending !== undefined) {
          drained.push(this.#drainedBatch(peer, item.pending));
        }
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
    this.#priorityLeases.clear();
    this.#pushedPriorityLeases.clear();
    this.#suspendedTokenByPeer.clear();
    return drained;
  }

  #dispatchNext(peer: string): void {
    if (this.#closed) return;
    if (this.#activeTokenByPeer.has(peer)) return;
    if ([...this.#pushedPriorityLeases].some(token => this.#batchByTurnToken.get(token)?.peer === peer)) return;
    let items: InterAgentBatchItem[];
    while (true) {
      const queue = this.#pendingBatches.get(peer);
      const pending = queue?.shift();
      if (pending === undefined) return;
      if (queue!.length === 0) this.#pendingBatches.delete(peer);
      items = [];
      for (const item of pending.items) {
        const mode = this.#reclassifyQueued?.(item) ?? item.mode;
        if (mode === "terminal") {
          this.#onTerminalQueued?.(item);
        } else {
          items.push(mode === item.mode ? item : { ...item, mode });
        }
      }
      if (items.length > 0) break;
    }

    const turnToken = this.#createTurnToken();
    const conversationIds = items
      .map(
        (item) =>
          (item.envelope.payload as Partial<InterAgentMessagePayload>)
            .conversation_id,
      )
      .filter((cid): cid is string => typeof cid === "string");
    const batch: DispatchedInterAgentBatch = {
      turnToken,
      peer,
      items,
      conversationIds,
      text: formatInboundMessages(items),
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
