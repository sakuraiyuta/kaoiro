// Turns a credit-v1 queue offer into native input for any engine
// (docs/reference/protocol/channels.md, credit-v1; r8 §5.3).
//
// `receiveInbound` records what it classifies (turn numbers, done flags,
// waiter consumption, loss ids). An item classified and then returned is
// offered again later, and classifying it twice would read it as a stale
// duplicate. So each item is classified once per process, and a re-offer
// only re-derives its mode, as the legacy path does for requeued input.
// What is remembered goes only when the item is disposed, or once the
// conversation's track is gone; a count bound would drop a live item's
// classification and turn its re-offer into a silent stale drop.

import type { QueueOffer, QueueOfferItem } from "@kaoiro/wrapper-core";
import type { Envelope } from "./types.js";
import {
  formatInboundMessages,
  type InboundDisposition,
  type InboundReplyMode,
} from "./inter_agent.js";

/** Formatted bytes one native input may carry (r8 §5.3). */
export const QUEUE_INPUT_FORMAT_BUDGET = 16_384;
/** Remembered classifications above which a leak is reported, once. */
const LOUD_REMEMBERED = 1_000;
/** How long a consumed item waits for its tool to ask for it, and how long
 *  the tool waits for the item's permit (r8 §6.2). A parked `begin` settles
 *  only at the next reconcile, so this stays short. */
export const QUEUE_HANDOFF_PERMIT_WAIT_MS = 2_000;

/** Settles queue items a waiting tool consumed, at the tool-result return. */
export interface QueueHandoffLease {
  /** The tool result reached the model. */
  commit(): void;
  /** The tool result was not returned. */
  rollback(): void;
}

export interface QueueInputDeps {
  /** `InterAgentTool.receiveInbound`. */
  classify(envelope: Envelope): Promise<InboundDisposition>;
  /** `InterAgentTool.queuedInboundMode`. */
  reclassify(envelope: Envelope, saved: InboundReplyMode): InboundReplyMode;
  /** Sends a stale-turn notice back to the original sender. */
  sendNotice(notice: Envelope): void;
  /** `InterAgentTool.hasConversationTrack`. */
  tracked(conversationId: string): boolean;
  log?(line: string): void;
  /** Runs `task` after `ms`; returns a cancel function. */
  schedule?(task: () => void, ms: number): () => void;
}

export interface QueueInputItem {
  readonly item: QueueOfferItem;
  readonly mode: InboundReplyMode;
}

export interface PreparedQueueInput {
  readonly offer: QueueOffer;
  /** Items to submit natively, in offer order. */
  readonly injected: readonly QueueInputItem[];
  /** `formatInboundMessages` of `injected`; empty when nothing is injected. */
  readonly text: string;
  /** Items a waiting tool took as its reply. They are held here until the
   *  tool asks for them (`handoff`); engines do not settle them. */
  readonly consumed: readonly QueueOfferItem[];
}

type Classified =
  | { kind: "inject"; mode: InboundReplyMode }
  | { kind: "consumed"; mode: InboundReplyMode }
  | { kind: "terminal" }
  | { kind: "stale" };

interface Remembered {
  identity: string;
  conversationId: string;
  /** Unset while `classify` runs. */
  classified?: Classified;
  /** Resolves once `prepare` has stored and routed the classification. */
  pending: Promise<void>;
  settle: () => void;
  /** Whether this message, if yield-granted, is cut or downgraded is decided
   *  and reported; a yield disposition is set once. */
  yieldDecided?: boolean;
}

function identityOf(envelope: Envelope): string {
  const payload = envelope.payload as { conversation_id?: unknown; turn_number?: unknown };
  return JSON.stringify([envelope.agent_id, payload.conversation_id, payload.turn_number]);
}

function conversationOf(envelope: Envelope): string {
  return String((envelope.payload as { conversation_id?: unknown }).conversation_id ?? "");
}

function formattedBytes(items: readonly QueueInputItem[]): number {
  return Buffer.byteLength(
    formatInboundMessages(items.map(({ item, mode }) => ({ envelope: item.envelope as Envelope, mode }))),
    "utf8",
  );
}

interface AwaitingTool {
  offer: QueueOffer;
  cancel: () => void;
}

export class QueueInput {
  readonly #deps: QueueInputDeps;
  readonly #remembered = new Map<string, Remembered>();
  /** Consumed items held for their tool, by queue id. */
  readonly #awaiting = new Map<string, AwaitingTool>();
  #warned = false;

  constructor(deps: QueueInputDeps) {
    this.#deps = deps;
  }

  /** Classifies, partitions and trims an offer. Items it does not inject are
   *  settled here: terminal and stale ones disposed, the trimmed suffix
   *  returned with `format_budget`. */
  async prepare(offer: QueueOffer): Promise<PreparedQueueInput> {
    for (const [id, remembered] of this.#remembered) {
      // An entry still being classified may not have its track yet.
      if (remembered.classified !== undefined && !this.#deps.tracked(remembered.conversationId)) {
        this.#remembered.delete(id);
      }
    }
    const injected: QueueInputItem[] = [];
    const consumed: QueueOfferItem[] = [];
    const skipped: { queue_id: string; reason: "terminal_skip" | "stale_skip" }[] = [];

    for (const item of offer.items) {
      const classified = await this.#classify(item);
      switch (classified.kind) {
        case "inject": injected.push({ item, mode: classified.mode }); break;
        case "consumed": consumed.push(item); this.#awaitTool(offer, item.queueId); break;
        case "terminal": skipped.push({ queue_id: item.queueId, reason: "terminal_skip" }); break;
        case "stale": skipped.push({ queue_id: item.queueId, reason: "stale_skip" }); break;
      }
      // A tool woken by this classification may now ask for the item.
      this.#remembered.get(item.queueId)?.settle();
    }

    let kept = injected.length === 0 ? 0 : 1;
    while (kept < injected.length && formattedBytes(injected.slice(0, kept + 1)) <= QUEUE_INPUT_FORMAT_BUDGET) {
      kept++;
    }
    const suffix = injected.slice(kept);
    if (suffix.length > 0) {
      void offer.return(suffix.map(({ item }) => ({ queue_id: item.queueId, reason: "format_budget" as const })));
    }
    if (skipped.length > 0) {
      const ids = skipped.map((entry) => entry.queue_id);
      void offer.dispose(skipped.map(({ queue_id, reason }) =>
        ({ queue_id, outcome: "intentional_non_injection" as const, reason })))
        .then((result) => { if (result.ok) this.forget(ids); });
    }

    const injectedNow = injected.slice(0, kept);
    return {
      offer,
      injected: injectedNow,
      text: injectedNow.length === 0
        ? ""
        : formatInboundMessages(injectedNow.map(({ item, mode }) => ({ envelope: item.envelope as Envelope, mode }))),
      consumed,
    };
  }

  /** Drops what was remembered for settled items. */
  forget(queueIds: readonly string[]): void {
    for (const id of queueIds) this.#remembered.delete(id);
  }

  /** A waiter-carrying offer (`kind: "waiter"`): a consumed reply waits for
   *  its tool; one no waiter took (the wait ended first) goes back as W. */
  async acceptWaiter(offer: QueueOffer): Promise<void> {
    const prepared = await this.prepare(offer);
    const unclaimed = prepared.injected.map(({ item }) => item.queueId);
    if (unclaimed.length > 0) {
      void offer.return(unclaimed.map((queue_id) => ({ queue_id, reason: "waiter_abandoned" as const })));
    }
  }

  /** The waiting tool of turn `turnToken` is about to return `envelopes`.
   *  For queue items it consumed, the permit is taken under that turn before
   *  the result goes out. `undefined`: not queue items. `null`: no permit;
   *  the tool answers as for a wait with no reply, and the items go back to
   *  be injected later. */
  async handoff(envelopes: readonly Envelope[], turnToken: string): Promise<QueueHandoffLease | null | undefined> {
    const identities = new Set(envelopes.map(identityOf));
    const matches = [...this.#remembered].filter(([, remembered]) => identities.has(remembered.identity));
    // The tool can resume before the classification that woke it returns.
    await Promise.all(matches.map(([, remembered]) => remembered.pending));
    const ids = matches.map(([id]) => id).filter((id) => this.#awaiting.has(id));
    if (ids.length === 0) return undefined;
    const offer = this.#awaiting.get(ids[0]!)!.offer;
    const own = ids.filter((id) => this.#awaiting.get(id)!.offer === offer);
    for (const id of own) {
      this.#awaiting.get(id)!.cancel();
      this.#awaiting.delete(id);
    }

    let timedOut = false;
    let cancel = (): void => {};
    const submit = await Promise.race([
      offer.begin(own, turnToken),
      new Promise<null>((resolve) => {
        cancel = this.#schedule(() => { timedOut = true; resolve(null); }, QUEUE_HANDOFF_PERMIT_WAIT_MS);
      }),
    ]);
    cancel();
    if (submit === null) {
      if (timedOut) this.#deps.log?.(`[kaoiro] queue handoff permit timed out; the items go back: ${own.join(",")}\n`);
      this.#giveBack(offer, own);
      return null;
    }
    return {
      commit: () => {
        submit.invoke(() => {});
        void offer.dispose(own.map((queue_id) => ({ queue_id, outcome: "observed" as const, witness: "tool_result" as const })))
          .then((result) => { if (result.ok) this.forget(own); });
      },
      rollback: () => {
        this.#unconsume(own);
        void offer.return(own.map((queue_id) => ({ queue_id, reason: "waiter_abandoned" as const })));
      },
    };
  }

  #awaitTool(offer: QueueOffer, queueId: string): void {
    this.#awaiting.get(queueId)?.cancel();
    const cancel = this.#schedule(() => {
      if (this.#awaiting.get(queueId)?.offer !== offer) return;
      this.#awaiting.delete(queueId);
      this.#deps.log?.(`[kaoiro] queue item consumed by a waiter was not asked for in time; it goes back: ${queueId}\n`);
      this.#giveBack(offer, [queueId]);
    }, QUEUE_HANDOFF_PERMIT_WAIT_MS);
    this.#awaiting.set(queueId, { offer, cancel });
  }

  /** No tool result carries these items: they are injected when offered
   *  again. The rewrite comes first, with no await before the release. */
  #giveBack(offer: QueueOffer, ids: readonly string[]): void {
    this.#unconsume(ids);
    offer.release(ids);
  }

  #unconsume(ids: readonly string[]): void {
    for (const id of ids) {
      const remembered = this.#remembered.get(id);
      if (remembered?.classified?.kind === "consumed") {
        remembered.classified = { kind: "inject", mode: remembered.classified.mode };
      }
    }
  }

  #schedule(task: () => void, ms: number): () => void {
    if (this.#deps.schedule !== undefined) return this.#deps.schedule(task, ms);
    const timer = setTimeout(task, ms);
    timer.unref?.();
    return () => clearTimeout(timer);
  }

  /** Records that the yield of the classified item `queueId` is decided.
   *  Returns true only the first time, when the caller reports it. */
  decideYield(queueId: string): boolean {
    const remembered = this.#remembered.get(queueId);
    if (remembered?.classified === undefined || remembered.yieldDecided === true) return false;
    remembered.yieldDecided = true;
    return true;
  }

  /** Whether the yield of `queueId` is already decided. */
  yieldDecided(queueId: string): boolean {
    return this.#remembered.get(queueId)?.yieldDecided === true;
  }


  async #classify(item: QueueOfferItem): Promise<Classified> {
    const envelope = item.envelope as Envelope;
    const identity = identityOf(envelope);
    const remembered = this.#remembered.get(item.queueId);
    if (remembered?.classified !== undefined && remembered.identity === identity) {
      const previous = remembered.classified;
      if (previous.kind !== "inject") return previous;
      const mode = this.#deps.reclassify(envelope, previous.mode);
      return mode === "terminal" ? { kind: "terminal" } : { kind: "inject", mode };
    }

    let settle!: () => void;
    const pending = new Promise<void>((resolve) => { settle = resolve; });
    const entry: Remembered = { identity, conversationId: conversationOf(envelope), pending, settle };
    this.#remembered.set(item.queueId, entry);
    let disposition: InboundDisposition;
    try {
      disposition = await this.#deps.classify(envelope);
    } catch (error) {
      this.#remembered.delete(item.queueId);
      settle();
      throw error;
    }
    const classified: Classified = disposition.consumed
      ? { kind: "consumed", mode: disposition.mode }
      : disposition.inject
        ? { kind: "inject", mode: disposition.mode }
        : disposition.mode === "terminal" && disposition.notice === undefined &&
            disposition.noticeSkipReason === undefined
          ? { kind: "terminal" }
          : { kind: "stale" };
    if (disposition.notice !== undefined) this.#deps.sendNotice(disposition.notice);

    entry.classified = classified;
    if (this.#remembered.size > LOUD_REMEMBERED && !this.#warned) {
      this.#warned = true;
      this.#deps.log?.(`[kaoiro] queue input remembers ${this.#remembered.size} classifications; settled items are not being forgotten\n`);
    }
    return classified;
  }
}
