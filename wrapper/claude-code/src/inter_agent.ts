// Inter-agent messaging — registers the `send_to_agent` SDK MCP tool that an
// agent calls to message another agent, and formats inbound messages for
// SDK-input injection (specs/protocol-inter-agent.md, plans/phase-8 Stage B).
//
// The full tool name surfaced to the model is `mcp__kaoiro__send_to_agent`,
// which is not in the wrapper's read-only allowedTools default, so the SDK
// invokes canUseTool — and the PermissionBroker runs the operator's per-call
// approval dialog (Phase 1: 都度承認).
//
// conversation_id is the model's free-form thread key: omit it to start a new
// conversation (UUIDv4 is allocated here); pass it back when replying to keep
// turns inside one conversation. turn_number is monotonic per conversation
// (server tracks them for the hard limits).

import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import { makeInterAgentMessage } from "@kaoiro/agent-common";
import type { DirectoryEntry } from "@kaoiro/wrapper-core";
import type {
  Envelope,
  InterAgentMessageKind,
  InterAgentMessagePayload,
  KaoiroState,
  WrapperConfig,
} from "@kaoiro/agent-common";

/** Self-identity snapshot returned by the `whoami` tool. Mirrors
 *  `AgentHost#statusSnapshot()` — see host.ts for field semantics. */
export interface WhoamiSnapshot {
  agent_id: string;
  persona: { id: string; name: string; sprite_set: string };
  state: KaoiroState;
  model?: string;
  cwd?: string;
  permission_mode?: string;
  fast_mode?: string;
  session_id?: string;
}

/** Minimal structural shape of the MCP CallToolResult we actually return; the
 *  agent-sdk's `tool()` helper expects the upstream CallToolResult type from
 *  `@modelcontextprotocol/sdk`, which is a transitive (not declared) dep —
 *  declaring a local subset avoids pulling the runtime just for this typing.
 *  The index signature mirrors the upstream type so structural assignability
 *  holds without an explicit cast. */
interface InterAgentToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  [extra: string]: unknown;
}

/** Full SDK-side tool name once mcpServers register the kaoiro server. */
export const INTER_AGENT_TOOL_FQN = "mcp__kaoiro__send_to_agent";

/** Companion tools that resolve peer names and self-identity. Both are
 *  read-only / no-side-effect and meant for the wrapper's default
 *  allowedTools (auto-allow, no broker dialog). */
export const LIST_AGENTS_TOOL_FQN = "mcp__kaoiro__list_agents";
export const WHOAMI_TOOL_FQN = "mcp__kaoiro__whoami";

const KIND_VALUES = [
  "request",
  "response",
  "query",
  "inform",
  "propose",
  "accept",
  "reject",
  "escalate-to-user",
  "done",
] as const satisfies readonly InterAgentMessageKind[];

const INPUT_SCHEMA = {
  to: z
    .string()
    .min(1)
    .describe("Destination agent_id, e.g. 'lab-pc-1.claude-b'"),
  body: z
    .string()
    .min(1)
    .describe("Message body text. The other side reads it verbatim."),
  kind: z
    .enum(KIND_VALUES)
    .describe(
      "Message kind. request/response = task delegation; query/inform = consultation; propose/accept/reject = discussion; escalate-to-user = hand off to the human owner; done = end the conversation.",
    ),
  conversation_id: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Conversation id from a prior message in this thread. Omit to start a new conversation; the wrapper allocates one and returns it. Pass an empty string is a schema error — omit the field instead.",
    ),
  done: z
    .boolean()
    .optional()
    .describe(
      "True when YOU propose ending the conversation. Both sides must set done=true for the conversation to actually end.",
    ),
  propose_next: z
    .string()
    .optional()
    .describe(
      "What you expect to happen next, in one sentence. Empty allowed.",
    ),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe("Optional 0.0-1.0 confidence."),
  reject_reason: z
    .string()
    .optional()
    .describe(
      "Required when kind=reject; concrete reason for refusing the proposal.",
    ),
};

const TOOL_DESCRIPTION =
  "Send a structured message to another kaoiro agent (consult, delegate, propose, accept, reject, or end the conversation). This IS the reply mechanism for inter-agent conversations — when you have a message for another agent, call this directly. Pass `conversation_id` back on replies to keep turns grouped; omit it to start a new conversation. The wrapper assigns turn_number automatically. The `to` field MUST be an exact agent_id — if you only know a peer by their display name, call `list_agents` first to resolve it; when several peers share a name, ask the operator which one to address.";

const LIST_AGENTS_DESCRIPTION =
  "List other kaoiro agents currently known to the server. Returns each peer's agent_id, persona (id/name/sprite_set), and current state (idle / thinking / tool_running / waiting_permission / waiting_input / done / error / disconnected). Use this to resolve a peer's display name to an agent_id before calling send_to_agent. The calling agent is NOT included — call whoami for self-info. When multiple peers share a display name, ask the operator which one to address.";

const WHOAMI_DESCRIPTION =
  "Return this agent's identity from the kaoiro server's perspective: agent_id, persona (id/name/sprite_set), current state, active model, permission_mode, fast_mode, session_id, and working directory. Fields that the SDK has not yet reported are omitted. Use this to confirm what the operator sees you as, or to self-narrate (e.g., when telling a peer who you are).";

interface ConversationTrack {
  /** Highest turn_number observed so far in this conversation. */
  turnNumber: number;
}

export interface InterAgentToolOptions {
  config: WrapperConfig;
  /** Current wrapper state — stamped onto the outer envelope frame. */
  getState: () => KaoiroState;
  /** Outbound envelope sink, normally ServerLink#send. */
  send: (envelope: Envelope) => void;
  /** Peer directory provider, normally `ServerLink#requestDirectory` bound
   *  to the wrapper's channel. Omitting it (unit tests only — production
   *  always supplies it under ADR-0029 F10) makes `list_agents` return
   *  an error result. */
  requestDirectory?: () => Promise<DirectoryEntry[]>;
  /** Self-identity provider, normally `AgentHost#statusSnapshot`. Omitting
   *  it (unit tests only) makes `whoami` fall back to the wrapper config
   *  (no live SDK fields). */
  getWhoami?: () => WhoamiSnapshot;
  /** ISO timestamp source; injectable for tests. */
  now?: () => string;
  /** conversation_id source for new conversations; injectable for tests. */
  newId?: () => string;
}

/**
 * Owns the send_to_agent tool registration and the per-conversation turn
 * counter. One instance per wrapper; safe across concurrent send / receive
 * (single-threaded JS event loop, no internal awaits between read+write).
 */
export class InterAgentTool {
  readonly #options: InterAgentToolOptions;
  readonly #now: () => string;
  readonly #newId: () => string;
  readonly #conversations = new Map<string, ConversationTrack>();

  constructor(options: InterAgentToolOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#newId = options.newId ?? randomUUID;
  }

  /** Records the turn_number of an inbound message so subsequent outbound
   *  turns stay monotonic per conversation regardless of which side authored
   *  the latest message. Called by cli.ts when the host injects an incoming
   *  inter_agent_message into the SDK input. */
  observeInbound(conversationId: string, turnNumber: number): void {
    const track = this.#conversations.get(conversationId) ?? { turnNumber: 0 };
    if (turnNumber > track.turnNumber) track.turnNumber = turnNumber;
    this.#conversations.set(conversationId, track);
  }

  /** Builds the SDK MCP server config to pass via Options.mcpServers.
   *  Registers three tools: `send_to_agent` (broker-gated), `list_agents`
   *  (auto-allow, peer directory), `whoami` (auto-allow, self snapshot). */
  build(): McpSdkServerConfigWithInstance {
    return createSdkMcpServer({
      name: "kaoiro",
      tools: [
        tool("send_to_agent", TOOL_DESCRIPTION, INPUT_SCHEMA, async (args) =>
          this.invoke(args),
        ),
        tool("list_agents", LIST_AGENTS_DESCRIPTION, {}, async () =>
          this.listAgents(),
        ),
        tool("whoami", WHOAMI_DESCRIPTION, {}, async () => this.whoami()),
      ],
    });
  }

  /** Fetches the peer directory via the configured provider. Returns the
   *  JSON list as a tool-shaped text result so the model can read it. */
  async listAgents(): Promise<InterAgentToolResult> {
    const provider = this.#options.requestDirectory;
    if (!provider) {
      return errorResult(
        "list_agents unavailable: wrapper is not connected to a server",
      );
    }
    try {
      const agents = await provider();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ agents }, null, 2),
          },
        ],
      };
    } catch (err) {
      return errorResult(`list_agents failed: ${String(err)}`);
    }
  }

  /** Returns this wrapper's identity snapshot. Falls back to the wrapper
   *  config when no live host status provider is wired (e.g. early in
   *  startup, before the SDK session opens). */
  whoami(): InterAgentToolResult {
    const snapshot = this.#options.getWhoami?.() ?? {
      agent_id: this.#options.config.agent_id,
      persona: this.#options.config.persona,
      state: this.#options.getState(),
    };
    return {
      content: [{ type: "text", text: JSON.stringify(snapshot, null, 2) }],
    };
  }

  /** Direct entry point used by the SDK MCP handler and by tests. Validates
   *  the spec invariants (self-routing, reject_reason required), allocates a
   *  conversation_id and turn_number, builds the envelope, and pushes it via
   *  `send`. The CallToolResult-shaped return surfaces back to the calling
   *  model as the tool result. */
  async invoke(args: z.infer<z.ZodObject<typeof INPUT_SCHEMA>>): Promise<InterAgentToolResult> {
    if (args.to === this.#options.config.agent_id) {
      return errorResult(
        "send_to_agent failed: cannot send to self (payload.to == agent_id)",
      );
    }
    if (
      args.kind === "reject" &&
      (args.reject_reason === undefined || args.reject_reason === "")
    ) {
      return errorResult(
        "send_to_agent failed: meta.reject_reason is required when kind=reject",
      );
    }

    const conversationId = args.conversation_id ?? this.#newId();
    const track = this.#conversations.get(conversationId) ?? { turnNumber: 0 };
    track.turnNumber += 1;
    this.#conversations.set(conversationId, track);

    const meta: InterAgentMessagePayload["meta"] = {
      done: args.done ?? false,
      propose_next: args.propose_next ?? "",
    };
    if (args.confidence !== undefined) meta.confidence = args.confidence;
    if (args.reject_reason !== undefined && args.reject_reason !== "") {
      meta.reject_reason = args.reject_reason;
    }

    const payload: InterAgentMessagePayload = {
      to: args.to,
      conversation_id: conversationId,
      turn_number: track.turnNumber,
      kind: args.kind,
      body: args.body,
      meta,
      owner: { kind: "user", id: "operator" },
    };

    const envelope = makeInterAgentMessage(
      this.#options.config,
      this.#options.getState(),
      this.#now(),
      payload,
    );
    this.#options.send(envelope);

    return {
      content: [
        {
          type: "text",
          text: `sent to ${args.to} (conversation_id=${conversationId}, turn_number=${track.turnNumber})`,
        },
      ],
    };
  }
}

/** Formats an inbound inter_agent_message envelope into the user-message text
 *  injected into the receiving wrapper's SDK input (protocol-inter-agent spec
 *  「受信側 (wrapper-B) の挙動」). Leads with a role directive so the model
 *  treats this as an inter-agent reply context — without it, models tend to
 *  pause and ask the human operator "should I respond with X?" before each
 *  send, which doubles the operator's workload (the broker already gates
 *  each send via its own permission dialog). Resilient to a malformed
 *  envelope (e.g. the server-synthesized escalate skeleton) — missing
 *  fields collapse to empty. */
export function formatInboundMessage(envelope: Envelope): string {
  const payload = envelope.payload as Partial<InterAgentMessagePayload>;
  const from = envelope.agent_id;
  const kind = payload.kind ?? "inform";
  const body = payload.body ?? "";
  const done = payload.meta?.done === true;
  const proposeNext = payload.meta?.propose_next ?? "";
  const conversationId = payload.conversation_id ?? "";
  const turnNumber = payload.turn_number ?? 0;
  return [
    `[Inter-agent message — to reply, call send_to_agent with conversation_id="${conversationId}".]`,
    "",
    `[from ${from}] ${kind}: ${body}`,
    "",
    `(meta: done=${done}, propose_next=${proposeNext}, conversation_id=${conversationId}, turn_number=${turnNumber})`,
  ].join("\n");
}

function errorResult(text: string): InterAgentToolResult {
  return {
    content: [{ type: "text", text }],
    isError: true,
  };
}
