// Inter-agent messaging — the engine-agnostic definitions + handlers of the
// kaoiro inter-agent tools (`send_to_agent` / `list_agents` / `whoami`),
// living on the common tool description layer (ADR-0032 F5): the Claude
// adapter translates them to an in-process SDK MCP server, the codex
// adapter serves them through its bundled stdio MCP bridge. Also formats
// inbound messages for engine-input injection
// (specs/protocol-inter-agent.md, plans/phase-8 Stage B).
//
// On Claude the full tool name surfaced to the model is
// `mcp__kaoiro__send_to_agent`, which is not in the wrapper's read-only
// allowedTools default, so the SDK invokes canUseTool — and the
// PermissionBroker runs the operator's per-call approval dialog (Phase 1:
// 都度承認). On codex there is no approval path (ADR-0033 F3); the call
// runs like any other MCP tool.
//
// conversation_id is the model's free-form thread key: omit it to start a new
// conversation (UUIDv4 is allocated here); pass it back when replying to keep
// turns inside one conversation. turn_number is monotonic per conversation
// (server tracks them for the hard limits).

import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { DirectoryEntry } from "@kaoiro/wrapper-core";
import { clipText } from "./logpayload.js";
import { makeInterAgentMessage } from "./state.js";
import type { ToolDescriptor, ToolResult } from "./tooling.js";
import type {
  Envelope,
  EngineKind,
  InterAgentErrorPayload,
  InterAgentMessageKind,
  InterAgentMessagePayload,
  KaoiroState,
  ModelSource,
  PermissionAxesExt,
  WrapperConfig,
} from "./types.js";

/** Self-identity snapshot returned by the `whoami` tool. Mirrors
 *  `AgentHost#statusSnapshot()` — see host.ts for field semantics. */
export interface WhoamiSnapshot {
  agent_id: string;
  persona: { id: string; name: string; sprite_set: string };
  state: KaoiroState;
  engine?: EngineKind;
  model?: string;
  effort?: string;
  model_source?: ModelSource;
  effort_source?: ModelSource;
  permission?: PermissionAxesExt;
  network_access?: boolean;
  cwd?: string;
  permission_mode?: string;
  fast_mode?: string;
  session_id?: string;
}

/** The common ToolResult shape (tooling.ts); alias kept so the existing
 *  method signatures and tests read unchanged. */
type InterAgentToolResult = ToolResult;

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

/** Recommended sender-side action per error code (issue #131 design
 *  decision). Shared verbatim between TOOL_DESCRIPTION and
 *  formatInboundMessage()'s error-notice line so both surfaces agree. Codes
 *  outside this table (open vocabulary) fall back to a generic caution. */
const ERROR_CODE_GUIDANCE: Readonly<Record<string, string>> = {
  rate_limit: "wait before retrying",
  context_overflow:
    "retrying is pointless — summarize the context or escalate to the operator",
  api_error: "retry at most once",
  timeout: "the peer may still be mid-turn — wait before retrying",
  interrupted: "confirm the peer's state before retrying",
  disconnected: "the peer is unreachable — do not retry, escalate to the operator",
};

const DEFAULT_ERROR_GUIDANCE = "confirm the peer's state before retrying";

/** One-line action hint for an error code, used in the async inbound notice
 *  text (issue #131). */
function errorGuidance(code: string): string {
  return ERROR_CODE_GUIDANCE[code] ?? DEFAULT_ERROR_GUIDANCE;
}

const ERROR_CODE_GUIDANCE_SUMMARY = Object.entries(ERROR_CODE_GUIDANCE)
  .map(([code, guidance]) => `${code} = ${guidance}`)
  .join("; ");

/** Adapter-supplied classification input for issue #131's error-notice
 *  vocabulary (ADR-0032 F5: agent-common owns the classification rule,
 *  engine adapters supply what they know). `reason` is an engine-reported
 *  machine-readable tag when the adapter has one (e.g. Claude's
 *  SDKResultMessage.terminal_reason); `detail` is a free-form human-readable
 *  message. Used verbatim (length-clipped) as the notice message, and
 *  keyword-sniffed when `reason` does not resolve to a known code. */
export interface InterAgentErrorClassifyInput {
  reason?: string;
  detail?: string;
}

const RATE_LIMIT_REASONS = new Set(["blocking_limit", "rapid_refill_breaker"]);
const CONTEXT_OVERFLOW_REASONS = new Set(["prompt_too_long"]);
const INTERRUPTED_REASONS = new Set(["aborted_streaming", "aborted_tools", "interrupted"]);
const TIMEOUT_REASONS = new Set(["timeout"]);

/** Keyword fallback for engines that expose only a free-form error string
 *  (e.g. Codex's ThreadError.message, which carries no structured reason) —
 *  best-effort, deliberately narrow to avoid false positives. */
function classifyByDetailKeywords(detail: string): string | null {
  const lower = detail.toLowerCase();
  if (/rate.?limit|too many requests|\b429\b/.test(lower)) return "rate_limit";
  if (/context (window|length)|prompt too long|token limit/.test(lower)) {
    return "context_overflow";
  }
  return null;
}

/** Maps adapter-reported engine error info to the open error-code vocabulary
 *  (issue #131: rate_limit / context_overflow / api_error / timeout /
 *  interrupted / disconnected). Unrecognized input degrades to "api_error"
 *  per the design decision — "disconnected" is intentionally never produced
 *  here since only the server can observe a wrapper disconnect. */
export function classifyInterAgentError(
  input: InterAgentErrorClassifyInput,
): InterAgentErrorPayload {
  const message = clipText(input.detail ?? input.reason ?? "unknown error").text;
  const reason = input.reason;
  if (reason !== undefined) {
    if (RATE_LIMIT_REASONS.has(reason)) return { code: "rate_limit", message };
    if (CONTEXT_OVERFLOW_REASONS.has(reason)) {
      return { code: "context_overflow", message };
    }
    if (INTERRUPTED_REASONS.has(reason)) return { code: "interrupted", message };
    if (TIMEOUT_REASONS.has(reason)) return { code: "timeout", message };
    if (reason === "api_error") return { code: "api_error", message };
  }
  if (input.detail !== undefined) {
    const byKeyword = classifyByDetailKeywords(input.detail);
    if (byKeyword) return { code: byKeyword, message };
  }
  return { code: "api_error", message };
}

/** Default wait chosen for synchronous peer collaboration. Callers may raise
 * it to the master-approved hard maximum below for a long-running peer. */
const DEFAULT_REPLY_TIMEOUT_MS = 300_000;
const MAX_REPLY_TIMEOUT_MS = 300_000;

/** Zod raw shape of send_to_agent's input — the SSOT the Claude adapter
 *  hands to the SDK's `tool()` helper and from which the JSON Schema for
 *  the codex bridge is derived (z.toJSONSchema). */
export const SEND_TO_AGENT_INPUT_SHAPE = {
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
  wait_for_response: z
    .boolean()
    .optional()
    .describe(
      "Wait for the next inbound message in this conversation and return it from this tool call. Defaults to false.",
    ),
  timeout_ms: z
    .number()
    .int()
    .positive()
    .max(MAX_REPLY_TIMEOUT_MS)
    .optional()
    .describe(
      "Maximum synchronous wait in milliseconds when wait_for_response=true (default and maximum 300000).",
    ),
};

/** Compiled Zod object for validation + JSON Schema derivation. */
const SEND_TO_AGENT_SCHEMA = z.object(SEND_TO_AGENT_INPUT_SHAPE);

/** JSON Schema for the zero-argument tools. */
const EMPTY_OBJECT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

const TOOL_DESCRIPTION =
  `Send a structured message to another kaoiro agent (consult, delegate, propose, accept, reject, or end the conversation). This IS the reply mechanism for inter-agent conversations — when you have a message for another agent, call this directly. Pass \`conversation_id\` back on replies to keep turns grouped; omit it to start a new conversation. The wrapper assigns turn_number automatically. Set wait_for_response=true only when the current turn needs the peer's next reply: its full envelope is returned by this same tool call; timeout returns a non-destructive reply_pending acknowledgement. If the peer became unresponsive instead of replying (rate limit, context overflow, API error, timeout, interrupt, or disconnect), the result carries \`peer_error: {code, message, from}\` instead of \`reply\` — recommended action by code: ${ERROR_CODE_GUIDANCE_SUMMARY}. The same \`peer_error\` can also arrive asynchronously as an inbound inform message when you were not waiting. The \`to\` field MUST be an exact agent_id — if you only know a peer by their display name, call \`list_agents\` first to resolve it; when several peers share a name, ask the operator which one to address. If no peer matches a requested name, report that — do not spawn a same-named agent as a substitute, and do not claim a collaboration/investigation happened until send_to_agent has actually delivered and a reply returned.`;

const LIST_AGENTS_DESCRIPTION =
  "List other kaoiro agents currently known to the server. Returns each peer's agent_id, persona (id/name/sprite_set), current state (idle / thinking / tool_running / waiting_permission / waiting_input / done / error / disconnected), and engine/model/effort when reported. Use this to resolve a peer's display name and execution traits before calling send_to_agent. The calling agent is NOT included — call whoami for self-info. When multiple peers share a display name, ask the operator which one to address. A proper-name collaboration request refers to an existing kaoiro peer — resolve it here first: 1 match → send_to_agent, several → ask the operator, 0 matches → report the persona is absent and never spawn a same-named internal sub-agent as a substitute.";

const WHOAMI_DESCRIPTION =
  "Return this agent's identity from the kaoiro server's perspective: agent_id, persona (id/name/sprite_set), current state, engine, effective model/effort and their sources, engine-neutral permission (sandbox/approval), network_access, legacy permission_mode/fast_mode when applicable, session_id, and working directory. Fields that the SDK has not yet reported are omitted. Use this to confirm what the operator sees you as, or to self-narrate (e.g., when telling a peer who you are).";

interface ConversationTrack {
  /** Highest turn_number observed so far in this conversation. */
  turnNumber: number;
}

interface ReplyWaiter {
  resolve: (envelope: Envelope | undefined) => void;
  timeout: ReturnType<typeof setTimeout>;
}

/** One inbound inter-agent message injected into the SDK as ordinary user
 *  input (cli.ts's formatInboundMessage branch), still awaiting an outbound
 *  reply on the same conversation_id (issue #131). */
interface PendingInjection {
  /** agent_id of the envelope that was injected — the notice's addressee. */
  from: string;
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
  readonly #replyWaiters = new Map<string, ReplyWaiter>();
  readonly #pendingInjections = new Map<string, PendingInjection>();

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

  /** Handles an inbound envelope before the CLI schedules normal next-turn
   * injection. A matching synchronous waiter consumes exactly one reply, so
   * its body/meta reaches the current tool result instead of being injected a
   * second time on the SDK's next turn. Returns true only when consumed. */
  receiveInbound(envelope: Envelope): boolean {
    const payload = envelope.payload as Partial<InterAgentMessagePayload>;
    if (
      typeof payload.conversation_id !== "string" ||
      typeof payload.turn_number !== "number"
    ) {
      return false;
    }

    this.observeInbound(payload.conversation_id, payload.turn_number);
    const waiter = this.#replyWaiters.get(payload.conversation_id);
    if (!waiter) return false;

    this.#replyWaiters.delete(payload.conversation_id);
    clearTimeout(waiter.timeout);
    waiter.resolve(envelope);
    return true;
  }

  /** Records that an inbound inter-agent message is about to be injected
   *  into the SDK as ordinary user input (cli.ts's formatInboundMessage
   *  branch — i.e. `receiveInbound` did NOT consume it as a waiter reply),
   *  so this wrapper now owes a reply on the conversation. Called by cli.ts
   *  right before it queues the injection. If the resulting SDK turn ends in
   *  error before an outbound reply clears the entry (see `invoke()`),
   *  `drainPendingErrorNotices()` surfaces it back to the sender (issue
   *  #131). */
  notePendingInjection(envelope: Envelope): void {
    const payload = envelope.payload as Partial<InterAgentMessagePayload>;
    if (typeof payload.conversation_id !== "string") return;
    this.#pendingInjections.set(payload.conversation_id, {
      from: envelope.agent_id,
    });
  }

  /** Called by cli.ts when an SDK turn ends with is_error=true. Snapshots and
   *  clears every conversation still owed a reply (issue #131), and returns
   *  one error-notice envelope per conversation addressed back to the
   *  original sender — kind="inform" (no new enum value), meta.done=false
   *  (ending the conversation is the sender's call), payload.error set.
   *  Callers push the result straight through ServerLink#send: this notice
   *  did not come from a model tool call (the turn just failed to produce
   *  one), so it bypasses the broker entirely. Clearing on drain means a
   *  later, fresh injection on the same conversation_id gets its own
   *  independent notice instead of re-firing on every subsequent turn error. */
  drainPendingErrorNotices(error: InterAgentErrorPayload): Envelope[] {
    if (this.#pendingInjections.size === 0) return [];
    const pending = [...this.#pendingInjections];
    this.#pendingInjections.clear();
    return pending.map(([conversationId, injection]) => {
      const track = this.#conversations.get(conversationId) ?? {
        turnNumber: 0,
      };
      track.turnNumber += 1;
      this.#conversations.set(conversationId, track);
      const payload: InterAgentMessagePayload = {
        to: injection.from,
        conversation_id: conversationId,
        turn_number: track.turnNumber,
        kind: "inform",
        body: `peer error (${error.code}): ${error.message}`,
        meta: { done: false, propose_next: "" },
        owner: { kind: "user", id: "operator" },
        error,
      };
      return makeInterAgentMessage(
        this.#options.config,
        this.#options.getState(),
        this.#now(),
        payload,
      );
    });
  }

  /** The engine-agnostic descriptors of the three tools (ADR-0032 F5):
   *  `send_to_agent` (Claude: broker-gated via canUseTool), `list_agents`
   *  and `whoami` (read-only, auto-allow). The Claude adapter translates
   *  them via the SDK's `tool()` helper (inter_agent_sdk.ts); the codex
   *  adapter serves them through the stdio MCP bridge. Handler inputs are
   *  re-validated here with the same Zod schema, since bridge-side clients
   *  do not enforce inputSchema. */
  descriptors(): ToolDescriptor[] {
    return [
      {
        name: "send_to_agent",
        description: TOOL_DESCRIPTION,
        inputSchema: z.toJSONSchema(SEND_TO_AGENT_SCHEMA, { io: "input" }),
        handler: async (input) => {
          const parsed = SEND_TO_AGENT_SCHEMA.safeParse(input);
          if (!parsed.success) {
            return errorResult(
              `send_to_agent failed: invalid input: ${parsed.error.message}`,
            );
          }
          return this.invoke(parsed.data);
        },
      },
      {
        name: "list_agents",
        description: LIST_AGENTS_DESCRIPTION,
        inputSchema: EMPTY_OBJECT_SCHEMA,
        handler: async () => this.listAgents(),
      },
      {
        name: "whoami",
        description: WHOAMI_DESCRIPTION,
        inputSchema: EMPTY_OBJECT_SCHEMA,
        handler: async () => this.whoami(),
      },
    ];
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
  async invoke(
    args: z.infer<typeof SEND_TO_AGENT_SCHEMA>,
  ): Promise<InterAgentToolResult> {
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
    const waitForResponse = args.wait_for_response === true;
    if (waitForResponse && this.#replyWaiters.has(conversationId)) {
      return errorResult(
        `send_to_agent failed: a synchronous reply wait is already active for conversation_id=${conversationId}`,
      );
    }

    const track = this.#conversations.get(conversationId) ?? { turnNumber: 0 };
    track.turnNumber += 1;
    this.#conversations.set(conversationId, track);
    // receiveInbound() can advance the shared conversation track while this
    // invocation awaits a peer, but the acknowledgement must describe the
    // turn that was actually sent.
    const sentTurnNumber = track.turnNumber;

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
      turn_number: sentTurnNumber,
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

    // This wrapper is replying on the conversation, so it no longer owes an
    // error notice for whatever inbound message it was injected to answer
    // (issue #131 — see notePendingInjection/drainPendingErrorNotices).
    this.#pendingInjections.delete(conversationId);

    const timeoutMs = args.timeout_ms ?? DEFAULT_REPLY_TIMEOUT_MS;
    const reply = waitForResponse
      ? this.#waitForReply(conversationId, timeoutMs)
      : undefined;
    this.#options.send(envelope);

    const sent = `sent to ${args.to} (conversation_id=${conversationId}, turn_number=${sentTurnNumber})`;
    if (!reply) {
      return { content: [{ type: "text", text: sent }] };
    }

    const inbound = await reply;
    if (!inbound) {
      return {
        content: [
          {
            type: "text",
            text: `${sent}; reply_pending=true (timeout_ms=${timeoutMs})`,
          },
        ],
      };
    }

    const sentAck = {
      to: args.to,
      conversation_id: conversationId,
      turn_number: sentTurnNumber,
    };
    const inboundPayload = inbound.payload as Partial<InterAgentMessagePayload>;
    // issue #131: a peer-unresponsive-error notice is distinguished from an
    // ordinary reply by peer_error (not reply) so the caller can tell
    // "got a reply" apart from "the peer never got the chance to reply" —
    // both otherwise share the same wait_for_response=true return path.
    if (inboundPayload.error) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                sent: sentAck,
                peer_error: {
                  code: inboundPayload.error.code,
                  message: inboundPayload.error.message,
                  from: inbound.agent_id,
                },
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ sent: sentAck, reply: inbound }, null, 2),
        },
      ],
    };
  }

  #waitForReply(
    conversationId: string,
    timeoutMs: number,
  ): Promise<Envelope | undefined> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.#replyWaiters.delete(conversationId);
        resolve(undefined);
      }, timeoutMs);
      this.#replyWaiters.set(conversationId, { resolve, timeout });
    });
  }
}

const INTER_AGENT_MESSAGE_PREFIX =
  '[Inter-agent message — to reply, call send_to_agent with conversation_id="';

/** True only for the reserved first-line framing injected into an SDK turn.
 *  Do not trim: an operator quoting the marker later in ordinary text must
 *  remain an ordinary user log during resume reconstruction (#105). */
export function isFormattedInterAgentMessage(text: string): boolean {
  return text.startsWith(INTER_AGENT_MESSAGE_PREFIX);
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
  const error = payload.error;
  // issue #131: an error notice gets its own line format — a plain
  // "kind: body" render would bury the machine-readable code the receiving
  // model needs to decide whether retrying is worthwhile.
  const messageLine = error
    ? `[from ${from}] peer-error(${error.code}): ${error.message} — ${errorGuidance(error.code)}.`
    : `[from ${from}] ${kind}: ${body}`;
  return [
    `${INTER_AGENT_MESSAGE_PREFIX}${conversationId}".]`,
    "",
    messageLine,
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
