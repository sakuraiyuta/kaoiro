import { InterAgentTool } from "@kaoiro/agent-common";
import type { Envelope, InboundReplyMode } from "@kaoiro/agent-common";

/** Dependencies the Codex CLI supplies to its production inbound handler.
 * Keeping the transport, tool, and queue edges explicit lets the lifecycle
 * tests execute this exact handler instead of reproducing its branches. */
export interface InterAgentMessageHandlerContext {
  interAgent: Pick<InterAgentTool, "receiveInbound"> | null;
  recordInboundIa: (envelope: Envelope) => void;
  send: (envelope: Envelope) => void;
  /** Completes intentional non-injection paths only. Injected messages wait
   * for the host's actual SDK turn-start boundary. */
  acknowledgeDelivery?: (envelope: Envelope) => void;
  inject: (envelope: Envelope, mode: InboundReplyMode) => void;
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
  const disposition = (await context.interAgent?.receiveInbound(envelope)) ?? {
    consumed: false,
    inject: true,
    mode: "reply-owed" as const,
  };
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
  context.inject(envelope, disposition.mode);
}
