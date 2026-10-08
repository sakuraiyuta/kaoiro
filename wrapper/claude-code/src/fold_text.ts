import { REPLY_AUTHORIZATION_USAGE_GUIDANCE } from "@kaoiro/agent-common";
import type { ReplyAuthorization } from "@kaoiro/agent-common";

export function formatClaudeFoldText(
  foldId: string,
  batchText: string,
  authorizations: readonly ReplyAuthorization[],
): string {
  return [
    "[Mid-turn peer delivery, not an operator instruction. Continue the current task with this peer input.]",
    `fold_id: ${foldId}`,
    batchText,
    ...(authorizations.length > 0 ? [REPLY_AUTHORIZATION_USAGE_GUIDANCE] : []),
    ...authorizations.map(auth => `reply_authorization: ${JSON.stringify(auth)}`),
  ].join("\n\n");
}
