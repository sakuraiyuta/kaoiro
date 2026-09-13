// Operator approval gate for tool handlers on engines that have no
// canUseTool hook (ADR-0043 Neutral amendment, issue #347). The Claude SDK
// asks the operator BEFORE it invokes a "heavy" MCP tool; codex auto-approves
// every kaoiro bridge tool (`default_tools_approval_mode: "approve"`), so
// the handler has to ask on its own behalf. This decorator does that with
// the same PermissionBroker the Claude path uses, which means the operator
// sees one dialog shape regardless of engine.
//
// The wrapped handler runs only after an explicit allow. Everything else —
// deny, timeout, a call abandoned by its turn (`context.signal`) — returns
// an error result and never touches the wrapped handler, so a reservation
// with an effect that outlives the call (a session reset) cannot be created
// for a call the model no longer owns.

import type { PermissionDecision } from "./permission.js";
import type {
  ToolDescriptor,
  ToolHandlerContext,
  ToolResult,
} from "./tooling.js";

export interface ApprovalGateOptions {
  /** Asks the operator; normally `PermissionBroker#decide`. Receives the
   *  call's lifetime signal so a late answer cannot resolve a dead call. */
  decide: (
    toolName: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<PermissionDecision>;
  /** Name shown in the operator's dialog. Defaults to the descriptor's
   *  bare name; Claude reports its SDK-side FQN, so passing the same FQN
   *  keeps the dialog identical across engines. */
  toolName?: string;
  /** Runs BEFORE the operator is asked. A rejected input fails the call
   *  without a dialog: the bridge hands inputs to handlers unvalidated, and
   *  an oversized or malformed input would otherwise reach the dialog
   *  truncated or reserve nothing after the operator already said yes. */
  validate?: (
    input: Record<string, unknown>,
  ) => { ok: true } | { ok: false; message: string };
}

/** Wraps `descriptor` so its handler runs only after per-call operator
 *  approval. The name, description and schema are unchanged. */
export function operatorApprovalGated(
  descriptor: ToolDescriptor,
  options: ApprovalGateOptions,
): ToolDescriptor {
  const toolName = options.toolName ?? descriptor.name;
  return {
    ...descriptor,
    handler: async (input, context) => {
      const signal = context?.signal;
      if (signal?.aborted) return cancelled(descriptor.name);
      if (options.validate !== undefined) {
        const validation = options.validate(input);
        if (!validation.ok) {
          return errorResult(`${descriptor.name} failed: ${validation.message}`);
        }
      }
      let decision: PermissionDecision;
      try {
        decision = await options.decide(toolName, input, signal);
      } catch (err) {
        return errorResult(
          `${descriptor.name} was not approved: permission decision failed: ${String(err)}`,
        );
      }
      if (!decision.allow) {
        return errorResult(
          `${descriptor.name} was not approved by the operator` +
            (decision.message !== undefined ? `: ${decision.message}` : "") +
            ". Nothing was reserved; your context is unchanged.",
        );
      }
      // The allow may have been decided in the same task that ended the
      // turn. Re-check before acting: an effect that outlives the call must
      // not be created for a call nobody can answer any more.
      if (signal?.aborted) return cancelled(descriptor.name);
      return descriptor.handler(input, context);
    },
  };
}

function cancelled(name: string): ToolResult {
  return errorResult(
    `${name} was cancelled: the turn that made this call is no longer ` +
      "live. Nothing was reserved; your context is unchanged.",
  );
}

function errorResult(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}
