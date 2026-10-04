// Claude's root path for the server-owned inter-agent queue (credit-v1;
// docs/reference/protocol/channels.md, r8 §5.3 and §6.4, r9 S1).
//
// At readiness (no SDK turn running or queued, no IA root batch held) it
// asks for root credit under a fresh native turn token T. The offer is
// prepared by QueueInput, permitted with `begin_native` under T and sent to
// the host as turn T. The prompt hook for T is the witness. Settlement goes
// only through QueueLease dispositions, never through the cumulative
// delivery acknowledgement.
//
// Root credit stands for an idle host: when any other turn starts, the
// credit is withdrawn, and a root offer that arrives while the host is busy
// is returned before it is classified. So no waiting tool can be running
// when a root item is classified, and a root item is never consumed.
//
// Liveness: while the host is idle and holds no root, a root credit is
// outstanding, requested, or scheduled for a retry. Every exit of a root
// offer re-arms readiness; a refused credit, and a host found busy, are
// re-checked with backoff, since not every way out of busy ends a turn.

import { randomUUID } from "node:crypto";
import type { QueueLease, QueueOffer } from "@kaoiro/wrapper-core";
import type { QueueInput } from "@kaoiro/agent-common";
import type { Envelope, InterAgentMessagePayload } from "@kaoiro/agent-common";
import type { CreditSlot } from "./queue_credit.js";

export interface QueueRootDeps {
  /** The classifier shared with the early path. */
  input: QueueInput;
  /** The credit record shared with the early path. */
  slot: CreditSlot;
  lease(): QueueLease | null;
  /** Resolves when the link may take credit after its latest join. */
  ready(): Promise<void>;
  /** No SDK turn is running or queued and admission is open. */
  isIdle(): boolean;
  /** Runs `task` on the CLI's single instruction chain. */
  enqueue(task: () => Promise<void>): Promise<void>;
  /** `host.send` of a peer root input as turn `turnToken`. */
  send(text: string, conversationIds: readonly string[], turnToken: string, envelopes: readonly Envelope[]): Promise<void>;
  /** Pending-reply and reply-basis bookkeeping for a starting root turn. */
  preparePending(turnToken: string, envelopes: readonly Envelope[]): void;
  log(line: string): void;
  /** Defers a readiness check past the current host callback. */
  defer?(task: () => void): void;
  /** Runs `task` after `ms`. */
  schedule?(task: () => void, ms: number): void;
}

const RETRY_FIRST_MS = 250;
const RETRY_MAX_MS = 5_000;
/** A refusal streak is logged at its start and once more about when the
 *  backoff reaches its cap. */
const LOG_REFUSAL_AGAIN_AT = 5;

interface RootInput {
  offer: QueueOffer;
  ids: string[];
  envelopes: Envelope[];
  text: string;
  conversationIds: string[];
  witnessed: boolean;
}

export class ClaudeQueueRoot {
  readonly #deps: QueueRootDeps;
  readonly #input: QueueInput;
  readonly #slot: CreditSlot;
  /** Token of a readiness check waiting for the link, before its request. */
  #checking: string | null = null;
  readonly #roots = new Map<string, RootInput>();
  /** The last root credit was withdrawn because another turn started. */
  #withdrawn = false;
  #retryScheduled = false;
  #retryDelay = RETRY_FIRST_MS;
  #refusals = 0;

  constructor(deps: QueueRootDeps) {
    this.#deps = deps;
    this.#input = deps.input;
    this.#slot = deps.slot;
  }

  /** Requests root credit when the host is ready for root input. */
  checkReadiness(): void {
    const lease = this.#deps.lease();
    if (lease === null || lease.frozen || this.#checking !== null || this.#slot.token("root") !== null) return;
    const token = randomUUID();
    this.#checking = token;
    this.#withdrawn = false;
    void this.#deps.ready().then(async () => {
      if (this.#checking !== token) return;
      this.#checking = null;
      // A held root re-arms at its exit.
      if (this.#roots.size > 0) return;
      if (!this.#deps.isIdle()) {
        this.#scheduleRetry();
        return;
      }
      const outcome = await this.#slot.request(lease, { kind: "root", token });
      if (outcome.kind === "refused") {
        this.#refusals += 1;
        if (this.#refusals === 1 || this.#refusals === LOG_REFUSAL_AGAIN_AT) {
          this.#deps.log(`[kaoiro] queue root credit refused (${this.#refusals} in a row): ${JSON.stringify(outcome.error)}\n`);
        }
        if (outcome.error.reason !== "queue_frozen") this.#scheduleRetry();
      } else if (outcome.kind === "granted") {
        this.#retryDelay = RETRY_FIRST_MS;
        this.#refusals = 0;
      }
    });
  }

  /** A turn started: the host is no longer idle and an outstanding root
   *  credit is withdrawn. */
  turnStarted(): void {
    const checking = this.#checking !== null;
    this.#checking = null;
    if (this.#slot.clear("root", this.#deps.lease()) || checking) this.#withdrawn = true;
  }

  #scheduleRetry(): void {
    if (this.#retryScheduled) return;
    this.#retryScheduled = true;
    const delay = this.#retryDelay;
    this.#retryDelay = Math.min(delay * 2, RETRY_MAX_MS);
    const schedule = this.#deps.schedule ?? ((task, ms) => { setTimeout(task, ms).unref?.(); });
    schedule(() => {
      this.#retryScheduled = false;
      this.checkReadiness();
    }, delay);
  }

  /** A join dropped any credit the server held for this link; the caller
   *  has reset the shared slot. */
  rejoined(): void {
    this.#checking = null;
    this.checkReadiness();
  }

  async onOffer(offer: QueueOffer): Promise<void> {
    try {
      await this.#onOffer(offer);
    } catch (error) {
      // An offer left unsettled would hold the ordinary lease slot.
      this.#deps.log(`[kaoiro] queue root offer failed; its items go back unsent: ${String(error)}\n`);
      offer.release(offer.items.map((item) => item.queueId));
    } finally {
      this.checkReadiness();
    }
  }

  async #onOffer(offer: QueueOffer): Promise<void> {
    const all = offer.items.map((item) => item.queueId);
    const token = this.#slot.token("root");
    if (offer.kind === "root" && token === null && this.#withdrawn) {
      // The offer crossed the withdrawal at another turn's start.
      this.#withdrawn = false;
      void offer.return(all.map((queue_id) => ({ queue_id, reason: "credit_withdrawn" as const })));
      return;
    }
    if (offer.kind !== "root" || token === null) {
      this.#deps.log(`[kaoiro] queue offer without a matching credit released: kind=${offer.kind} lease=${offer.leaseId}\n`);
      offer.release(all);
      return;
    }
    this.#slot.consume("root", token);
    if (!this.#deps.isIdle()) {
      // The offer crossed a withdrawal: return it before classifying.
      void offer.return(all.map((queue_id) => ({ queue_id, reason: "credit_withdrawn" as const })));
      return;
    }

    const prepared = await this.#input.prepare(offer);
    const injectIds = prepared.injected.map(({ item }) => item.queueId);
    const consumedIds = prepared.consumed.map((item) => item.queueId);
    const ids = [...injectIds, ...consumedIds];
    if (ids.length === 0) return;

    const submit = await offer.begin(ids, token);
    if (submit === null) {
      offer.release(ids);
      return;
    }
    // A root item classified now cannot be consumed: the host is idle. One
    // consumed under an earlier early offer whose permit was refused comes
    // back remembered, and its tool-result handoff is its witness.
    const handedOff = consumedIds.filter((id) => this.#input.handedOff(id));
    const unseen = consumedIds.filter((id) => !this.#input.handedOff(id));
    if (handedOff.length > 0) {
      void offer.dispose(handedOff.map((queue_id) => ({ queue_id, outcome: "observed" as const, witness: "tool_result" as const })))
        .then((result) => { if (result.ok) this.#input.forget(handedOff); });
    }
    if (unseen.length > 0) {
      this.#deps.log(`[kaoiro] invariant violation: a waiting tool consumed a queue root item: ${unseen.join(",")}\n`);
      void offer.dispose(unseen.map((queue_id) => ({ queue_id, outcome: "unknown" as const, reason: "consumed_outside_waiter" })))
        .then((result) => { if (result.ok) this.#input.forget(unseen); });
    }
    if (injectIds.length === 0) return;

    const envelopes = prepared.injected.map(({ item }) => item.envelope as Envelope);
    const root: RootInput = {
      offer,
      ids: injectIds,
      envelopes,
      text: prepared.text,
      conversationIds: [...new Set(envelopes.map((envelope) =>
        String((envelope.payload as Partial<InterAgentMessagePayload>).conversation_id ?? "")))],
      witnessed: false,
    };
    this.#roots.set(token, root);

    await this.#deps.enqueue(async () => {
      if (!this.#deps.isIdle()) {
        // Another turn got ahead while the permit was in flight; the text
        // was formatted for an idle host, so the items go back unsent.
        this.#roots.delete(token);
        offer.release(injectIds);
        return;
      }
      let sent: Promise<void> | undefined;
      const invoked = submit.invoke(() => {
        sent = this.#deps.send(root.text, root.conversationIds, token, root.envelopes);
      });
      if (!invoked) {
        this.#roots.delete(token);
        offer.release(injectIds);
        return;
      }
      try {
        await sent;
      } catch (error) {
        // host.send rejects only before queueing the turn (a closed host).
        this.#roots.delete(token);
        this.#deps.log(`[kaoiro] queue root input rejected by the host before start: ${String(error)}\n`);
        void offer.dispose(injectIds.map((queue_id) =>
          ({ queue_id, outcome: "definitely_unstarted" as const, reason: "host_rejected_before_start" })));
      }
    });
  }

  /** The host is about to start `turnToken`; a queue root returns its input. */
  prepareInput(turnToken: string): { text: string; conversationIds: string[] } | undefined {
    const root = this.#roots.get(turnToken);
    if (root === undefined) return undefined;
    this.#deps.preparePending(turnToken, root.envelopes);
    return { text: root.text, conversationIds: root.conversationIds };
  }

  /** The prompt hook admitted `turnToken`: the root input's witness. */
  promptAdmitted(turnToken: string): void {
    const root = this.#roots.get(turnToken);
    if (root === undefined || root.witnessed) return;
    root.witnessed = true;
    const ids = root.ids;
    void root.offer.dispose(ids.map((queue_id) => ({ queue_id, outcome: "observed" as const, witness: "prompt_hook" as const })))
      .then((result) => { if (result.ok) this.#input.forget(ids); });
  }

  /** A turn ended. For a queue root without a witness the input may or may
   *  not have reached the model (r9 S1). */
  turnEnded(turnToken: string | undefined, started: boolean): void {
    const root = turnToken === undefined ? undefined : this.#roots.get(turnToken);
    if (root !== undefined) {
      this.#roots.delete(turnToken!);
      if (!started) {
        void root.offer.dispose(root.ids.map((queue_id) =>
          ({ queue_id, outcome: "definitely_unstarted" as const, reason: "host_cancelled_before_start" })));
      } else if (!root.witnessed) {
        this.#deps.log(`[kaoiro] invariant violation: queue root turn ended without a prompt-hook witness: turn=${turnToken}\n`);
        void root.offer.dispose(root.ids.map((queue_id) =>
          ({ queue_id, outcome: "unknown" as const, reason: "root_turn_unwitnessed" })))
          .then((result) => { if (result.ok) this.#input.forget(root.ids); });
      }
    }
    (this.#deps.defer ?? ((task) => setImmediate(task)))(() => this.checkReadiness());
  }
}
