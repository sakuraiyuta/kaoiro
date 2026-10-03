// Claude's root path for the server-owned inter-agent queue (credit-v1;
// docs/reference/protocol/channels.md, r8 §5.3 and §6.4, r9 S1).
//
// At readiness (no SDK turn running or queued, no IA root batch held) it
// asks for root credit under a fresh native turn token T. The offer is
// prepared by QueueInput, permitted with `begin_native` under T and sent to
// the host as turn T. The prompt hook for T is the witness. Settlement goes
// only through QueueLease dispositions, never through the cumulative
// delivery acknowledgement.

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
  readonly #roots = new Map<string, RootInput>();
  /** Root items a waiting tool consumed, until their tool-result handoff. */
  readonly #consumed = new Map<Envelope, { offer: QueueOffer; queueId: string }>();

  constructor(deps: QueueRootDeps) {
    this.#deps = deps;
    this.#input = new QueueInput(deps);
  }

  /** Requests root credit when the host is ready for root input. */
  checkReadiness(): void {
    const lease = this.#deps.lease();
    if (lease === null || lease.frozen || this.#creditToken !== null || this.#roots.size > 0) return;
    if (!this.#deps.isIdle()) return;
    // No turn runs, so a consumed reply's waiting tool has returned or
    // never will: one still not handed off is unknown.
    for (const [envelope, { offer, queueId }] of this.#consumed) {
      this.#consumed.delete(envelope);
      this.#deps.log(`[kaoiro] queue item consumed by a waiting tool was never handed off: queue_id=${queueId}\n`);
      void offer.dispose([{ queue_id: queueId, outcome: "unknown", reason: "waiter_result_not_observed" }]);
    }
    const token = randomUUID();
    this.#creditToken = token;
    void this.#deps.ready().then(async () => {
      if (this.#creditToken !== token) return;
      if (!this.#deps.isIdle() || this.#roots.size > 0) {
        this.#creditToken = null;
        return;
      }
      const result = await lease.credit("root", token);
      if (!result.ok && this.#creditToken === token) {
        this.#creditToken = null;
        this.#deps.log(`[kaoiro] queue root credit refused: ${JSON.stringify(result.error)}\n`);
      }
    });
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

    const prepared = await this.#input.prepare(offer);
    const injectIds = prepared.injected.map(({ item }) => item.queueId);
    const consumed = prepared.consumed;
    const ids = [...injectIds, ...consumed.map((item) => item.queueId)];
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
    for (const item of consumed) this.#consumed.set(item.envelope as Envelope, { offer, queueId: item.queueId });
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
          ({ queue_id, outcome: "unknown" as const, reason: "root_turn_unwitnessed" })));
      }
    }
    (this.#deps.defer ?? ((task) => setImmediate(task)))(() => this.checkReadiness());
  }

  /** A waiting tool returned these envelopes as its result. */
  inputHandoff(envelopes: readonly Envelope[]): void {
    for (const envelope of envelopes) {
      const consumed = this.#consumed.get(envelope);
      if (consumed === undefined) continue;
      this.#consumed.delete(envelope);
      void consumed.offer.dispose([{ queue_id: consumed.queueId, outcome: "observed", witness: "tool_result" }])
        .then((result) => { if (result.ok) this.#input.forget([consumed.queueId]); });
    }
  }
}
