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
import type { ZodRawShape } from "zod";

/** A tool that exists only on the Claude side (phase-28 B2 / C2). Carried as
 *  descriptor + Zod shape together because `tool()` wants a Zod raw shape
 *  while the descriptor's `inputSchema` is JSON Schema for the codex bridge;
 *  keeping the pair with the tool beats restating every new tool's fields
 *  inside this file. Passed in rather than read off InterAgentTool because
 *  codex spreads that same list into its stdio bridge (codex/src/cli.ts). */
export interface ClaudeOnlyTool {
  descriptor: ToolDescriptor;
  inputShape: ZodRawShape;
}

/** The exact tool set the kaoiro MCP server exposes, in registration order.
 *  Split out from `buildKaoiroMcpServer` so the composition — in particular
 *  "a Claude-only tool appears only when the caller passes it" — is
 *  assertable without reaching into the SDK server's private registry. */
export function kaoiroToolDescriptors(
  interAgent: InterAgentTool,
  claudeOnly: ClaudeOnlyTool[] = [],
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
  return [send, list, whoami, ...claudeOnly.map((t) => t.descriptor)];
}

/** Builds the SDK MCP server config to pass via Options.mcpServers.
 *  Registers `send_to_agent` (broker-gated via canUseTool), `list_agents`
 *  and `whoami` (auto-allow, read-only), plus whatever Claude-only tools the
 *  caller supplies (`request_compact`, `request_session_reset`).
 *  ask_user_question is NOT registered here — Claude keeps its native tool
 *  (ADR-0032 F6). */
export function buildKaoiroMcpServer(
  interAgent: InterAgentTool,
  claudeOnly: ClaudeOnlyTool[] = [],
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
      ...claudeOnly.map((t) =>
        tool(
          t.descriptor.name,
          t.descriptor.description,
          t.inputShape,
          (args) => t.descriptor.handler(args),
        ),
      ),
    ],
  });
}
