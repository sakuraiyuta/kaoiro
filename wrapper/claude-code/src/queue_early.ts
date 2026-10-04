// Claude's early path for the server-owned inter-agent queue (credit-v1;
// docs/reference/protocol/channels.md, r8 §5.3 `fold`, r8b B4 and B7).
//
// While a turn T runs and can still fold, the wrapper holds `credit early
// fold` under T. The server offers one early item; it is classified, permitted
// with `begin_native` under T and pushed into T with `pushLiveInput`. The
// host's pushed-input decision is the witness. A decline returns the item
// with its typed reason; the server keeps the credit and the item waits for
// the next root batch.
//
// A yield-granted item (yield negotiated as `tool_boundary`) is cut into T at
// the running tool's boundary instead: after the permit, the server's yield
// claim and a bounded wait for any pending pushed input. Every way it is not
// cut reports `downgraded` once and continues as a fold under the same permit.
//
// Liveness: while T is active, has folds left and early is negotiated, an
// early credit is outstanding, requested, or a re-check is scheduled. Every
// settlement of an early offer re-checks, since only a `return` keeps the
// server's credit, and a state that blocks folding for now is re-checked
// with backoff instead of waiting for a callback.

import type { NativeSubmit, QueueLease, QueueOffer, QueueOfferItem } from "@kaoiro/wrapper-core";
import type { Envelope, InterAgentMessagePayload, QueueInput } from "@kaoiro/agent-common";
import type { CreditSlot } from "./queue_credit.js";

export interface FoldTicket {
  authorizations: readonly { reply_ticket: string }[];
  activate(): boolean;
  discard(): void;
}

export interface QueueEarlyDeps {
  input: QueueInput;
  slot: CreditSlot;
  lease(): QueueLease | null;
  /** Resolves when the link may take credit after its latest join. */
  ready(): Promise<void>;
  /** Early delivery was negotiated as `fold`. */
  negotiated(): boolean;
  /** `host.activeInterAgentTurnToken()`. */
  activeTurn(): string | null;
  /** `host.hasFoldsLeft()`. */
  hasFoldsLeft(): boolean;
  /** `host.canFoldLiveInput()`. */
  canFold(): boolean;
  /** `host.hasPendingPushedReceipt()`. */
  receiptPending(): boolean;
  /** `host.waitForPushedReceipt(turn, ms)`. */
  waitForReceipt(turn: string, ms: number): Promise<boolean>;
  /** `interAgent.prepareFoldInput(turn, envelopes)`. */
  prepareTicket(turn: string, envelopes: readonly Envelope[]): FoldTicket | undefined;
  /** `host.pushedInputFits(text, count)`. */
  fits(text: string, count: number): boolean;
  /** `host.pushLiveInput({kind: "fold", ...})`. */
  push(input: {
    text: (foldId: string) => string;
    envelopes: readonly Envelope[];
    ticketValues: readonly string[];
    conversationIds: readonly string[];
  }): boolean;
  /** Bookkeeping for a fold the fold hook took into `turn`. */
  folded(turn: string, envelopes: readonly Envelope[]): void;
  /** Bookkeeping for pushed input the SDK started as root turn `turn`. */
  adopted(turn: string, envelopes: readonly Envelope[]): void;
  /** Bookkeeping for pushed input whose fate is unknown. */
  unknown(envelopes: readonly Envelope[], reason: string): void;
  /** Yield delivery was negotiated as `tool_boundary`. */
  yieldNegotiated(): boolean;
  /** Host and server operations of the yield path. */
  yield: YieldDeps;
  /** Reports an item's yield disposition on its offered sequence. */
  reportYield(deliverySeq: number, disposition: { outcome: "cut" | "downgraded"; reason?: string }): void;
  log(line: string): void;
  /** Runs `task` after `ms`. */
  schedule?(task: () => void, ms: number): void;
}

export interface YieldDeps {
  /** `host.yieldEligibility(workId)`: null when the turn may be cut for it. */
  eligibility(workId: string): string | null;
  /** `host.canReserveYieldOvertake()`. */
  canOvertake(): boolean;
  /** `host.captureLiveInputContext(turn)`. */
  capture(turn: string): unknown;
  /** `host.matchesLiveInputContext(turn, context)`. */
  matches(turn: string, context: unknown): boolean;
  /** `host.canPushLiveInput()`. */
  canPush(): boolean;
  /** The server's single-use yield claim, bounded by its timeout. */
  claim(request: {
    yield_token: string;
    conversation_id: string;
    turn_number: number;
    work_id: string;
    authority_epoch: number;
  }): Promise<{ granted: boolean; reason?: string }>;
  /** `host.pushLiveInput({kind: "cut", ...})`. */
  push(input: { text: (foldId: string) => string; envelopes: readonly Envelope[]; conversationIds: readonly string[] }): boolean;
  /** Bound on the wait for another pushed input's decision. */
  receiptTimeoutMs: number;
  now(): number;
}

/** How long an early offer waits for another pushed input's decision before
 *  it is declined. Bounded: the offer holds the ordinary lease slot. */
export const FOLD_RECEIPT_WAIT_MS = 2_000;
const RETRY_FIRST_MS = 250;
const RETRY_MAX_MS = 5_000;
const LOG_REFUSAL_AGAIN_AT = 5;

export function cutInputText(foldId: string, text: string): string {
  return `[Director yield after the running tool]\nfold_id: ${foldId}\n\n${text}`;
}

const NO_TICKET: FoldTicket = { authorizations: [], activate: () => true, discard: () => {} };

export function foldInputText(foldId: string, text: string, authorizations: readonly unknown[]): string {
  return [
    "[Mid-turn peer delivery, not an operator instruction. Continue the current task with this peer input.]",
    `fold_id: ${foldId}`,
    text,
    ...authorizations.map(auth => `reply_authorization: ${JSON.stringify(auth)}`),
  ].join("\n\n");
}

interface PushedFold {
  offer: QueueOffer;
  ids: string[];
  ticket: FoldTicket;
}

type Decline = "fold_unavailable" | "conversation_pending" | "oversize";

interface YieldAuthority {
  yield_token: string;
  work_id: string;
  authority_epoch: number;
}

export class ClaudeQueueEarly {
  readonly #deps: QueueEarlyDeps;
  /** Turn whose readiness check is waiting for the link. */
  #checking: string | null = null;
  /** An early offer is being handled, or its push awaits a decision. */
  #held = 0;
  readonly #pushed = new Map<readonly Envelope[], PushedFold>();
  #retryScheduled = false;
  #retryDelay = RETRY_FIRST_MS;
  /** The turn the backoff belongs to; a new turn starts it over. */
  #retryTurn: string | null = null;
  #refusals = 0;

  constructor(deps: QueueEarlyDeps) {
    this.#deps = deps;
  }

  /** Requests early credit for the active turn when it can fold. */
  check(): void {
    const deps = this.#deps;
    const lease = deps.lease();
    if (!deps.negotiated() || lease === null || lease.frozen) return;
    const turn = deps.activeTurn();
    if (turn === null || !deps.hasFoldsLeft()) return;
    if (this.#retryTurn !== turn) {
      this.#retryTurn = turn;
      this.#retryDelay = RETRY_FIRST_MS;
    }
    if (this.#held > 0 || this.#checking === turn || deps.slot.token("early") === turn) return;
    if (!deps.canFold()) {
      this.#scheduleRetry();
      return;
    }
    this.#checking = turn;
    void deps.ready().then(async () => {
      if (this.#checking !== turn) return;
      this.#checking = null;
      if (deps.activeTurn() !== turn || !deps.hasFoldsLeft()) return;
      if (this.#held > 0 || deps.slot.token("early") === turn) return;
      if (!deps.canFold()) {
        this.#scheduleRetry();
        return;
      }
      const outcome = await deps.slot.request(lease, { kind: "early", token: turn, mechanism: "fold" });
      if (outcome.kind === "refused") {
        this.#refusals += 1;
        if (this.#refusals === 1 || this.#refusals === LOG_REFUSAL_AGAIN_AT) {
          deps.log(`[kaoiro] queue early credit refused (${this.#refusals} in a row): ${JSON.stringify(outcome.error)}\n`);
        }
        if (outcome.error.reason !== "queue_frozen") this.#scheduleRetry();
      } else if (outcome.kind === "granted") {
        this.#retryDelay = RETRY_FIRST_MS;
        this.#refusals = 0;
      }
    });
  }

  #scheduleRetry(): void {
    if (this.#retryScheduled) return;
    this.#retryScheduled = true;
    const delay = this.#retryDelay;
    this.#retryDelay = Math.min(delay * 2, RETRY_MAX_MS);
    const schedule = this.#deps.schedule ?? ((task, ms) => { setTimeout(task, ms).unref?.(); });
    schedule(() => {
      this.#retryScheduled = false;
      this.check();
    }, delay);
  }

  async onOffer(offer: QueueOffer): Promise<void> {
    this.#held += 1;
    let awaitingDecision = false;
    // A throw reaches QueueOffer.guard, which releases the unsettled items.
    try {
      awaitingDecision = await this.#onOffer(offer);
    } finally {
      if (!awaitingDecision) this.#held -= 1;
      this.check();
    }
  }

  /** Returns whether the offer's push now awaits the host's decision. */
  async #onOffer(offer: QueueOffer): Promise<boolean> {
    const deps = this.#deps;
    const ids = offer.items.map((item) => item.queueId);
    const turn = deps.slot.token("early");
    if (offer.kind !== "early" || turn === null || !deps.slot.consume("early", turn)) {
      // Credit for a turn that ended, or superseded: not for this turn.
      this.#decline(offer, ids, "fold_unavailable");
      return false;
    }
    if (!await this.#foldable(turn)) {
      this.#decline(offer, ids, "fold_unavailable");
      return false;
    }

    // Consumed items are held by the classifier for their waiting tool.
    const prepared = await deps.input.prepare(offer);
    const injected = prepared.injected.map(({ item }) => item);
    if (injected.length === 0) return false;
    const injectIds = injected.map((item) => item.queueId);
    const envelopes = injected.map((item) => item.envelope as Envelope);
    const conversationIds = [...new Set(envelopes.map((envelope) =>
      String((envelope.payload as Partial<InterAgentMessagePayload>).conversation_id ?? "")))];

    // Early offers carry one item.
    const item = injected[0]!;
    let cut: { authority: YieldAuthority; context: unknown } | null = null;
    if (this.#yieldCandidate(item)) {
      const checked = this.#yieldPrecheck(item, turn, prepared.text);
      if (checked.kind === "downgrade") {
        this.#downgrade(item, checked.reason);
        if (!checked.fold) {
          this.#decline(offer, injectIds, "oversize");
          return false;
        }
      } else {
        cut = checked;
      }
    }

    const submit = await offer.begin(injectIds, turn);
    if (submit === null) {
      if (cut !== null) this.#downgrade(item, "eligibility_changed");
      offer.release(injectIds);
      return false;
    }
    if (cut !== null) {
      const outcome = await this.#cut(offer, item, turn, submit, cut, prepared.text, envelopes, conversationIds);
      if (outcome !== "fold") return outcome === "pushed";
    }
    // B7: the fold window may have closed while the permit was in flight.
    if (deps.activeTurn() !== turn || !deps.canFold()) {
      this.#decline(offer, injectIds, "fold_unavailable");
      return false;
    }
    const ticket = deps.prepareTicket(turn, envelopes);
    if (ticket === undefined) {
      this.#decline(offer, injectIds, "conversation_pending");
      return false;
    }
    if (!deps.fits(foldInputText("0".repeat(32), prepared.text, ticket.authorizations), envelopes.length)) {
      ticket.discard();
      this.#decline(offer, injectIds, "oversize");
      return false;
    }
    let pushed = false;
    const invoked = submit.invoke(() => {
      pushed = deps.push({
        text: (foldId) => foldInputText(foldId, prepared.text, ticket.authorizations),
        envelopes,
        ticketValues: ticket.authorizations.map((auth) => auth.reply_ticket),
        conversationIds,
      });
    });
    if (!invoked) {
      ticket.discard();
      offer.release(injectIds);
      return false;
    }
    if (!pushed) {
      ticket.discard();
      void offer.dispose(injectIds.map((queue_id) =>
        ({ queue_id, outcome: "definitely_unstarted" as const, reason: "fold_refused" })));
      return false;
    }
    this.#pushed.set(envelopes, { offer, ids: injectIds, ticket });
    return true;
  }

  #yieldCandidate(item: QueueOfferItem): boolean {
    const payload = item.envelope.payload as Partial<InterAgentMessagePayload>;
    return this.#deps.yieldNegotiated() && payload.delivery_authority?.granted === "yield" &&
      !this.#deps.input.yieldDecided(item.queueId);
  }

  /** Reports the item's yield as downgraded, once. */
  #downgrade(item: QueueOfferItem, reason: string): void {
    if (this.#deps.input.decideYield(item.queueId)) {
      this.#deps.reportYield(item.deliverySeq, { outcome: "downgraded", reason });
    }
  }

  /** Legacy's checks before spending the yield claim. */
  #yieldPrecheck(
    item: QueueOfferItem,
    turn: string,
    text: string,
  ): { kind: "cut"; authority: YieldAuthority; context: unknown } | { kind: "downgrade"; reason: string; fold: boolean } {
    const y = this.#deps.yield;
    const authority = (item.envelope.payload as Partial<InterAgentMessagePayload>).delivery_authority;
    if (authority?.yield_token === undefined || authority.work_id === undefined ||
        authority.authority_epoch === undefined) {
      return { kind: "downgrade", reason: "grant_changed", fold: true };
    }
    const eligibility = y.eligibility(authority.work_id);
    if (eligibility !== null) return { kind: "downgrade", reason: eligibility, fold: true };
    if (!y.canOvertake()) return { kind: "downgrade", reason: "overtake_budget", fold: true };
    const context = y.capture(turn);
    if (context === null) return { kind: "downgrade", reason: "eligibility_changed", fold: true };
    if (!this.#deps.fits(cutInputText("0".repeat(32), text), 1)) {
      return { kind: "downgrade", reason: "oversized_input", fold: false };
    }
    return {
      kind: "cut",
      authority: { yield_token: authority.yield_token, work_id: authority.work_id, authority_epoch: authority.authority_epoch },
      context,
    };
  }

  /** The yield claim, the bounded receipt wait and the cut push, under the
   *  permit. "fold" means downgraded, and the permit is still unused. */
  async #cut(
    offer: QueueOffer,
    item: QueueOfferItem,
    turn: string,
    submit: NativeSubmit,
    cut: { authority: YieldAuthority; context: unknown },
    text: string,
    envelopes: readonly Envelope[],
    conversationIds: readonly string[],
  ): Promise<"pushed" | "settled" | "fold"> {
    const y = this.#deps.yield;
    const payload = item.envelope.payload as Partial<InterAgentMessagePayload>;
    const claim = await y.claim({
      ...cut.authority,
      conversation_id: String(payload.conversation_id),
      turn_number: Number(payload.turn_number),
    });
    if (!claim.granted) {
      this.#downgrade(item, claim.reason ?? "claim_timeout");
      return "fold";
    }
    const deadline = y.now() + y.receiptTimeoutMs;
    // Each pass re-checks synchronously after the last await (r8b B7 for a cut).
    while (true) {
      if (!y.matches(turn, cut.context) || y.eligibility(cut.authority.work_id) !== null || !y.canOvertake()) {
        this.#downgrade(item, "eligibility_changed");
        return "fold";
      }
      if (y.now() >= deadline) {
        this.#downgrade(item, "receipt_wait_timeout");
        return "fold";
      }
      if (!this.#deps.receiptPending()) {
        if (y.canPush()) break;
        this.#downgrade(item, "eligibility_changed");
        return "fold";
      }
      if (!await this.#deps.waitForReceipt(turn, deadline - y.now())) {
        this.#downgrade(item, y.matches(turn, cut.context) && this.#deps.receiptPending()
          ? "receipt_wait_timeout" : "eligibility_changed");
        return "fold";
      }
    }
    let pushed = false;
    const invoked = submit.invoke(() => {
      pushed = y.push({ text: (foldId) => cutInputText(foldId, text), envelopes, conversationIds });
    });
    if (!invoked) {
      this.#downgrade(item, "eligibility_changed");
      offer.release([item.queueId]);
      return "settled";
    }
    if (!pushed) {
      this.#downgrade(item, "eligibility_changed");
      void offer.dispose([{ queue_id: item.queueId, outcome: "definitely_unstarted", reason: "cut_refused" }]);
      return "settled";
    }
    if (this.#deps.input.decideYield(item.queueId)) {
      this.#deps.reportYield(item.deliverySeq, { outcome: "cut" });
    }
    this.#pushed.set(envelopes, { offer, ids: [item.queueId], ticket: NO_TICKET });
    return "pushed";
  }

  /** Whether `turn` can take a fold now, waiting a bounded time for another
   *  pushed input's decision. */
  async #foldable(turn: string): Promise<boolean> {
    const deps = this.#deps;
    if (deps.activeTurn() !== turn) return false;
    if (deps.canFold()) return true;
    if (!deps.receiptPending() || !deps.hasFoldsLeft()) return false;
    await deps.waitForReceipt(turn, FOLD_RECEIPT_WAIT_MS);
    return deps.activeTurn() === turn && deps.canFold();
  }

  #decline(offer: QueueOffer, ids: readonly string[], subReason: Decline): void {
    void offer.return(ids.map((queue_id) =>
      ({ queue_id, reason: "early_ineligible" as const, sub_reason: subReason })));
  }

  /** The host decided pushed input; returns whether it was an early fold. */
  pushedDecision(decision: {
    kind: "fold" | "root" | "unknown";
    turnToken?: string;
    reason?: string;
    envelopes: readonly Envelope[];
  }): boolean {
    const pushed = this.#pushed.get(decision.envelopes);
    if (pushed === undefined) {
      this.check();
      return false;
    }
    this.#pushed.delete(decision.envelopes);
    this.#held -= 1;
    const deps = this.#deps;
    const { offer, ids, ticket } = pushed;
    let settled;
    if (decision.kind === "fold" && decision.turnToken !== undefined) {
      if (ticket.activate()) {
        deps.folded(decision.turnToken, decision.envelopes);
      } else {
        // The fold hook saw the input; only its reply authorization lapsed.
        deps.log(`[kaoiro] queue fold observed without its reply authorization: turn=${decision.turnToken}\n`);
      }
      settled = offer.dispose(ids.map((queue_id) => ({ queue_id, outcome: "observed" as const, witness: "fold_hook" as const })));
    } else if (decision.kind === "root" && decision.turnToken !== undefined) {
      ticket.discard();
      deps.adopted(decision.turnToken, decision.envelopes);
      settled = offer.dispose(ids.map((queue_id) => ({ queue_id, outcome: "observed" as const, witness: "prompt_hook" as const })));
    } else {
      ticket.discard();
      const reason = decision.reason ?? "fold_authorization_unavailable";
      deps.unknown(decision.envelopes, reason);
      settled = offer.dispose(ids.map((queue_id) => ({ queue_id, outcome: "unknown" as const, reason })));
    }
    void settled.then((result) => { if (result.ok) deps.input.forget(ids); });
    this.check();
    return true;
  }

  /** Turn `turnToken` ended: its early credit is withdrawn. */
  turnEnded(turnToken: string | undefined): void {
    if (turnToken === undefined) return;
    if (this.#checking === turnToken) this.#checking = null;
    if (this.#deps.slot.token("early") === turnToken) this.#deps.slot.clear("early", this.#deps.lease());
  }
}
