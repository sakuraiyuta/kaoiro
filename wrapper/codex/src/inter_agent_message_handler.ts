import { InterAgentAdmission, InterAgentTool, settleOverloadedInbound } from "@kaoiro/agent-common";
import type { Envelope, InboundDisposition, InboundReplyMode, InterAgentAdmissionReservation, InterAgentRetirementCapability } from "@kaoiro/agent-common";

/** Dependencies the Codex CLI supplies to its production inbound handler.
 * Keeping the transport, tool, and queue edges explicit lets the lifecycle
 * tests execute this exact handler instead of reproducing its branches. */
export interface InterAgentMessageHandlerContext {
  interAgent: (Pick<InterAgentTool, "receiveInbound"> & Partial<Pick<InterAgentTool, "admission" | "sendInternalNotice">>) | null;
  admission?: InterAgentAdmission;
  recordInboundIa: (envelope: Envelope) => void;
  send: (envelope: Envelope) => void;
  /** Completes intentional non-injection paths only. Injected messages wait
   * for the host's actual SDK turn-start boundary. */
  acknowledgeDelivery?: (envelope: Envelope) => void;
  reportQueued?: (envelope: Envelope) => void;
  settleStage?: (envelope: Envelope, reason: "terminal_skip" | "stale_skip" | "receiver_overloaded") => void;
  retireDelivery?: (envelope: Envelope) => boolean;
  retirementCapability?: () => InterAgentRetirementCapability;
  inject: (envelope: Envelope, mode: InboundReplyMode, reservation?: InterAgentAdmissionReservation) => void | Promise<void>;
  log: (line: string) => void;
}

/** Production `ServerLink#onInterAgentMessage` handler for the Codex CLI.
 * The CLI owns queue/coalescing state and provides it as `inject`; this
 * function owns every disposition branch and its observable transport/log
 * effect. */
export async function handleInterAgentMessage(
  context: InterAgentMessageHandlerContext,
  envelope: Envelope,
): Promise<void> {
  // Recorded before anything consumes it (ADR-0051 D3-2 receive side).
  context.recordInboundIa(envelope);
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
      // Stale notices bypass invoke()/dispatch() and go directly to the
      // transport, so the original sender can resynchronize its track.
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
  await context.inject(envelope, disposition.mode, admission.reservationFor(envelope));
}
