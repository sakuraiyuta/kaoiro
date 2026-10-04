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
// Liveness: while T is active, has folds left and early is negotiated, an
// early credit is outstanding, requested, or a re-check is scheduled. Every
// settlement of an early offer re-checks, since only a `return` keeps the
// server's credit, and a state that blocks folding for now is re-checked
// with backoff instead of waiting for a callback.

import type { QueueLease, QueueOffer } from "@kaoiro/wrapper-core";
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
  log(line: string): void;
  /** Runs `task` after `ms`. */
  schedule?(task: () => void, ms: number): void;
}

/** How long an early offer waits for another pushed input's decision before
 *  it is declined. Bounded: the offer holds the ordinary lease slot. */
export const FOLD_RECEIPT_WAIT_MS = 2_000;
const RETRY_FIRST_MS = 250;
const RETRY_MAX_MS = 5_000;
const LOG_REFUSAL_AGAIN_AT = 5;

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

interface ConsumedEarly {
  offer: QueueOffer;
  id: string;
  turn: string;
}

type Decline = "fold_unavailable" | "conversation_pending" | "oversize";

export class ClaudeQueueEarly {
  readonly #deps: QueueEarlyDeps;
  /** Turn whose readiness check is waiting for the link. */
  #checking: string | null = null;
  /** An early offer is being handled, or its push awaits a decision. */
  #held = 0;
  readonly #pushed = new Map<readonly Envelope[], PushedFold>();
  readonly #consumed: ConsumedEarly[] = [];
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
    try {
      awaitingDecision = await this.#onOffer(offer);
    } catch (error) {
      // An offer left unsettled would hold the ordinary lease slot.
      this.#deps.log(`[kaoiro] queue early offer failed; its items go back unsent: ${String(error)}\n`);
      offer.release(offer.items.map((item) => item.queueId));
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

    const prepared = await deps.input.prepare(offer);
    const consumedIds = prepared.consumed.map((item) => item.queueId);
    if (consumedIds.length > 0) await this.#beginConsumed(offer, consumedIds, turn);
    const injected = prepared.injected.map(({ item }) => item);
    if (injected.length === 0) return false;
    const injectIds = injected.map((item) => item.queueId);
    const envelopes = injected.map((item) => item.envelope as Envelope);

    const submit = await offer.begin(injectIds, turn);
    if (submit === null) {
      offer.release(injectIds);
      return false;
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
        conversationIds: [...new Set(envelopes.map((envelope) =>
          String((envelope.payload as Partial<InterAgentMessagePayload>).conversation_id ?? "")))],
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

  async #beginConsumed(offer: QueueOffer, ids: readonly string[], turn: string): Promise<void> {
    const submit = await offer.begin(ids, turn);
    if (submit === null) {
      offer.release(ids);
      return;
    }
    for (const id of ids) this.#consumed.push({ offer, id, turn });
    this.handoff();
  }

  /** A tool result was returned; consumed items it carried are observed. */
  handoff(): void {
    for (let i = this.#consumed.length - 1; i >= 0; i--) {
      const entry = this.#consumed[i]!;
      if (!this.#deps.input.handedOff(entry.id)) continue;
      this.#consumed.splice(i, 1);
      void entry.offer.dispose([{ queue_id: entry.id, outcome: "observed", witness: "tool_result" }])
        .then((result) => { if (result.ok) this.#deps.input.forget([entry.id]); });
    }
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

  /** Turn `turnToken` ended: its early credit is withdrawn and consumed items
   *  never handed to the model are unknown. */
  turnEnded(turnToken: string | undefined): void {
    if (turnToken === undefined) return;
    if (this.#checking === turnToken) this.#checking = null;
    if (this.#deps.slot.token("early") === turnToken) this.#deps.slot.clear("early", this.#deps.lease());
    for (let i = this.#consumed.length - 1; i >= 0; i--) {
      const entry = this.#consumed[i]!;
      if (entry.turn !== turnToken) continue;
      this.#consumed.splice(i, 1);
      void entry.offer.dispose([{ queue_id: entry.id, outcome: "unknown", reason: "consumed_unhandled" }])
        .then((result) => { if (result.ok) this.#deps.input.forget([entry.id]); });
    }
  }
}
