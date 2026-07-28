// `request_compact` — the agent-initiated context-recovery tool (phase-28 B2,
// #168). Lives beside the inter-agent tools on the same in-process `kaoiro`
// MCP server, but deliberately NOT inside InterAgentTool#descriptors(): codex
// builds its stdio bridge from that same list (codex/src/cli.ts), and codex
// has no `/compact` path. Keeping the descriptor here makes "Claude only" a
// structural fact rather than a conditional someone can drop.
//
// Approval: the full SDK-side name `mcp__kaoiro__request_compact` is absent
// from the wrapper's auto-allow default (cli.ts READ_ONLY_TOOLS), so the SDK
// routes the call through canUseTool and the PermissionBroker runs the
// operator's per-call dialog — the same都度承認 path send_to_agent uses
// (ADR-0028 D4 / #168 決定 P2). This handler therefore runs ONLY after the
// operator allowed it; a denial never reaches here (the SDK returns its deny
// message to the model instead).
//
// Track S measured that a `/compact` string sent on the streaming input is
// interpreted as a slash command, and that a manual compact takes ~13.7 s.
// So the tool reserves the compaction rather than awaiting it: completion is
// observed through the Phase A `compact_boundary` log line, not here.

import type { ToolDescriptor, ToolResult } from "@kaoiro/agent-common";

/** Full SDK-side tool name once mcpServers register the kaoiro server. */
export const REQUEST_COMPACT_TOOL_FQN = "mcp__kaoiro__request_compact";

/** The exact text queued on the SDK input stream. A fixed literal: the
 *  model's `reason` is shown to the operator in the approval dialog and
 *  echoed in the tool result, but never concatenated into the injected turn
 *  — the tool must not become a way to put arbitrary model-authored text on
 *  the input stream. */
export const COMPACT_COMMAND = "/compact";

const REQUEST_COMPACT_DESCRIPTION =
  "Ask the operator to approve compacting this session's context. On approval the wrapper queues `/compact`, which runs at the next turn boundary and replaces the older conversation with a summary; the call returns as soon as the compaction is RESERVED, not when it finishes (it takes on the order of ten seconds, and the transcript shows a completion line with the before/after token counts). Use this when you have judged that context headroom is actually limiting the work — after a long session, or before taking on a large task — not as routine hygiene. The operator may decline, in which case carry on as you were. Anything you still need after the compaction should be written down first (a file, an issue, a message to a peer): a compaction summarizes and drops detail, and nothing restores it.";

const REQUEST_COMPACT_INPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    reason: {
      type: "string",
      description:
        "One sentence on why compaction is warranted now. Shown to the operator in the approval dialog.",
    },
  },
  additionalProperties: false,
};

export interface RequestCompactOptions {
  /** Queues a turn on the engine input stream, normally `AgentHost#send`.
   *  Its own serialization is what keeps the injected `/compact` from
   *  landing mid-turn (ADR-0036 F6: no automatic interrupt). */
  send: (text: string) => Promise<void>;
}

/** The `request_compact` descriptor. Registered by the Claude adapter's
 *  `buildKaoiroMcpServer`; codex never sees it. */
export function requestCompactDescriptor(
  options: RequestCompactOptions,
): ToolDescriptor {
  return {
    name: "request_compact",
    description: REQUEST_COMPACT_DESCRIPTION,
    inputSchema: REQUEST_COMPACT_INPUT_SCHEMA,
    handler: async (input) => {
      const reason =
        typeof input.reason === "string" ? input.reason.trim() : "";
      try {
        await options.send(COMPACT_COMMAND);
      } catch (err) {
        // The queue is closed or full. Fail loudly rather than reporting a
        // reservation the wrapper did not make — the model would otherwise
        // wait for a compaction that is never coming.
        return errorResult(`request_compact failed: ${String(err)}`);
      }
      const because = reason === "" ? "" : ` (reason: ${reason})`;
      return {
        content: [
          {
            type: "text",
            text:
              `compaction reserved${because}. It runs at the next turn ` +
              "boundary; the transcript reports completion with the " +
              "before/after token counts. Nothing further is needed from you.",
          },
        ],
      };
    },
  };
}

function errorResult(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}
