import { InterAgentTool } from "@kaoiro/agent-common";
import type { Envelope, InboundReplyMode } from "@kaoiro/agent-common";
import type { InterAgentIngressGate } from "./inter_agent_turn_coordinator.js";

/** Dependencies the Claude CLI supplies to its production inbound handler.
 * The ingress gate remains part of this handler because it protects the gap
 * around `receiveInbound()`'s await; queue ownership stays in the CLI's
 * production coordinator and is exposed through `inject`. */
export interface InterAgentMessageHandlerContext {
  interAgent: Pick<InterAgentTool, "receiveInbound"> | null;
  ingress: Pick<
    InterAgentIngressGate,
    "begin" | "isTerminal" | "finish"
  >;
  recordInboundIa: (envelope: Envelope) => void;
  send: (envelope: Envelope) => void;
  /** Completes intentional non-injection paths only. Injected messages are
   * confirmed by the host's actual SDK turn-start callback. */
  acknowledgeDelivery?: (envelope: Envelope) => void;
  inject: (envelope: Envelope, mode: InboundReplyMode) => void;
  log: (line: string) => void;
}

/** Production `ServerLink#onInterAgentMessage` handler for the Claude CLI.
 * Lifecycle tests call this function directly; the CLI supplies its live
 * transport and coordinator through the context above. */
export async function handleInterAgentMessage(
  context: InterAgentMessageHandlerContext,
  envelope: Envelope,
): Promise<void> {
  const ingressLease = context.ingress.begin();
  // The sidecar documents delivery even when this inbound never reaches the
  // coordinator (ADR-0051 D3-2).
  context.recordInboundIa(envelope);
  try {
    if (context.ingress.isTerminal(ingressLease)) {
      // The handler deliberately declined this inbound before the SDK-facing
      // classifier. It cannot ever reach a turn in a host that has already
      // become terminal, so leave no false delivery gap behind.
      context.acknowledgeDelivery?.(envelope);
      context.log(
        `  inter_agent_message terminal ingress skipped before receive: ${envelope.agent_id}\n`,
      );
      return;
    }
    const disposition = (await context.interAgent?.receiveInbound(envelope)) ?? {
      consumed: false,
      inject: true,
      mode: "reply-owed" as const,
    };
    if (context.ingress.isTerminal(ingressLease)) {
      // `receiveInbound()` may have yielded while the host closed. This is
      // likewise an intentional non-injection, not an unacknowledged SDK
      // dispatch.
      context.acknowledgeDelivery?.(envelope);
      context.log(
        `  inter_agent_message terminal ingress skipped after receive: ${envelope.agent_id}\n`,
      );
      return;
    }
    if (disposition.consumed) {
      context.acknowledgeDelivery?.(envelope);
      context.log(`  inter_agent_message reply consumed: ${envelope.agent_id}\n`);
      return;
    }
    if (!disposition.inject) {
      context.acknowledgeDelivery?.(envelope);
      if (disposition.mode === "terminal") {
        context.log(`  inter_agent_message terminal, no reply owed: ${envelope.agent_id}\n`);
      } else if (disposition.notice) {
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
    context.inject(envelope, disposition.mode);
  } finally {
    context.ingress.finish(ingressLease);
  }
}
