import { InterAgentAdmission, InterAgentTool, settleOverloadedInbound } from "@kaoiro/agent-common";
import type { Envelope, InboundDisposition, InboundReplyMode, InterAgentAdmissionReservation, InterAgentRetirementCapability } from "@kaoiro/agent-common";

export interface AntigravityInterAgentMessageHandlerContext {
  interAgent: (Pick<InterAgentTool, "receiveInbound"> & Partial<Pick<InterAgentTool, "admission" | "sendInternalNotice">>) | null;
  admission?: InterAgentAdmission;
  send: (envelope: Envelope) => void;
  acknowledgeDelivery?: (envelope: Envelope) => void;
  retireDelivery?: (envelope: Envelope) => boolean;
  retirementCapability?: () => InterAgentRetirementCapability;
  settleStage?: (envelope: Envelope, reason: "receiver_overloaded") => void;
  inject: (envelope: Envelope, mode: InboundReplyMode, reservation?: InterAgentAdmissionReservation) => void;
  log: (line: string) => void;
}

/** Handles every inbound disposition before a message enters an agy turn. */
export async function handleAntigravityInterAgentMessage(
  context: AntigravityInterAgentMessageHandlerContext,
  envelope: Envelope,
): Promise<void> {
  const admission = context.admission ?? context.interAgent?.admission ?? (context.interAgent === null ? undefined : new InterAgentAdmission());
  if (admission === undefined) throw new Error("inter-agent admission instance is required");
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
    if (!disposition.deferAck) context.acknowledgeDelivery?.(envelope);
    context.log(`  antigravity inter_agent_message reply consumed: ${envelope.agent_id}\n`);
    return;
  }
  if (!disposition.inject) {
    context.acknowledgeDelivery?.(envelope);
    if (disposition.mode === "terminal") {
      context.log(`  antigravity inter_agent_message terminal, no reply owed: ${envelope.agent_id}\n`);
    } else if ("notice" in disposition && disposition.notice != null) {
      context.send(disposition.notice);
      context.log(
        `  antigravity inter_agent_message stale/duplicate turn dropped, stale_turn notice sent: ${envelope.agent_id}\n`,
      );
    } else {
      context.log(
        `  antigravity inter_agent_message stale/duplicate turn dropped, no notice (${disposition.noticeSkipReason}): ${envelope.agent_id}\n`,
      );
    }
    return;
  }
  context.log(`  antigravity inter_agent_message: ${envelope.agent_id}\n`);
  context.inject(envelope, disposition.mode, admission.reservationFor(envelope));
}
