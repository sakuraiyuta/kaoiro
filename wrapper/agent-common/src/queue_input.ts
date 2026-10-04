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
  /** Items a waiting tool took as its reply; their witness is the
   *  tool-result return. */
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
  /** A waiting tool's result carrying this message was returned. */
  handedOff: boolean;
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

export class QueueInput {
  readonly #deps: QueueInputDeps;
  readonly #remembered = new Map<string, Remembered>();
  #warned = false;

  constructor(deps: QueueInputDeps) {
    this.#deps = deps;
  }

  /** Classifies, partitions and trims an offer. Items it does not inject are
   *  settled here: terminal and stale ones disposed, the trimmed suffix
   *  returned with `format_budget`. */
  async prepare(offer: QueueOffer): Promise<PreparedQueueInput> {
    for (const [id, remembered] of this.#remembered) {
      if (!this.#deps.tracked(remembered.conversationId)) this.#remembered.delete(id);
    }
    const injected: QueueInputItem[] = [];
    const consumed: QueueOfferItem[] = [];
    const skipped: { queue_id: string; reason: "terminal_skip" | "stale_skip" }[] = [];

    for (const item of offer.items) {
      const classified = await this.#classify(item);
      switch (classified.kind) {
        case "inject": injected.push({ item, mode: classified.mode }); break;
        case "consumed": consumed.push(item); break;
        case "terminal": skipped.push({ queue_id: item.queueId, reason: "terminal_skip" }); break;
        case "stale": skipped.push({ queue_id: item.queueId, reason: "stale_skip" }); break;
      }
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

  /** A tool result carrying `envelopes` was returned to the model: the
   *  witness for items a waiting tool consumed. It may come before their
   *  classification has finished, so it is kept on the remembered entry. */
  noteHandoff(envelopes: readonly Envelope[]): void {
    const identities = new Set(envelopes.map(identityOf));
    for (const remembered of this.#remembered.values()) {
      if (identities.has(remembered.identity)) remembered.handedOff = true;
    }
  }

  /** Whether the consumed item `queueId` was handed to the model. */
  handedOff(queueId: string): boolean {
    return this.#remembered.get(queueId)?.handedOff === true;
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

    const entry: Remembered = { identity, conversationId: conversationOf(envelope), handedOff: false };
    this.#remembered.set(item.queueId, entry);
    let disposition: InboundDisposition;
    try {
      disposition = await this.#deps.classify(envelope);
    } catch (error) {
      this.#remembered.delete(item.queueId);
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
