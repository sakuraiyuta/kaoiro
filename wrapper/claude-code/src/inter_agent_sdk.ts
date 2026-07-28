// Claude-side translation of the common inter-agent tools (ADR-0032 F5):
// wraps the shared InterAgentTool handlers in the SDK's `tool()` helper and
// an in-process MCP server. The definitions + handlers live in
// @kaoiro/agent-common; this file only owns the SDK registration, so a tool
// change never touches two implementations.

import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import {
  SEND_TO_AGENT_INPUT_SHAPE,
  type InterAgentTool,
  type ToolDescriptor,
} from "@kaoiro/agent-common";
import { z } from "zod";

/** The exact tool set the kaoiro MCP server exposes, in registration order.
 *  Split out from `buildKaoiroMcpServer` so the composition — in particular
 *  "request_compact appears only when the caller passes it" — is assertable
 *  without reaching into the SDK server's private registry. */
export function kaoiroToolDescriptors(
  interAgent: InterAgentTool,
  requestCompact?: ToolDescriptor,
): ToolDescriptor[] {
  const byName = new Map(
    interAgent.descriptors().map((d) => [d.name, d] as const),
  );
  const send = byName.get("send_to_agent");
  const list = byName.get("list_agents");
  const whoami = byName.get("whoami");
  if (!send || !list || !whoami) {
    throw new Error("inter-agent descriptors missing a required tool");
  }
  return requestCompact === undefined
    ? [send, list, whoami]
    : [send, list, whoami, requestCompact];
}

/** Builds the SDK MCP server config to pass via Options.mcpServers.
 *  Registers `send_to_agent` (broker-gated via canUseTool), `list_agents`
 *  and `whoami` (auto-allow, read-only), plus `request_compact` when the
 *  caller supplies its descriptor (phase-28 B2 — Claude-only, so it is
 *  passed in rather than read off InterAgentTool, which codex shares).
 *  ask_user_question is NOT registered here — Claude keeps its native tool
 *  (ADR-0032 F6). */
export function buildKaoiroMcpServer(
  interAgent: InterAgentTool,
  requestCompact?: ToolDescriptor,
): McpSdkServerConfigWithInstance {
  const [send, list, whoami] = kaoiroToolDescriptors(interAgent) as [
    ToolDescriptor,
    ToolDescriptor,
    ToolDescriptor,
  ];
  return createSdkMcpServer({
    name: "kaoiro",
    tools: [
      // The Zod shape is the schema SSOT; the descriptor handler re-validates
      // with the same schema, so both engines enforce identical inputs.
      tool(send.name, send.description, SEND_TO_AGENT_INPUT_SHAPE, (args) =>
        send.handler(args),
      ),
      tool(list.name, list.description, {}, () => list.handler({})),
      tool(whoami.name, whoami.description, {}, () => whoami.handler({})),
      ...(requestCompact === undefined
        ? []
        : [
            tool(
              requestCompact.name,
              requestCompact.description,
              // Mirrors REQUEST_COMPACT_INPUT_SCHEMA; `tool()` wants a Zod
              // raw shape, so the one optional field is restated here rather
              // than converting JSON Schema at runtime.
              { reason: z.string().optional() },
              (args) => requestCompact.handler(args),
            ),
          ]),
    ],
  });
}
