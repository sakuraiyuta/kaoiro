// The wrapper's side of the server-owned inter-agent queue (`credit-v1`,
// docs/reference/protocol/channels.md). QueueLease owns the receipt
// identities and the typed outcomes; an engine only ever holds an offer's
// disposition capability. It keeps no backlog of bodies: what it holds is
// what the server offered and has not yet been disposed or returned.
//
// Per item: offered -> begin-requested -> permitted -> submitting ->
// disposed (or returned before submitting). The submit capability checks
// the local freeze, the epoch and the lease synchronously right before the
// host call, and is single-use; once the host was called, only a
// disposition can settle the item.

import type {
  DeliveryBatchPush,
  DeliveryQueueControlError,
  DeliveryQueueControlReply,
  Envelope,
  InterAgentQueueDisposeItem,
  InterAgentQueueItemClass,
  InterAgentQueueJoinReply,
  InterAgentQueueReturnItem,
} from "@kaoiro/protocol";
import {
  parseDeliveryBatchPush,
  parseDeliveryQueueControlError,
  parseDeliveryQueueControlReply,
} from "./inter_agent_queue_codec.js";

type ControlOp = DeliveryQueueControlReply["op"];
type Reply<Op extends ControlOp> = Extract<DeliveryQueueControlReply, { op: Op }>;

/** Sends one `delivery_queue_control` payload and resolves with the raw
 *  reply, or rejects with the raw error payload. */
export type QueueControlTransport = (payload: Record<string, unknown>) => Promise<unknown>;

export type QueueControlResult<Op extends ControlOp> =
  | { ok: true; reply: Reply<Op> }
  | { ok: false; error: DeliveryQueueControlError | { reason: "transport"; detail: unknown } };

type ItemState = "offered" | "begin_requested" | "permitted" | "submitting" | "settled";

interface LeaseItem {
  queueId: string;
  deliverySeq: number;
  class: InterAgentQueueItemClass;
  envelope: Envelope;
  state: ItemState;
}

export interface QueueOfferItem {
  readonly queueId: string;
  readonly deliverySeq: number;
  readonly class: InterAgentQueueItemClass;
  readonly envelope: Envelope;
}

/** A single-use permission to submit the permitted items natively. */
export interface NativeSubmit {
  /** Runs `submit` only if the items are still permitted under the same
   *  epoch and lease and the queue is not frozen; returns whether it ran. */
  invoke(submit: () => void): boolean;
}

export interface QueueOffer {
  readonly leaseId: string;
  readonly kind: DeliveryBatchPush["kind"];
  readonly items: readonly QueueOfferItem[];
  /** Asks the server to permit native submission of `queueIds`. */
  begin(queueIds: readonly string[], nativeTurnToken: string): Promise<NativeSubmit | null>;
  /** Returns items whose host call was never invoked. */
  return(items: readonly InterAgentQueueReturnItem[]): Promise<QueueControlResult<"return">>;
  dispose(items: readonly InterAgentQueueDisposeItem[]): Promise<QueueControlResult<"dispose">>;
}

export interface QueueLeaseOptions {
  transport: QueueControlTransport;
  onOffer: (offer: QueueOffer) => void;
}

interface Binding {
  epoch: string;
  incarnation: string;
  generation: string;
}

export class QueueLease {
  readonly #transport: QueueControlTransport;
  readonly #onOffer: (offer: QueueOffer) => void;
  #binding: Binding | null = null;
  #nextOperation = 1;
  #frozen = false;
  readonly #leases = new Map<string, Map<string, LeaseItem>>();

  constructor(options: QueueLeaseOptions) {
    this.#transport = options.transport;
    this.#onOffer = options.onOffer;
  }

  get frozen(): boolean {
    return this.#frozen;
  }

  /** Binds to a join. A new epoch or generation drops every local lease: the
   *  server already resolved them; the next offers come with new ids. */
  join(reply: InterAgentQueueJoinReply, incarnation: string, generation: string): void {
    const binding = { epoch: reply.inter_agent_queue_epoch, incarnation, generation };
    const previous = this.#binding;
    if (
      previous === null || previous.epoch !== binding.epoch ||
      previous.generation !== binding.generation || previous.incarnation !== binding.incarnation
    ) {
      this.#leases.clear();
      if (previous?.generation !== binding.generation) this.#nextOperation = 1;
    }
    this.#binding = binding;
  }

  /** Lease ids still held locally, for `resume` after a same-generation rejoin. */
  heldLeaseIds(): string[] {
    return [...this.#leases.keys()];
  }

  /** Accepts a `delivery_batch` push; anything malformed or for another
   *  binding is ignored. Returns whether it was accepted. */
  receiveBatch(raw: unknown): boolean {
    const push = parseDeliveryBatchPush(raw);
    const binding = this.#binding;
    if (
      push === undefined || binding === null || this.#frozen ||
      push.queue_epoch !== binding.epoch || push.incarnation !== binding.incarnation ||
      push.generation !== binding.generation || this.#leases.has(push.lease_id)
    ) return false;

    const items = new Map<string, LeaseItem>();
    for (const item of push.items) {
      items.set(item.queue_id, {
        queueId: item.queue_id,
        deliverySeq: item.delivery_seq,
        class: item.class,
        envelope: item.envelope,
        state: "offered",
      });
    }
    this.#leases.set(push.lease_id, items);
    this.#onOffer(this.#offer(push.lease_id, push.kind, binding, items));
    return true;
  }

  credit(kind: "root", nativeTurnToken: string): Promise<QueueControlResult<"credit">>;
  credit(kind: "early", nativeTurnToken: string, mechanism: "fold" | "steer"): Promise<QueueControlResult<"credit">>;
  credit(kind: "root" | "early", nativeTurnToken: string, mechanism?: "fold" | "steer"): Promise<QueueControlResult<"credit">> {
    if (this.#frozen) return Promise.resolve({ ok: false, error: { reason: "queue_frozen" } });
    return this.#control("credit", {
      op: "credit",
      kind,
      native_turn_token: nativeTurnToken,
      ...(mechanism === undefined ? {} : { mechanism }),
    });
  }

  withdraw(creditRevision: string): Promise<QueueControlResult<"withdraw">> {
    return this.#control("withdraw", { op: "withdraw", credit_revision: creditRevision });
  }

  resume(registrationIds: readonly string[] = []): Promise<QueueControlResult<"resume">> {
    return this.#control("resume", {
      op: "resume",
      lease_ids: this.heldLeaseIds(),
      registration_ids: [...registrationIds],
    });
  }

  waiterClose(registrationId: string): Promise<QueueControlResult<"waiter_close">> {
    return this.#control("waiter_close", { op: "waiter_close", registration_id: registrationId });
  }

  /** Freezes locally and synchronously, then tells the server; the local
   *  freeze holds even if the reply is lost. */
  freeze(reason: "shutdown" | "session_reset"): Promise<QueueControlResult<"freeze">> {
    this.#frozen = true;
    return this.#control("freeze", { op: "freeze", reason });
  }

  #offer(leaseId: string, kind: DeliveryBatchPush["kind"], binding: Binding, items: Map<string, LeaseItem>): QueueOffer {
    const current = (): boolean => this.#binding === binding && this.#leases.get(leaseId) === items;
    const settle = (queueIds: readonly string[]): void => {
      for (const id of queueIds) {
        const item = items.get(id);
        if (item !== undefined) item.state = "settled";
      }
      if ([...items.values()].every((item) => item.state === "settled")) this.#leases.delete(leaseId);
    };

    return {
      leaseId,
      kind,
      items: [...items.values()].map(({ queueId, deliverySeq, class: itemClass, envelope }) =>
        ({ queueId, deliverySeq, class: itemClass, envelope })),
      begin: async (queueIds, nativeTurnToken) => {
        const targets = queueIds.map((id) => items.get(id));
        if (this.#frozen || !current() || targets.some((item) => item?.state !== "offered")) return null;
        for (const item of targets) item!.state = "begin_requested";

        const result = await this.#control("begin_native", {
          op: "begin_native",
          lease_id: leaseId,
          queue_ids: [...queueIds],
          native_turn_token: nativeTurnToken,
        });

        // A return or a freeze while the permit was in flight wins.
        const stillWanted = targets.every((item) => item!.state === "begin_requested");
        if (!result.ok || !stillWanted || !current()) {
          for (const item of targets) if (item!.state === "begin_requested") item!.state = "offered";
          return null;
        }
        for (const item of targets) item!.state = "permitted";

        let used = false;
        return {
          invoke: (submit) => {
            if (used || this.#frozen || !current() || targets.some((item) => item!.state !== "permitted")) return false;
            used = true;
            for (const item of targets) item!.state = "submitting";
            submit();
            return true;
          },
        };
      },
      return: async (entries) => {
        const ids = entries.map((entry) => entry.queue_id);
        const targets = ids.map((id) => items.get(id));
        // After the host call only a disposition can settle an item.
        if (!current() || targets.some((item) => item === undefined || item.state === "submitting" || item.state === "settled")) {
          return { ok: false, error: { reason: "unknown_queue_item" } };
        }
        for (const item of targets) item!.state = "settled";
        const result = await this.#control("return", { op: "return", lease_id: leaseId, items: [...entries] });
        settle(ids);
        return result;
      },
      dispose: async (entries) => {
        const ids = entries.map((entry) => entry.queue_id);
        if (!current() || ids.some((id) => items.get(id) === undefined || items.get(id)!.state === "settled")) {
          return { ok: false, error: { reason: "unknown_queue_item" } };
        }
        const result = await this.#control("dispose", { op: "dispose", lease_id: leaseId, items: [...entries] });
        if (result.ok) settle(ids);
        return result;
      },
    };
  }

  async #control<Op extends ControlOp>(op: Op, body: Record<string, unknown>): Promise<QueueControlResult<Op>> {
    const binding = this.#binding;
    if (binding === null) return { ok: false, error: { reason: "stale_channel" } };
    const payload = {
      version: "0",
      operation_id: String(this.#nextOperation++),
      queue_epoch: binding.epoch,
      incarnation: binding.incarnation,
      generation: binding.generation,
      ...body,
    };
    try {
      const raw = await this.#transport(payload);
      const reply = parseDeliveryQueueControlReply(raw, op);
      return reply === undefined
        ? { ok: false, error: { reason: "transport", detail: "malformed reply" } }
        : { ok: true, reply };
    } catch (raw) {
      const error = parseDeliveryQueueControlError(raw);
      return { ok: false, error: error ?? { reason: "transport", detail: raw } };
    }
  }
}
