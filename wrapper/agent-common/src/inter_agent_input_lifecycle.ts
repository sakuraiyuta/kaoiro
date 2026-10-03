import type { Envelope } from "./types.js";
import { bindToolResultHandoff } from "./reply_basis.js";
import {
  DEFAULT_INTER_AGENT_BACKLOG_MAX_ITEMS,
  InterAgentAdmission,
} from "./inter_agent_admission.js";
import type {
  InterAgentAdmissionCounts,
  InterAgentAdmissionReservation,
  InterAgentDeliveryIdentity,
  InterAgentReleaseReason,
  InterAgentReservationClass,
} from "./inter_agent_admission.js";
import type { InterAgentNoticeOutcome, InterAgentRetirementCapability } from "./inter_agent_overload.js";

export type InputHandle = InterAgentAdmissionReservation;

export type InputWitness =
  | {
      kind: "observed";
      boundary:
        | "prompt_hook"
        | "fold_hook"
        | "turn_start_accepted"
        | "exec_input_written"
        | "turn_steer_corroborated"
        | "antigravity_input_written"
        | "tool_result";
      ownerToken: string;
    }
  | { kind: "inline"; reason: "terminal_skip" | "stale_skip" }
  | { kind: "abandoned"; reason: string }
  | { kind: "uncertain"; reason: string; ack: "existing_boundary" | "hold" | "already_observed" };

export type AdmissionClassification =
  | { kind: "ordinary" }
  | { kind: "waiter"; lossId?: string }
  | { kind: "loss"; lossId: string }
  | { kind: "fallback" };

export interface IngressLease {
  readonly id: number;
  readonly envelope: Envelope;
}

export interface PendingInput {
  readonly handle: InputHandle;
  readonly envelope: Envelope;
  readonly reservationClass: InterAgentReservationClass;
  readonly deliveryIdentity?: InterAgentDeliveryIdentity;
  readonly lossId?: string;
}

export type AdmissionResult =
  | { kind: "reserved"; handle: InputHandle }
  | { kind: "duplicate_loss" }
  | { kind: "refused"; lossId?: string; retirementAttemptCount?: number; controlReservationCount?: number }
  | { kind: "closed" };

export type CompletionResult =
  | { kind: "completed"; witness: InputWitness["kind"] }
  | { kind: "already_finished" }
  | { kind: "recovered_invariant_violation"; pendingHandles: number; token: string };

export type BatchDisposition =
  | { kind: "already_observed"; ownerToken: string }
  | Extract<InputWitness, { kind: "abandoned" | "uncertain" }>;

export interface OverloadDisposition {
  notice?: Envelope;
  lossId?: string;
  retirementAttemptCount?: number;
}

export interface ResultInputEntry {
  readonly envelope: Envelope;
  readonly handle?: InputHandle;
}

export interface ResultInputLease {
  readonly entries: readonly ResultInputEntry[];
  readonly ownerToken: string;
  live(): boolean;
  /** Moves the same handles between engine-owned containers; it never ends them. */
  returnToInput(): boolean;
  /** Performs optional adapter-side bookkeeping after the result was committed. */
  commitContainerTransfer(): void;
}

export interface InputLifecycleOptions {
  maxPendingItems?: number;
  /** Injection is only for unit tests. The runtime takes exclusive ownership. */
  admission?: InterAgentAdmission;
  currentIdentity?: () => { incarnation: string; generation: string } | null;
  captureDelivery?: (envelope: Envelope) => void;
  captureStage?: (envelope: Envelope) => void;
  acknowledgeDelivery?: (envelope: Envelope) => void;
  retirementCapability?: () => InterAgentRetirementCapability;
  retireDelivery?: (envelope: Envelope) => boolean;
  sendNotice?: (envelope: Envelope, signal?: AbortSignal) => Promise<InterAgentNoticeOutcome>;
  settleStage?: (envelope: Envelope, reason: "terminal_skip" | "stale_skip" | "receiver_overloaded") => void;
  observeInput?: (envelope: Envelope, witness: Extract<InputWitness, { kind: "observed" }>) => void;
  unknownInput?: (envelope: Envelope, reason: string) => void;
  log?: (line: string) => void;
  onInvariantViolation?: (event: Readonly<Record<string, unknown>>) => void;
}

export type InterAgentInputLifecyclePort = Pick<
  InterAgentInputLifecycle,
  | "admissionCounts"
  | "pendingCount"
  | "invariantViolationCount"
  | "beginIngress"
  | "ingressOpen"
  | "finishIngress"
  | "reserve"
  | "reserveDirect"
  | "owns"
  | "reservationFor"
  | "deliveryIdentityFor"
  | "isLossDuplicate"
  | "lossDisposition"
  | "pending"
  | "finish"
  | "finishInline"
  | "abandonIngress"
  | "refuse"
  | "completeBatch"
  | "bindResult"
  | "close"
  | "stopRetirementRequests"
>;

interface IngressState {
  readonly envelope: Envelope;
  readonly identity?: InterAgentDeliveryIdentity;
  readonly epoch: number;
  handle?: InputHandle;
  finished: boolean;
}

interface CompletionClaim {
  readonly result: CompletionResult;
}

interface RefusalExecutor {
  readonly envelope: Envelope;
  readonly identity?: InterAgentDeliveryIdentity;
  readonly rejection: OverloadDisposition;
  readonly controller: AbortController;
  readonly resolve: (result: CompletionResult) => void;
  finalized: boolean;
}

/**
 * The only product owner of the pending-input arithmetic. Engine queues may
 * carry opaque handles, while this runtime owns their release and transport
 * disposition. Its public surface contains no arithmetic release operation.
 */
export class InterAgentInputLifecycle {
  readonly #admission: InterAgentAdmission;
  readonly #options: InputLifecycleOptions;
  readonly #ingress = new WeakMap<IngressLease, IngressState>();
  readonly #activeIngress = new Set<IngressLease>();
  readonly #claims = new WeakMap<InputHandle, CompletionClaim>();
  readonly #finishedReceipts = new WeakSet<Envelope>();
  readonly #refusalExecutors = new WeakMap<Envelope, Promise<CompletionResult>>();
  readonly #executors = new Set<Promise<CompletionResult>>();
  readonly #activeRefusals = new Set<RefusalExecutor>();
  readonly #closeWaiters = new Set<() => void>();
  #nextIngressId = 0;
  #epoch = 0;
  #closed = false;
  #retirementRequestsClosed = false;
  #closePromise: Promise<void> | undefined;
  #finalClosePromise: Promise<void> | undefined;
  readonly #preservedHandles = new Set<InputHandle>();
  #invariantViolations = 0;

  constructor(options: InputLifecycleOptions = {}) {
    this.#options = options;
    this.#admission = options.admission ?? new InterAgentAdmission(
      options.maxPendingItems ?? DEFAULT_INTER_AGENT_BACKLOG_MAX_ITEMS,
    );
  }

  get admissionCounts(): InterAgentAdmissionCounts {
    return this.#admission.counts();
  }

  get pendingCount(): number {
    return this.#admission.counts().total;
  }

  get invariantViolationCount(): number {
    return this.#invariantViolations;
  }

  beginIngress(envelope: Envelope): IngressLease {
    this.#options.captureDelivery?.(envelope);
    this.#options.captureStage?.(envelope);
    const transportIdentity = this.#safeCurrentIdentity();
    const identity = this.#admission.captureDeliveryIdentity(envelope, transportIdentity);
    const lease = Object.freeze({ id: ++this.#nextIngressId, envelope });
    const state: IngressState = {
      envelope,
      ...(identity === undefined ? {} : { identity }),
      epoch: this.#epoch,
      finished: false,
    };
    this.#ingress.set(lease, state);
    this.#activeIngress.add(lease);
    if (this.#closed) {
      state.finished = true;
      this.#trackExecutor(this.#disposeUnreserved(envelope, identity, "ingress_after_close"));
    }
    return lease;
  }

  ingressOpen(lease: IngressLease): boolean {
    const state = this.#ingress.get(lease);
    return state !== undefined && !state.finished && !this.#closed && state.epoch === this.#epoch;
  }

  finishIngress(lease: IngressLease): void {
    const state = this.#ingress.get(lease);
    if (state !== undefined) state.finished = true;
    this.#activeIngress.delete(lease);
  }

  reserve(lease: IngressLease, classification: AdmissionClassification): AdmissionResult {
    const state = this.#ingress.get(lease);
    if (
      state === undefined ||
      state.finished ||
      this.#closed ||
      state.epoch !== this.#epoch ||
      this.#finishedReceipts.has(state.envelope)
    ) return { kind: "closed" };

    const envelope = state.envelope;
    let result: ReturnType<InterAgentAdmission["admit"]>;
    switch (classification.kind) {
      case "fallback": {
        const fallback = this.#admission.admitFallback(envelope);
        if (fallback.kind === "reserved") {
          state.handle = fallback.reservation;
          return { kind: "reserved", handle: fallback.reservation };
        }
        if (fallback.kind === "duplicate_loss") return { kind: "duplicate_loss" };
        return {
          kind: "refused",
          ...(fallback.lossId === undefined ? {} : { lossId: fallback.lossId }),
          ...(fallback.retirementAttemptCount === undefined
            ? {}
            : { retirementAttemptCount: fallback.retirementAttemptCount }),
          controlReservationCount: this.#admission.counts().control,
        };
      }
      case "waiter":
        result = this.#admission.admit(envelope, {
          waiter: true,
          ...(classification.lossId === undefined ? {} : { lossId: classification.lossId }),
        });
        break;
      case "loss":
        result = this.#admission.admit(envelope, { lossId: classification.lossId });
        break;
      case "ordinary":
        result = this.#admission.admit(envelope);
        break;
    }

    if (result.kind === "reserved") {
      state.handle = result.reservation;
      return { kind: "reserved", handle: result.reservation };
    }
    if (result.kind === "duplicate_loss") return { kind: "duplicate_loss" };
    const lossId = classification.kind === "loss"
      ? classification.lossId
      : classification.kind === "waiter" ? classification.lossId : undefined;
    const retirementAttemptCount = lossId === undefined ? undefined : this.#admission.recordRefusedLoss();
    return {
      kind: "refused",
      ...(lossId === undefined ? {} : { lossId }),
      ...(retirementAttemptCount === undefined ? {} : { retirementAttemptCount }),
      ...(lossId === undefined ? {} : { controlReservationCount: this.#admission.counts().control }),
    };
  }

  /** A convenience for standalone coordinator tests; product handlers pass a handle. */
  reserveDirect(envelope: Envelope): InputHandle | undefined {
    const lease = this.beginIngress(envelope);
    const result = this.reserve(lease, { kind: "ordinary" });
    this.finishIngress(lease);
    return result.kind === "reserved" ? result.handle : undefined;
  }

  owns(handle: InputHandle, envelope: Envelope): boolean {
    return this.#admission.owns(handle, envelope);
  }

  reservationFor(envelope: Envelope): InputHandle | undefined {
    return this.#admission.reservationFor(envelope);
  }

  deliveryIdentityFor(envelope: Envelope): InterAgentDeliveryIdentity | undefined {
    return this.#admission.deliveryIdentityFor(envelope);
  }

  captureDeliveryIdentity(
    envelope: Envelope,
    identity?: { incarnation: string; generation: string } | null,
  ): InterAgentDeliveryIdentity | undefined {
    return this.#admission.captureDeliveryIdentity(envelope, identity);
  }

  isLossDuplicate(lossId: string): boolean {
    return this.#admission.isLossDuplicate(lossId);
  }

  lossDisposition(lossId: string): "pending" | "completed" | "unknown" {
    return this.#admission.lossDisposition(lossId);
  }

  pending(): readonly PendingInput[] {
    return this.#admission.pendingEntries().map(entry => ({
      handle: entry.reservation,
      envelope: entry.envelope,
      reservationClass: entry.reservationClass,
      ...(entry.deliveryIdentity === undefined ? {} : { deliveryIdentity: entry.deliveryIdentity }),
      ...(entry.lossId === undefined ? {} : { lossId: entry.lossId }),
    }));
  }

  finish(handle: InputHandle, witness: InputWitness): CompletionResult {
    const prior = this.#claims.get(handle);
    if (prior !== undefined) return { kind: "already_finished" };
    const entry = this.#admission.pendingEntry(handle);
    if (entry === undefined) throw new TypeError("foreign or unowned inter-agent input handle");

    const result: CompletionResult = { kind: "completed", witness: witness.kind };
    this.#claims.set(handle, { result });
    this.#finishedReceipts.add(entry.envelope);
    const releaseReason: InterAgentReleaseReason = witness.kind === "observed"
      ? "handed_off"
      : witness.kind === "inline" ? "completed" : "retired";
    this.#admission.release(handle, releaseReason);

    if (witness.kind === "observed") {
      this.#safeEffect(() => this.#options.acknowledgeDelivery?.(entry.envelope));
      this.#safeEffect(() => this.#options.observeInput?.(entry.envelope, witness));
    } else if (witness.kind === "inline") {
      this.#safeEffect(() => this.#options.acknowledgeDelivery?.(entry.envelope));
      this.#safeEffect(() => this.#options.settleStage?.(entry.envelope, witness.reason));
    } else if (witness.kind === "abandoned") {
      void this.#requestRetirement(entry.envelope, entry.deliveryIdentity, witness.reason);
    } else {
      if (witness.ack === "already_observed") {
        this.#safeEffect(() => this.#options.acknowledgeDelivery?.(entry.envelope));
      }
      if (witness.ack === "hold") {
        this.#safeEffect(() => this.#options.unknownInput?.(entry.envelope, witness.reason));
      }
    }
    this.#notifyCloseWaiters();
    return result;
  }

  finishInline(lease: IngressLease, reason: "terminal_skip" | "stale_skip" | "duplicate_loss"): CompletionResult {
    const state = this.#ingress.get(lease);
    if (state === undefined) throw new TypeError("foreign inter-agent ingress lease");
    if (state.handle !== undefined) return this.finish(state.handle, { kind: "inline", reason: reason === "duplicate_loss" ? "stale_skip" : reason });
    if (this.#finishedReceipts.has(state.envelope)) return { kind: "already_finished" };

    const lossId = this.#eligibleLossId(state.envelope);
    if (reason === "duplicate_loss") {
      const result: CompletionResult = { kind: "completed", witness: "inline" };
      this.#finishedReceipts.add(state.envelope);
      this.#safeEffect(() => this.#options.acknowledgeDelivery?.(state.envelope));
      this.#diagnostic("duplicate_delivery_loss", {
        loss_id: lossId,
        loss_disposition: lossId === undefined ? "unknown" : this.lossDisposition(lossId),
        delivery_identity: state.identity,
      });
      return result;
    }
    if (lossId !== undefined) this.#admission.completeLoss(lossId);
    const result: CompletionResult = { kind: "completed", witness: "inline" };
    this.#finishedReceipts.add(state.envelope);
    this.#safeEffect(() => this.#options.acknowledgeDelivery?.(state.envelope));
    this.#safeEffect(() => this.#options.settleStage?.(state.envelope, reason));
    return result;
  }

  abandonIngress(lease: IngressLease, reason: string): Promise<CompletionResult> {
    const state = this.#ingress.get(lease);
    if (state === undefined) return Promise.reject(new TypeError("foreign inter-agent ingress lease"));
    if (state.handle !== undefined) return Promise.resolve(this.finish(state.handle, { kind: "abandoned", reason }));
    return this.#disposeUnreserved(state.envelope, state.identity, reason);
  }

  acknowledgeReceipt(lease: IngressLease): void {
    const state = this.#ingress.get(lease);
    if (state !== undefined && !this.#finishedReceipts.has(state.envelope)) {
      this.#safeEffect(() => this.#options.acknowledgeDelivery?.(state.envelope));
    }
  }

  refuse(lease: IngressLease, rejection: OverloadDisposition): Promise<CompletionResult> {
    const state = this.#ingress.get(lease);
    if (state === undefined) return Promise.reject(new TypeError("foreign inter-agent ingress lease"));
    if (this.#finishedReceipts.has(state.envelope)) return Promise.resolve({ kind: "already_finished" });
    const existing = this.#refusalExecutors.get(state.envelope);
    if (existing !== undefined) return existing;
    const run = this.#closed || state.epoch !== this.#epoch
      ? this.#disposeUnreserved(state.envelope, state.identity, "closed_before_refusal")
      : this.#executeRefusal(state.envelope, state.identity, rejection);
    const tracked = this.#trackExecutor(run);
    this.#refusalExecutors.set(state.envelope, tracked);
    return tracked;
  }

  completeBatch(handles: readonly InputHandle[], disposition: BatchDisposition): CompletionResult {
    if (disposition.kind === "already_observed") {
      const pending = handles.filter(handle => this.#admission.pendingEntry(handle) !== undefined);
      if (pending.length > 0) {
        this.#invariantViolations += 1;
        this.#diagnostic("observed_settlement_with_pending_input", {
          owner_token: disposition.ownerToken,
          pending_handle_count: pending.length,
          deliveries: pending.map(handle => {
            const item = this.#admission.pendingEntry(handle)!;
            return {
              delivery_identity: item.deliveryIdentity,
              delivery_seq: item.deliveryIdentity?.delivery_seq,
              loss_id: item.lossId,
            };
          }),
        });
        for (const handle of pending) {
          this.finish(handle, {
            kind: "uncertain",
            reason: "missing_observation_witness",
            ack: "already_observed",
          });
        }
        return {
          kind: "recovered_invariant_violation",
          pendingHandles: pending.length,
          token: disposition.ownerToken,
        };
      }
      return { kind: "completed", witness: "observed" };
    }

    for (const handle of handles) {
      if (this.#admission.pendingEntry(handle) !== undefined) this.finish(handle, disposition);
    }
    return { kind: "completed", witness: disposition.kind };
  }

  bindResult<T extends { content: Array<{ type: "text"; text: string }> }>(result: T, input: ResultInputLease): T {
    let settled = false;
    const handles = input.entries.flatMap(entry => entry.handle === undefined ? [] : [entry.handle]);
    return bindToolResultHandoff(result, {
      live: () => !settled && !this.#closed && input.live(),
      commit: () => {
        if (settled) return;
        settled = true;
        try {
          input.commitContainerTransfer();
        } catch (error) {
          this.#diagnostic("result_container_commit_failed", { detail: String(error).slice(0, 256) });
        } finally {
          for (const handle of handles) {
            try {
              this.finish(handle, { kind: "observed", boundary: "tool_result", ownerToken: input.ownerToken });
            } catch (error) {
              this.#diagnostic("result_input_completion_failed", { detail: String(error).slice(0, 256) });
            }
          }
        }
      },
      rollback: () => {
        if (settled) return;
        settled = true;
        let returned = false;
        try {
          returned = !this.#closed && input.returnToInput();
        } catch (error) {
          this.#diagnostic("result_input_return_failed", { detail: String(error).slice(0, 256) });
        }
        if (!returned) {
          for (const handle of handles) {
            try {
              this.finish(handle, { kind: "abandoned", reason: "result_not_returned" });
            } catch (error) {
              this.#diagnostic("result_input_abandon_failed", { detail: String(error).slice(0, 256) });
            }
          }
        }
      },
    }) as T;
  }

  close(options: {
    preserveInFlight: readonly InputHandle[];
    reason: string;
    finalizePreserved?: boolean;
    finalizeBy?: number;
  }): Promise<void> {
    if (this.#finalClosePromise !== undefined && (options.finalizePreserved || options.finalizeBy !== undefined)) {
      return this.#finalClosePromise;
    }
    if (!this.#closed) {
      this.#closed = true;
      this.#epoch += 1;
      for (const handle of options.preserveInFlight) this.#preservedHandles.add(handle);
      for (const entry of this.pending()) {
        if (this.#preservedHandles.has(entry.handle)) continue;
        this.finish(entry.handle, { kind: "abandoned", reason: options.reason });
      }
      for (const lease of [...this.#activeIngress]) {
        const state = this.#ingress.get(lease);
        if (state === undefined || state.handle !== undefined || this.#refusalExecutors.has(state.envelope)) continue;
        state.finished = true;
        this.#trackExecutor(this.#disposeUnreserved(state.envelope, state.identity, options.reason));
      }
    }
    if (options.finalizePreserved || options.finalizeBy !== undefined) {
      const deadline = options.finalizePreserved ? performance.now() : options.finalizeBy!;
      let timer: ReturnType<typeof setTimeout> | undefined;
      this.#finalClosePromise = new Promise<void>(resolve => {
        const check = (): void => {
          if (this.#activeRefusals.size > 0 || this.#executors.size > 0 || this.#hasPendingPreserved()) return;
          if (timer !== undefined) clearTimeout(timer);
          this.#closeWaiters.delete(check);
          resolve();
        };
        const finalizeAtDeadline = (): void => {
          for (const executor of [...this.#activeRefusals]) this.#finalizeRefusal(executor, "unknown");
          this.#finalizePreserved(options.reason);
          check();
        };
        this.#closeWaiters.add(check);
        if (deadline <= performance.now()) finalizeAtDeadline();
        else timer = setTimeout(finalizeAtDeadline, deadline - performance.now());
        check();
      });
      return this.#finalClosePromise;
    }
    this.#closePromise = Promise.allSettled([...this.#executors]).then(() => undefined);
    return this.#closePromise;
  }

  stopRetirementRequests(): void {
    this.#retirementRequestsClosed = true;
  }

  #executeRefusal(
    envelope: Envelope,
    identity: InterAgentDeliveryIdentity | undefined,
    rejection: OverloadDisposition,
  ): Promise<CompletionResult> {
    let resolve!: (result: CompletionResult) => void;
    const completion = new Promise<CompletionResult>(done => { resolve = done; });
    const executor: RefusalExecutor = {
      envelope,
      ...(identity === undefined ? {} : { identity }),
      rejection,
      controller: new AbortController(),
      resolve,
      finalized: false,
    };
    this.#activeRefusals.add(executor);
    if (rejection.notice === undefined) {
      this.#finalizeRefusal(executor, "not_applicable");
    } else {
      let sent: Promise<InterAgentNoticeOutcome>;
      try {
        sent = this.#options.sendNotice?.(rejection.notice, executor.controller.signal) ?? Promise.resolve("unknown");
      } catch {
        sent = Promise.resolve("unknown");
      }
      void Promise.resolve(sent).then(
        outcome => this.#finalizeRefusal(executor, executor.finalized ? "unknown" : outcome),
        () => this.#finalizeRefusal(executor, "unknown"),
      );
    }
    return completion;
  }

  #finalizeRefusal(executor: RefusalExecutor, noticeOutcome: InterAgentNoticeOutcome | "not_applicable"): void {
    if (executor.finalized) return;
    executor.finalized = true;
    this.#activeRefusals.delete(executor);
    executor.controller.abort();
    const { envelope, identity, rejection } = executor;
    this.#finishedReceipts.add(envelope);

    let capability: InterAgentRetirementCapability = "pending";
    let retirementOutcome: "not_requested" | "requested" | "failed" | "unsupported" | "pending" | "stale_identity" = "not_requested";
    if (noticeOutcome === "accepted") {
      this.#safeEffect(() => this.#options.acknowledgeDelivery?.(envelope));
    } else {
      try { capability = this.#options.retirementCapability?.() ?? "pending"; } catch { capability = "pending"; }
      if (capability === "supported") {
        const outcome = this.#requestRetirement(envelope, identity, "receiver_overloaded");
        retirementOutcome = outcome;
      } else if (capability === "unsupported") {
        retirementOutcome = "unsupported";
        this.#safeEffect(() => this.#options.acknowledgeDelivery?.(envelope));
      } else {
        retirementOutcome = "pending";
      }
    }
    this.#safeEffect(() => this.#options.settleStage?.(envelope, "receiver_overloaded"));
    this.#diagnostic("receiver_overloaded", {
      reason: rejection.lossId === undefined
        ? rejection.notice === undefined ? "unattributable_or_error_notice_backlog_full" : "ordinary_backlog_full"
        : "loss_notice_control_allowance_exhausted",
      delivery_seq: (envelope as Envelope & { delivery_seq?: unknown }).delivery_seq,
      loss_id: rejection.lossId,
      delivery_identity: identity,
      retirement_attempt_count: rejection.retirementAttemptCount,
      control_reservations: rejection.lossId === undefined ? undefined : this.#admission.counts().control,
      notice_dispatch_outcome: noticeOutcome,
      retirement_capability: capability,
      retirement_request_outcome: retirementOutcome,
      acknowledgement_outcome: noticeOutcome === "accepted"
        ? "intentional_non_injection_after_notice"
        : retirementOutcome === "unsupported" ? "intentional_non_injection_retirement_unsupported"
        : retirementOutcome === "requested" || retirementOutcome === "failed" ? "held_for_retirement_recovery"
        : retirementOutcome === "pending" ? "held_pending_retirement_capability" : "not_requested",
      server_recovery_outcome: "unknown",
    });
    executor.resolve({ kind: "completed", witness: "inline" });
    this.#notifyCloseWaiters();
  }

  #finalizePreserved(reason: string): void {
    for (const handle of this.#preservedHandles) {
      if (this.#admission.pendingEntry(handle) !== undefined) {
        this.finish(handle, { kind: "uncertain", reason, ack: "hold" });
      }
    }
    this.#preservedHandles.clear();
  }

  #hasPendingPreserved(): boolean {
    return [...this.#preservedHandles].some(handle => this.#admission.pendingEntry(handle) !== undefined);
  }

  #notifyCloseWaiters(): void {
    for (const check of [...this.#closeWaiters]) check();
  }

  async #disposeUnreserved(
    envelope: Envelope,
    identity: InterAgentDeliveryIdentity | undefined,
    reason: string,
  ): Promise<CompletionResult> {
    if (this.#finishedReceipts.has(envelope)) return { kind: "already_finished" };
    this.#finishedReceipts.add(envelope);
    const retirement = this.#requestRetirement(envelope, identity, reason);
    if (retirement === "unsupported") this.#safeEffect(() => this.#options.acknowledgeDelivery?.(envelope));
    this.#diagnostic("unreserved_input_disposed", {
      reason,
      retirement_request_outcome: retirement,
      delivery_identity: identity,
    });
    return { kind: "completed", witness: "abandoned" };
  }

  #requestRetirement(
    envelope: Envelope,
    captured: InterAgentDeliveryIdentity | undefined,
    reason: string,
  ): "requested" | "failed" | "unsupported" | "pending" | "stale_identity" {
    if (this.#retirementRequestsClosed) return "pending";
    let capability: InterAgentRetirementCapability = "pending";
    try {
      capability = this.#options.retirementCapability?.() ?? "pending";
    } catch {
      capability = "pending";
    }
    if (capability !== "supported") return capability;
    if (captured === undefined || captured.incarnation === undefined || captured.generation === undefined) {
      this.#diagnostic("retirement_identity_unobserved", { reason, delivery_identity: captured });
      return "stale_identity";
    }
    const live = this.#safeCurrentIdentity();
    if (
      live === null ||
      live.incarnation !== captured.incarnation ||
      live.generation !== captured.generation
    ) {
      this.#diagnostic("retirement_identity_changed", { reason, delivery_identity: captured });
      return "stale_identity";
    }
    try {
      return this.#options.retireDelivery?.(envelope) === true ? "requested" : "failed";
    } catch {
      return "failed";
    }
  }

  #safeCurrentIdentity(): { incarnation: string; generation: string } | null {
    try {
      return this.#options.currentIdentity?.() ?? null;
    } catch {
      return null;
    }
  }

  #eligibleLossId(envelope: Envelope): string | undefined {
    const payload = envelope.payload as { loss_id?: unknown; turn_number?: unknown };
    return envelope.agent_id === "server" && payload.turn_number === 0 && typeof payload.loss_id === "string"
      ? payload.loss_id
      : undefined;
  }

  #trackExecutor(task: Promise<CompletionResult>): Promise<CompletionResult> {
    const tracked = task.catch(error => {
      this.#diagnostic("input_disposition_failed", { detail: String(error).slice(0, 256) });
      return { kind: "completed", witness: "abandoned" } as CompletionResult;
    }).finally(() => {
      this.#executors.delete(tracked);
      this.#notifyCloseWaiters();
    });
    this.#executors.add(tracked);
    return tracked;
  }

  #safeEffect(effect: () => void): void {
    try {
      effect();
    } catch (error) {
      this.#diagnostic("input_effect_failed", { detail: String(error).slice(0, 256) });
    }
  }

  #diagnostic(event: string, details: Record<string, unknown>): void {
    try {
      this.#options.onInvariantViolation?.({ event, ...details });
    } catch {
      // Diagnostic observers must not block ownership transitions.
    }
    try {
      this.#options.log?.(`${JSON.stringify({ event, ...details })}\n`);
    } catch {
      // Logging is not part of the receipt transition.
    }
  }

  #diagnosticLine(line: string): void {
    try {
      this.#options.log?.(line);
    } catch {
      // Logging is not part of the receipt transition.
    }
  }
}
