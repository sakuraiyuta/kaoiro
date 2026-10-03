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

import { randomUUID } from "node:crypto";
import type { QueueLease, QueueOffer } from "@kaoiro/wrapper-core";
import { QueueInput, type QueueInputDeps } from "@kaoiro/agent-common";
import type { Envelope, InterAgentMessagePayload } from "@kaoiro/agent-common";

export interface QueueRootDeps extends QueueInputDeps {
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
}

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
  /** Token of the outstanding root credit, if any. */
  #creditToken: string | null = null;
  #creditRevision: string | null = null;
  readonly #roots = new Map<string, RootInput>();

  constructor(deps: QueueRootDeps) {
    this.#deps = deps;
    this.#input = new QueueInput(deps);
  }

  /** Requests root credit when the host is ready for root input. */
  checkReadiness(): void {
    const lease = this.#deps.lease();
    if (lease === null || lease.frozen || this.#creditToken !== null) return;
    const token = randomUUID();
    this.#creditToken = token;
    this.#creditRevision = null;
    void this.#deps.ready().then(async () => {
      if (this.#creditToken !== token) return;
      if (!this.#deps.isIdle() || this.#roots.size > 0) {
        this.#creditToken = null;
        return;
      }
      const result = await lease.credit("root", token);
      if (!result.ok) {
        if (this.#creditToken !== token) return;
        this.#creditToken = null;
        this.#deps.log(`[kaoiro] queue root credit refused: ${JSON.stringify(result.error)}\n`);
      } else if (this.#creditToken === token) {
        this.#creditRevision = result.reply.credit_revision;
      } else {
        // The host left idle while the credit was in flight.
        void lease.withdraw(result.reply.credit_revision);
      }
    });
  }

  /** A turn started. Unless it is a queue root, the host is no longer idle
   *  and an outstanding root credit is withdrawn. */
  turnStarted(turnToken: string): void {
    if (this.#roots.has(turnToken) || this.#creditToken === null) return;
    const revision = this.#creditRevision;
    this.#creditToken = null;
    this.#creditRevision = null;
    if (revision !== null) void this.#deps.lease()?.withdraw(revision);
  }

  /** A join dropped any credit the server held for this link. */
  rejoined(): void {
    this.#creditToken = null;
    this.checkReadiness();
  }

  async onOffer(offer: QueueOffer): Promise<void> {
    const all = offer.items.map((item) => item.queueId);
    const token = this.#creditToken;
    if (offer.kind !== "root" || token === null) {
      this.#deps.log(`[kaoiro] queue offer without a matching credit released: kind=${offer.kind} lease=${offer.leaseId}\n`);
      offer.release(all);
      return;
    }
    this.#creditToken = null;
    this.#creditRevision = null;
    if (!this.#deps.isIdle()) {
      // The offer crossed a withdrawal: return it before classifying.
      void offer.return(all.map((queue_id) => ({ queue_id, reason: "credit_withdrawn" as const })));
      return;
    }

    const prepared = await this.#input.prepare(offer);
    const injectIds = prepared.injected.map(({ item }) => item.queueId);
    const consumedIds = prepared.consumed.map((item) => item.queueId);
    const ids = [...injectIds, ...consumedIds];
    if (ids.length === 0) {
      this.checkReadiness();
      return;
    }

    const submit = await offer.begin(ids, token);
    if (submit === null) {
      offer.release(ids);
      this.checkReadiness();
      return;
    }
    if (consumedIds.length > 0) {
      // Classified while idle, so no waiting tool could have taken it.
      this.#deps.log(`[kaoiro] invariant violation: a waiting tool consumed a queue root item: ${consumedIds.join(",")}\n`);
      void offer.dispose(consumedIds.map((queue_id) => ({ queue_id, outcome: "unknown" as const, reason: "consumed_outside_waiter" })))
        .then((result) => { if (result.ok) this.#input.forget(consumedIds); });
    }
    if (injectIds.length === 0) {
      this.checkReadiness();
      return;
    }

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
