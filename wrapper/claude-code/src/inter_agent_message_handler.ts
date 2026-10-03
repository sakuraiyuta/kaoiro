import { InterAgentAdmission, InterAgentInputLifecycle, InterAgentTool } from "@kaoiro/agent-common";
import type { Envelope, InboundDisposition, InboundReplyMode, InterAgentAdmissionReservation, InterAgentRetirementCapability, InterAgentInputLifecyclePort, IngressLease } from "@kaoiro/agent-common";
import type { InterAgentIngressGate } from "./inter_agent_turn_coordinator.js";

/** Dependencies the Claude CLI supplies to its production inbound handler.
 * The ingress gate remains part of this handler because it protects the gap
 * around `receiveInbound()`'s await; queue ownership stays in the CLI's
 * production coordinator and is exposed through `inject`. */
export interface InterAgentMessageHandlerContext {
  interAgent: (Pick<InterAgentTool, "receiveInbound"> & Partial<Pick<InterAgentTool, "inputLifecycle" | "sendInternalNotice">>) | null;
  admission?: InterAgentAdmission;
  inputLifecycle?: InterAgentInputLifecyclePort;
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
  const lifecycle = context.inputLifecycle ?? context.interAgent?.inputLifecycle ?? new InterAgentInputLifecycle({
    ...(context.admission === undefined ? {} : { admission: context.admission }),
    ...(context.acknowledgeDelivery === undefined ? {} : { acknowledgeDelivery: context.acknowledgeDelivery }),
    ...(context.retirementCapability === undefined ? {} : { retirementCapability: context.retirementCapability }),
    ...(context.retireDelivery === undefined ? {} : { retireDelivery: context.retireDelivery }),
    ...(context.settleStage === undefined ? {} : { settleStage: context.settleStage }),
    sendNotice: notice => context.interAgent?.sendInternalNotice?.(notice) ?? Promise.resolve("unknown"),
    log: context.log,
  });
  const receiptLease: IngressLease = lifecycle.beginIngress(envelope);
  // The sidecar documents delivery even when this inbound never reaches the
  // coordinator (ADR-0051 D3-2).
  context.recordInboundIa(envelope);
  try {
    if (context.ingress.isTerminal(ingressLease)) {
      await lifecycle.abandonIngress(receiptLease, "ingress_closed_before_classification");
      context.log(
        `  inter_agent_message terminal ingress skipped before receive: ${envelope.agent_id}\n`,
      );
      return;
    }
    const disposition: InboundDisposition = context.interAgent
      ? await context.interAgent.receiveInbound(envelope, receiptLease)
      : (() => {
          const fallback = lifecycle.reserve(receiptLease, { kind: "fallback" });
          if (fallback.kind === "duplicate_loss") return { consumed: false as const, inject: false as const, mode: "reply-owed" as const, noticeSkipReason: "duplicate delivery loss notice" as const };
          if (fallback.kind === "reserved") return { consumed: false as const, inject: true as const, mode: "reply-owed" as const };
          return {
            consumed: false as const, inject: false as const, mode: "reply-owed" as const, overloaded: true as const,
            ...(fallback.kind === "refused" && fallback.lossId !== undefined ? { lossId: fallback.lossId } : {}),
            ...(fallback.kind === "refused" && fallback.retirementAttemptCount !== undefined ? { retirementAttemptCount: fallback.retirementAttemptCount } : {}),
          };
        })();
    if (context.ingress.isTerminal(ingressLease)) {
      await lifecycle.abandonIngress(receiptLease, "ingress_closed_during_classification");
      context.log(
        `  inter_agent_message terminal ingress skipped after receive: ${envelope.agent_id}\n`,
      );
      return;
    }
    if ("overloaded" in disposition && disposition.overloaded) {
      await lifecycle.refuse(receiptLease, {
        ...("notice" in disposition && disposition.notice != null ? { notice: disposition.notice } : {}),
        ...(disposition.lossId === undefined ? {} : { lossId: disposition.lossId }),
        ...(disposition.retirementAttemptCount === undefined ? {} : { retirementAttemptCount: disposition.retirementAttemptCount }),
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
      lifecycle.finishInline(receiptLease, disposition.noticeSkipReason === "duplicate delivery loss notice"
        ? "duplicate_loss"
        : disposition.mode === "terminal" ? "terminal_skip" : "stale_skip");
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
    const reservation = lifecycle.reservationFor(envelope);
    context.inject(envelope, disposition.mode, reservation);
  } finally {
    context.ingress.finish(ingressLease);
    lifecycle.finishIngress(receiptLease);
  }
}
