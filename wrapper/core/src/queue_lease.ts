// The wrapper's side of the server-owned inter-agent queue (`credit-v1`,
// docs/reference/protocol/channels.md). QueueLease owns the receipt
// identities and the typed outcomes; an engine only ever holds an offer's
// disposition capability. It keeps no backlog of bodies: what it holds is
// what the server offered and has not yet been disposed or returned.
//
// Per item: offered -> begin-requested -> permitted -> submitting ->
// disposing -> settled (or returning -> settled before submitting). The
// submit capability checks the local freeze, the epoch and the lease
// synchronously right before the host call, and is single-use; once the
// host was called, only a disposition can settle the item.
//
// A lease operation whose outcome is unknown (no answer, transport loss)
// is parked. While the link is up it is resent once under its own id; if
// that does not succeed, a `resume` reports the server's lease-scoped
// phases, and those decide it. QueueLease keeps a return or a disposition
// until the server has it, re-issuing it under a new id when the phases
// show it was not applied (channels.md, Idempotency; r8 §5.1).

import type {
  DeliveryBatchPush,
  DeliveryQueueControlError,
  DeliveryQueueControlReply,
  Envelope,
  InterAgentQueueDisposeItem,
  InterAgentQueueItemClass,
  InterAgentQueueItemPhase,
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
type LeaseOp = "begin_native" | "return" | "dispose";
type ServerPhase = InterAgentQueueItemPhase["phase"];

/** Sends one `delivery_queue_control` payload and resolves with the raw
 *  reply, or rejects with the raw error payload. */
export type QueueControlTransport = (payload: Record<string, unknown>) => Promise<unknown>;

export type QueueControlError = DeliveryQueueControlError | { reason: "transport"; detail: unknown };

export type QueueControlResult<Op extends ControlOp> =
  | { ok: true; reply: Reply<Op> }
  | { ok: false; error: QueueControlError };

/** How a return or disposition ended. `reply` is absent when the outcome
 *  was read from a `resume` reply rather than from the operation's own. */
export type QueueSettlement<Op extends "return" | "dispose"> =
  | { ok: true; reply?: Reply<Op> }
  | { ok: false; error: QueueControlError };

type ItemState =
  | "offered" | "begin_requested" | "permitted" | "submitting" | "returning" | "disposing" | "settled";

interface LeaseItem {
  queueId: string;
  deliverySeq: number;
  class: InterAgentQueueItemClass;
  envelope: Envelope;
  state: ItemState;
  /** The engine left the native turn while this item's `begin` was pending. */
  abandoned: boolean;
}

export interface QueueOfferItem {
  readonly queueId: string;
  readonly deliverySeq: number;
  readonly class: InterAgentQueueItemClass;
  readonly envelope: Envelope;
}

/** A single-use permission to submit the permitted items natively. */
export interface NativeSubmit {
  /** The native turn the permit is bound to. Invoke only inside that turn;
   *  an engine that has left it calls `QueueOffer.abandonBegin` instead. */
  readonly nativeTurnToken: string;
  /** Runs `submit` only if the items are still permitted under the same
   *  epoch and lease and the queue is not frozen; returns whether it ran. */
  invoke(submit: () => void): boolean;
}

export interface QueueOffer {
  readonly leaseId: string;
  readonly kind: DeliveryBatchPush["kind"];
  readonly items: readonly QueueOfferItem[];
  /** Asks the server to permit native submission of `queueIds`. Resolves
   *  `null` when the permit was not granted; may stay pending across a
   *  reconnect while the outcome is unknown. */
  begin(queueIds: readonly string[], nativeTurnToken: string): Promise<NativeSubmit | null>;
  /** The engine left the native turn before invoking the host. Permitted
   *  items, and items whose pending `begin` turns out permitted, are
   *  returned with `permit_unused`; a pending `begin` resolves `null`. */
  abandonBegin(queueIds: readonly string[]): void;
  /** Returns items whose host call was never invoked. QueueLease keeps the
   *  return until the server has it; the promise settles then. */
  return(items: readonly InterAgentQueueReturnItem[]): Promise<QueueSettlement<"return">>;
  /** Disposes items; kept until the server has it, like `return`. */
  dispose(items: readonly InterAgentQueueDisposeItem[]): Promise<QueueSettlement<"dispose">>;
}

export interface QueueLeaseOptions {
  transport: QueueControlTransport;
  onOffer: (offer: QueueOffer) => void;
  /** Receives an accepted batch's sequences before its offer, for the
   *  receipt ledger. */
  onSequences?: (seqs: readonly number[]) => void;
  /** Receives a line for a refusal that proves a wrapper bug. */
  log?: (line: string) => void;
}

interface Binding {
  epoch: string;
  incarnation: string;
  generation: string;
}

/** A lease operation's end: its own reply, a definitive refusal, the
 *  lease-scoped phases a `resume` reported, or a binding change. */
type LeaseOutcome<Op extends LeaseOp> =
  | { kind: "ok"; reply: Reply<Op> }
  | { kind: "refused"; error: QueueControlError }
  | { kind: "phases"; phases: ReadonlyMap<string, ServerPhase> }
  | { kind: "stale" };

interface Parked {
  op: LeaseOp;
  leaseId: string;
  payload: Record<string, unknown>;
  fastPath: boolean;
  finish: (outcome: LeaseOutcome<LeaseOp>) => void;
}

const BUG_REFUSALS = new Set(["invalid_queue_control", "operation_payload_mismatch", "conflicting_disposition"]);
const RETRY_FIRST_MS = 1_000;
const RETRY_MAX_MS = 30_000;

/** Whether a failed lease operation's outcome is unknown. A refused
 *  `begin_native` is final (the engine owns the retry); a return or
 *  disposition is final only on a refusal that proves a wrapper bug. */
function indeterminate(op: LeaseOp, error: QueueControlError): boolean {
  if (error.reason === "transport" || error.reason === "queue_unavailable" || error.reason.startsWith("stale_")) {
    return true;
  }
  return op !== "begin_native" && !BUG_REFUSALS.has(error.reason);
}

/** Whether the phase shows the item still in the lease, i.e. a return or
 *  disposition of it was not applied. */
function stillLeased(phase: ServerPhase | undefined): boolean {
  return phase === "offered" || phase === "native_pending";
}

export class QueueLease {
  readonly #transport: QueueControlTransport;
  readonly #onOffer: (offer: QueueOffer) => void;
  readonly #onSequences: (seqs: readonly number[]) => void;
  readonly #log: (line: string) => void;
  #binding: Binding | null = null;
  /** Bumped when the binding changes; outcomes from before are stale. */
  #bindingSerial = 0;
  #nextOperation = 1;
  #frozen = false;
  readonly #leases = new Map<string, Map<string, LeaseItem>>();
  readonly #parked = new Set<Parked>();
  #retryTimer: ReturnType<typeof setTimeout> | undefined;
  #retryDelay = RETRY_FIRST_MS;
  #reconciling: Promise<void> | null = null;

  constructor(options: QueueLeaseOptions) {
    this.#transport = options.transport;
    this.#onOffer = options.onOffer;
    this.#onSequences = options.onSequences ?? (() => {});
    this.#log = options.log ?? (() => {});
  }

  get frozen(): boolean {
    return this.#frozen;
  }

  /** Binds to a join. A new epoch, incarnation or generation drops every
   *  local lease and ends parked operations: the server already resolved
   *  them; the next offers come with new ids. */
  join(reply: InterAgentQueueJoinReply, incarnation: string, generation: string): void {
    const binding = { epoch: reply.inter_agent_queue_epoch, incarnation, generation };
    const previous = this.#binding;
    if (
      previous === null || previous.epoch !== binding.epoch ||
      previous.generation !== binding.generation || previous.incarnation !== binding.incarnation
    ) {
      this.#bindingSerial++;
      this.#leases.clear();
      this.#endParked({ kind: "stale" });
      if (previous?.generation !== binding.generation) this.#nextOperation = 1;
    }
    this.#binding = binding;
  }

  /** After a join: reconciles through `resume` when the server requires it
   *  or anything is still held locally. Resolves when that attempt ends;
   *  credit should wait for it. */
  rejoined(resumeRequired: boolean): Promise<void> {
    if (!resumeRequired && this.#leases.size === 0 && this.#parked.size === 0) return Promise.resolve();
    return this.#reconcile();
  }

  /** Lease ids still held locally, for `resume` after a same-generation rejoin. */
  heldLeaseIds(): string[] {
    return [...this.#leases.keys()];
  }

  /** Each held lease with the queue ids it was offered, for `resume`. */
  heldLeases(): { lease_id: string; queue_ids: string[] }[] {
    return [...this.#leases].map(([leaseId, items]) => ({ lease_id: leaseId, queue_ids: [...items.keys()] }));
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
        abandoned: false,
      });
    }
    this.#leases.set(push.lease_id, items);
    this.#onSequences(push.items.map((item) => item.delivery_seq));
    this.#onOffer(this.#offer(push.lease_id, push.kind, items));
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
      leases: this.heldLeases(),
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

  #offer(leaseId: string, kind: DeliveryBatchPush["kind"], items: Map<string, LeaseItem>): QueueOffer {
    const current = (): boolean => this.#leases.get(leaseId) === items;

    return {
      leaseId,
      kind,
      items: [...items.values()].map(({ queueId, deliverySeq, class: itemClass, envelope }) =>
        ({ queueId, deliverySeq, class: itemClass, envelope })),
      begin: async (queueIds, nativeTurnToken) => {
        const targets = queueIds.map((id) => items.get(id));
        if (this.#frozen || !current() || targets.some((item) => item?.state !== "offered")) return null;
        for (const item of targets) {
          item!.state = "begin_requested";
          item!.abandoned = false;
        }

        const outcome = await this.#leaseOp("begin_native", {
          op: "begin_native",
          lease_id: leaseId,
          queue_ids: [...queueIds],
          native_turn_token: nativeTurnToken,
        });

        if (outcome.kind === "phases") {
          const gone = queueIds.filter((id) => !stillLeased(outcome.phases.get(id)));
          this.#settle(leaseId, items, gone);
        }
        const granted = outcome.kind === "ok" ||
          (outcome.kind === "phases" && queueIds.every((id) => outcome.phases.get(id) === "native_pending"));
        // A return or a freeze while the permit was in flight wins.
        const stillWanted = targets.every((item) => item!.state === "begin_requested");
        if (!granted || !stillWanted || !current()) {
          for (const item of targets) if (item!.state === "begin_requested") item!.state = "offered";
          return null;
        }
        if (targets.some((item) => item!.abandoned)) {
          for (const item of targets) item!.state = "returning";
          void this.#settleOp("return", leaseId, items,
            queueIds.map((id) => ({ queue_id: id, reason: "permit_unused" as const })));
          return null;
        }
        for (const item of targets) item!.state = "permitted";

        // Single use: the first invoke moves the items out of `permitted`.
        return {
          nativeTurnToken,
          invoke: (submit) => {
            if (this.#frozen || !current() || targets.some((item) => item!.state !== "permitted")) return false;
            for (const item of targets) item!.state = "submitting";
            submit();
            return true;
          },
        };
      },
      abandonBegin: (queueIds) => {
        const permitted: string[] = [];
        for (const id of queueIds) {
          const item = items.get(id);
          if (item?.state === "begin_requested") item.abandoned = true;
          if (item?.state === "permitted") {
            item.state = "returning";
            permitted.push(id);
          }
        }
        if (permitted.length > 0 && current()) {
          void this.#settleOp("return", leaseId, items,
            permitted.map((id) => ({ queue_id: id, reason: "permit_unused" as const })));
        }
      },
      return: async (entries) => {
        const targets = entries.map((entry) => items.get(entry.queue_id));
        // After the host call only a disposition can settle an item.
        if (
          !current() ||
          targets.some((item) => item === undefined || !["offered", "begin_requested", "permitted"].includes(item.state))
        ) {
          return { ok: false, error: { reason: "unknown_queue_item" } };
        }
        for (const item of targets) item!.state = "returning";
        return this.#settleOp("return", leaseId, items, entries);
      },
      dispose: async (entries) => {
        const targets = entries.map((entry) => items.get(entry.queue_id));
        if (
          !current() ||
          targets.some((item) => item === undefined || ["returning", "disposing", "settled"].includes(item.state))
        ) {
          return { ok: false, error: { reason: "unknown_queue_item" } };
        }
        for (const item of targets) item!.state = "disposing";
        return this.#settleOp("dispose", leaseId, items, entries);
      },
    };
  }

  #settle(leaseId: string, items: Map<string, LeaseItem>, queueIds: readonly string[]): void {
    for (const id of queueIds) {
      const item = items.get(id);
      if (item !== undefined) item.state = "settled";
    }
    if (this.#leases.get(leaseId) === items && [...items.values()].every((item) => item.state === "settled")) {
      this.#leases.delete(leaseId);
    }
  }

  /** Drives a return or disposition until the server has it. */
  async #settleOp<Op extends "return" | "dispose">(
    op: Op,
    leaseId: string,
    items: Map<string, LeaseItem>,
    entries: readonly (Op extends "return" ? InterAgentQueueReturnItem : InterAgentQueueDisposeItem)[],
  ): Promise<QueueSettlement<Op>> {
    let pending = [...entries];
    for (;;) {
      const outcome = await this.#leaseOp(op, { op, lease_id: leaseId, items: pending }) as LeaseOutcome<Op>;
      if (outcome.kind === "ok") {
        this.#settle(leaseId, items, pending.map((entry) => entry.queue_id));
        return { ok: true, reply: outcome.reply };
      }
      if (outcome.kind === "stale") return { ok: false, error: { reason: "stale_channel" } };
      if (outcome.kind === "refused") {
        // A wrapper bug: left visible, not restored (the engine moved on).
        this.#log(`QueueLease ${op} refused: ${JSON.stringify(outcome.error)} lease=${leaseId}`);
        return { ok: false, error: outcome.error };
      }
      const applied = pending.filter((entry) => !stillLeased(outcome.phases.get(entry.queue_id)));
      this.#settle(leaseId, items, applied.map((entry) => entry.queue_id));
      pending = pending.filter((entry) => stillLeased(outcome.phases.get(entry.queue_id)));
      if (pending.length === 0) return { ok: true };
      this.#log(`QueueLease ${op} not applied; re-issuing lease=${leaseId} items=${pending.length}`);
    }
  }

  /** Sends a lease operation; parks it when its outcome is unknown. */
  async #leaseOp<Op extends LeaseOp>(op: Op, body: Record<string, unknown>): Promise<LeaseOutcome<Op>> {
    const binding = this.#binding;
    if (binding === null) return { kind: "stale" };
    const serial = this.#bindingSerial;
    const payload = this.#payload(binding, body);
    const result = await this.#send(op, payload);
    if (serial !== this.#bindingSerial) return { kind: "stale" };
    if (result.ok) return { kind: "ok", reply: result.reply };
    if (!indeterminate(op, result.error)) return { kind: "refused", error: result.error };
    return new Promise((resolve) => {
      this.#parked.add({
        op,
        leaseId: String(body.lease_id),
        payload,
        fastPath: true,
        finish: resolve as (outcome: LeaseOutcome<LeaseOp>) => void,
      });
      this.#scheduleRetry();
    });
  }

  #endParked(outcome: LeaseOutcome<LeaseOp>): void {
    clearTimeout(this.#retryTimer);
    this.#retryTimer = undefined;
    this.#retryDelay = RETRY_FIRST_MS;
    const parked = [...this.#parked];
    this.#parked.clear();
    for (const entry of parked) entry.finish(outcome);
  }

  #scheduleRetry(): void {
    if (this.#retryTimer !== undefined) return;
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = undefined;
      void this.#retry();
    }, this.#retryDelay);
    this.#retryTimer.unref?.();
    this.#retryDelay = Math.min(this.#retryDelay * 2, RETRY_MAX_MS);
  }

  /** Fast path first (the same id, once), then a reconciliation. */
  async #retry(): Promise<void> {
    if (this.#reconciling !== null) return;
    const serial = this.#bindingSerial;
    for (const parked of [...this.#parked].filter((entry) => entry.fastPath)) {
      parked.fastPath = false;
      const result = await this.#send(parked.op, parked.payload);
      if (serial !== this.#bindingSerial) return;
      if (result.ok && this.#parked.delete(parked)) parked.finish({ kind: "ok", reply: result.reply });
    }
    if (this.#parked.size > 0) await this.#reconcile();
    else this.#retryDelay = RETRY_FIRST_MS;
  }

  #reconcile(): Promise<void> {
    this.#reconciling ??= this.#runReconcile().finally(() => {
      this.#reconciling = null;
    });
    return this.#reconciling;
  }

  async #runReconcile(): Promise<void> {
    clearTimeout(this.#retryTimer);
    this.#retryTimer = undefined;
    const serial = this.#bindingSerial;
    // Only operations sent before the resume can be read from its phases.
    const covered = [...this.#parked];
    const result = await this.resume();
    if (serial !== this.#bindingSerial) return;
    if (!result.ok) {
      if (this.#parked.size > 0) this.#scheduleRetry();
      return;
    }
    this.#retryDelay = RETRY_FIRST_MS;
    const phases = new Map(result.reply.leases.map((lease) =>
      [lease.lease_id, new Map(lease.items.map((item) => [item.queue_id, item.phase]))]));
    for (const parked of covered) {
      if (!this.#parked.delete(parked)) continue;
      parked.finish({ kind: "phases", phases: phases.get(parked.leaseId) ?? new Map() });
    }
    if (this.#parked.size > 0) this.#scheduleRetry();
  }

  #payload(binding: Binding, body: Record<string, unknown>): Record<string, unknown> {
    return {
      version: "0",
      operation_id: String(this.#nextOperation++),
      queue_epoch: binding.epoch,
      incarnation: binding.incarnation,
      generation: binding.generation,
      ...body,
    };
  }

  async #control<Op extends ControlOp>(op: Op, body: Record<string, unknown>): Promise<QueueControlResult<Op>> {
    const binding = this.#binding;
    if (binding === null) return { ok: false, error: { reason: "stale_channel" } };
    return this.#send(op, this.#payload(binding, body));
  }

  async #send<Op extends ControlOp>(op: Op, payload: Record<string, unknown>): Promise<QueueControlResult<Op>> {
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
