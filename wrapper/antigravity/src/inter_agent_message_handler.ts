import { InterAgentAdmission, InterAgentInputLifecycle, InterAgentTool } from "@kaoiro/agent-common";
import type { Envelope, InboundDisposition, InboundReplyMode, InterAgentAdmissionReservation, InterAgentRetirementCapability, InterAgentInputLifecyclePort, IngressLease } from "@kaoiro/agent-common";

export interface AntigravityInterAgentMessageHandlerContext {
  interAgent: (Pick<InterAgentTool, "receiveInbound"> & Partial<Pick<InterAgentTool, "inputLifecycle" | "sendInternalNotice">>) | null;
  admission?: InterAgentAdmission;
  inputLifecycle?: InterAgentInputLifecyclePort;
  send: (envelope: Envelope) => void;
  acknowledgeDelivery?: (envelope: Envelope) => void;
  retireDelivery?: (envelope: Envelope) => boolean;
  retirementCapability?: () => InterAgentRetirementCapability;
  settleStage?: (envelope: Envelope, reason: "terminal_skip" | "stale_skip" | "receiver_overloaded") => void;
  inject: (envelope: Envelope, mode: InboundReplyMode, reservation?: InterAgentAdmissionReservation) => void;
  log: (line: string) => void;
}

/** Handles every inbound disposition before a message enters an agy turn. */
export async function handleAntigravityInterAgentMessage(
  context: AntigravityInterAgentMessageHandlerContext,
  envelope: Envelope,
): Promise<void> {
  const lifecycle = context.inputLifecycle ?? context.interAgent?.inputLifecycle ?? new InterAgentInputLifecycle({
    ...(context.admission === undefined ? {} : { admission: context.admission }),
    ...(context.acknowledgeDelivery === undefined ? {} : { acknowledgeDelivery: context.acknowledgeDelivery }),
    ...(context.retirementCapability === undefined ? {} : { retirementCapability: context.retirementCapability }),
    ...(context.retireDelivery === undefined ? {} : { retireDelivery: context.retireDelivery }),
    ...(context.settleStage === undefined ? {} : { settleStage: context.settleStage }),
    sendNotice: notice => context.interAgent?.sendInternalNotice?.(notice) ?? Promise.resolve("unknown"),
    log: context.log,
  });
  const lease: IngressLease = lifecycle.beginIngress(envelope);
  try {
    const disposition: InboundDisposition = context.interAgent
      ? await context.interAgent.receiveInbound(envelope, lease)
      : (() => {
          const fallback = lifecycle.reserve(lease, { kind: "fallback" });
          return fallback.kind === "duplicate_loss"
            ? { consumed: false as const, inject: false as const, mode: "reply-owed" as const, noticeSkipReason: "duplicate delivery loss notice" as const }
            : fallback.kind === "reserved"
            ? { consumed: false as const, inject: true as const, mode: "reply-owed" as const }
            : { consumed: false as const, inject: false as const, mode: "reply-owed" as const, overloaded: true as const,
                ...(fallback.kind === "refused" && fallback.lossId !== undefined ? { lossId: fallback.lossId } : {}),
                ...(fallback.kind === "refused" && fallback.retirementAttemptCount !== undefined ? { retirementAttemptCount: fallback.retirementAttemptCount } : {}) };
        })();
    if ("overloaded" in disposition && disposition.overloaded) {
      await lifecycle.refuse(lease, {
        ...("notice" in disposition && disposition.notice != null ? { notice: disposition.notice } : {}),
        ...(disposition.lossId === undefined ? {} : { lossId: disposition.lossId }),
        ...(disposition.retirementAttemptCount === undefined ? {} : { retirementAttemptCount: disposition.retirementAttemptCount }),
      });
      return;
    }
    if (disposition.consumed) {
      if (!disposition.deferAck) context.acknowledgeDelivery?.(envelope);
      context.log(`  antigravity inter_agent_message reply consumed: ${envelope.agent_id}\n`);
      return;
    }
    if (!disposition.inject) {
      lifecycle.finishInline(lease, disposition.noticeSkipReason === "duplicate delivery loss notice"
        ? "duplicate_loss"
        : disposition.mode === "terminal" ? "terminal_skip" : "stale_skip");
      if ("notice" in disposition && disposition.notice != null) context.send(disposition.notice);
      context.log(`  antigravity inter_agent_message ${disposition.mode === "terminal" ? "terminal" : "stale/duplicate"}, no input: ${envelope.agent_id}\n`);
      return;
    }
    context.log(`  antigravity inter_agent_message: ${envelope.agent_id}\n`);
    context.inject(envelope, disposition.mode, lifecycle.reservationFor(envelope));
  } finally {
    lifecycle.finishIngress(lease);
  }
}
