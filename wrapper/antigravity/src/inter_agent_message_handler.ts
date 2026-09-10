import { InterAgentTool } from "@kaoiro/agent-common";
import type { Envelope, InboundReplyMode } from "@kaoiro/agent-common";

export interface AntigravityInterAgentMessageHandlerContext {
  interAgent: Pick<InterAgentTool, "receiveInbound"> | null;
  send: (envelope: Envelope) => void;
  acknowledgeDelivery?: (envelope: Envelope) => void;
  inject: (envelope: Envelope, mode: InboundReplyMode) => void;
  log: (line: string) => void;
}

/** Handles every inbound disposition before a message enters an agy turn. */
export async function handleAntigravityInterAgentMessage(
  context: AntigravityInterAgentMessageHandlerContext,
  envelope: Envelope,
): Promise<void> {
  const disposition = (await context.interAgent?.receiveInbound(envelope)) ?? {
    consumed: false,
    inject: true,
    mode: "reply-owed" as const,
  };
  if (disposition.consumed) {
    context.acknowledgeDelivery?.(envelope);
    context.log(`  antigravity inter_agent_message reply consumed: ${envelope.agent_id}\n`);
    return;
  }
  if (!disposition.inject) {
    context.acknowledgeDelivery?.(envelope);
    if (disposition.mode === "terminal") {
      context.log(`  antigravity inter_agent_message terminal, no reply owed: ${envelope.agent_id}\n`);
    } else if (disposition.notice) {
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
  context.inject(envelope, disposition.mode);
}
