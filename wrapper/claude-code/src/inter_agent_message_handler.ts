import { InterAgentAdmission, InterAgentTool, settleOverloadedInbound } from "@kaoiro/agent-common";
import type { Envelope, InboundDisposition, InboundReplyMode, InterAgentAdmissionReservation, InterAgentRetirementCapability } from "@kaoiro/agent-common";
import type { InterAgentIngressGate } from "./inter_agent_turn_coordinator.js";

/** Dependencies the Claude CLI supplies to its production inbound handler.
 * The ingress gate remains part of this handler because it protects the gap
 * around `receiveInbound()`'s await; queue ownership stays in the CLI's
 * production coordinator and is exposed through `inject`. */
export interface InterAgentMessageHandlerContext {
  interAgent: (Pick<InterAgentTool, "receiveInbound"> & Partial<Pick<InterAgentTool, "admission" | "sendInternalNotice">>) | null;
  admission?: InterAgentAdmission;
  ingress: Pick<
    InterAgentIngressGate,
    "begin" | "isTerminal" | "finish"
  >;
  recordInboundIa: (envelope: Envelope) => void;
  send: (envelope: Envelope) => void;
  /** Completes intentional non-injection paths only. Injected messages are
   * confirmed by the host's actual SDK turn-start callback. */
  acknowledgeDelivery?: (envelope: Envelope) => void;
  reportQueued?: (envelope: Envelope) => void;
  settleStage?: (envelope: Envelope, reason: "terminal_skip" | "stale_skip" | "receiver_overloaded") => void;
  retireDelivery?: (envelope: Envelope) => boolean;
  retirementCapability?: () => InterAgentRetirementCapability;
  inject: (envelope: Envelope, mode: InboundReplyMode, reservation?: InterAgentAdmissionReservation) => void;
  log: (line: string) => void;
}

/** Production `ServerLink#onInterAgentMessage` handler for the Claude CLI.
 * Lifecycle tests call this function directly; the CLI supplies its live
 * transport and coordinator through the context above. */
export async function handleInterAgentMessage(
  context: InterAgentMessageHandlerContext,
  envelope: Envelope,
): Promise<void> {
  const ingressLease = context.ingress.begin(envelope);
  const admission = context.admission ?? context.interAgent?.admission ?? (context.interAgent === null ? undefined : new InterAgentAdmission());
  if (admission === undefined) throw new Error("inter-agent admission instance is required");
  // The sidecar documents delivery even when this inbound never reaches the
  // coordinator (ADR-0051 D3-2).
  context.recordInboundIa(envelope);
  try {
    if (context.ingress.isTerminal(ingressLease)) {
      // Retirement must precede any acknowledgement: an offline ack could
      // otherwise erase routing metadata before the loss is reported.
      if (!context.retireDelivery?.(envelope)) context.acknowledgeDelivery?.(envelope);
      context.settleStage?.(envelope, "terminal_skip");
      context.log(
        `  inter_agent_message terminal ingress skipped before receive: ${envelope.agent_id}\n`,
      );
      return;
    }
    const disposition: InboundDisposition = context.interAgent
      ? await context.interAgent.receiveInbound(envelope)
      : (() => {
          const fallback = admission.admitFallback(envelope);
          return fallback.kind === "duplicate_loss"
            ? { consumed: false as const, inject: false as const, mode: "reply-owed" as const, noticeSkipReason: "duplicate delivery loss notice" as const }
            : fallback.kind === "reserved"
            ? { consumed: false as const, inject: true as const, mode: "reply-owed" as const }
            : { consumed: false as const, inject: false as const, mode: "reply-owed" as const, overloaded: true as const,
                ...(fallback.lossId === undefined ? {} : { lossId: fallback.lossId }),
                ...(fallback.retirementAttemptCount === undefined ? {} : { retirementAttemptCount: fallback.retirementAttemptCount }) };
        })();
    if (context.ingress.isTerminal(ingressLease)) {
      // `receiveInbound()` may have yielded while the host closed. This is
      // likewise a retirement; legacy servers retain intentional-non-injection
      // acknowledgement because they do not support explicit loss.
      if (!context.retireDelivery?.(envelope)) context.acknowledgeDelivery?.(envelope);
      admission.releaseEnvelope(envelope, "retired");
      context.settleStage?.(envelope, "terminal_skip");
      context.log(
        `  inter_agent_message terminal ingress skipped after receive: ${envelope.agent_id}\n`,
      );
      return;
    }
    if ("overloaded" in disposition && disposition.overloaded) {
      const deliveryIdentity = admission.deliveryIdentityFor(envelope);
      await settleOverloadedInbound({
        envelope,
        ...("notice" in disposition && disposition.notice != null ? { notice: disposition.notice } : {}),
        ...(disposition.lossId === undefined ? {} : { lossId: disposition.lossId }),
        ...(disposition.lossId === undefined ? {} : { controlReservationCount: admission.counts().control }),
        ...(deliveryIdentity === undefined ? {} : { deliveryIdentity }),
        ...(disposition.retirementAttemptCount === undefined ? {} : { retirementAttemptCount: disposition.retirementAttemptCount }),
        sendNotice: notice => context.interAgent?.sendInternalNotice?.(notice) ?? Promise.resolve("unknown"),
        ...(context.retirementCapability === undefined ? {} : { retirementCapability: context.retirementCapability }),
        ...(context.retireDelivery === undefined ? {} : { retireDelivery: context.retireDelivery }),
        ...(context.acknowledgeDelivery === undefined ? {} : { acknowledgeDelivery: context.acknowledgeDelivery }),
        ...(context.settleStage === undefined ? {} : { settleStage: context.settleStage }),
        log: context.log,
      });
      return;
    }
    if (disposition.consumed) {
      context.reportQueued?.(envelope);
      if (!disposition.deferAck) context.acknowledgeDelivery?.(envelope);
      context.log(`  inter_agent_message reply consumed: ${envelope.agent_id}\n`);
      return;
    }
    if (!disposition.inject) {
      context.acknowledgeDelivery?.(envelope);
      context.settleStage?.(envelope, disposition.mode === "terminal" ? "terminal_skip" : "stale_skip");
      if (disposition.mode === "terminal") {
        context.log(`  inter_agent_message terminal, no reply owed: ${envelope.agent_id}\n`);
      } else if ("notice" in disposition && disposition.notice != null) {
        context.send(disposition.notice);
        context.log(
          `  inter_agent_message stale/duplicate turn dropped, stale_turn notice sent: ${envelope.agent_id}\n`,
        );
      } else {
        context.log(
          `  inter_agent_message stale/duplicate turn dropped, no notice (${disposition.noticeSkipReason}): ${envelope.agent_id}\n`,
        );
      }
      return;
    }
    context.log(`  inter_agent_message: ${envelope.agent_id}\n`);
    context.reportQueued?.(envelope);
    const reservation = admission.reservationFor(envelope);
    context.inject(envelope, disposition.mode, reservation);
  } finally {
    context.ingress.finish(ingressLease);
  }
}
