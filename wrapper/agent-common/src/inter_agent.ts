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
import type {
  DirectoryContext,
  DirectoryEntry,
  DirectoryResult,
  InterAgentAcceptance,
} from "@kaoiro/wrapper-core";
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
  /** Own context-window usage (phase-28 A2, #168). Same shape and semantics
   *  as the `context` a peer reads via `list_agents` (`DirectoryContext`), so
   *  the two are directly comparable — not necessarily the same instant: the
   *  peer's copy travels through the server's directory projection, so the
   *  two readings can differ transiently. The host's LAST SUCCESSFUL
   *  measurement — whoami reads the cached value and never triggers a
   *  refresh, so it can lag the current turn. Omitted — never zeroed or
   *  estimated — when the engine has not reported it (codex:
   *  `supports_context_usage: false`), so absent keeps meaning unknown. */
  context?: DirectoryContext;
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
 *  message (an SDK exception string, a raw `String(err)`, …). Neither field
 *  is ever copied into the produced notice: `detail` is used ONLY to
 *  keyword-sniff a code when `reason` does not resolve to one (security
 *  review, issue #131 must-fix 2) — ending up unstructured, untrusted text
 *  in another agent's LLM context is a materially different exposure than
 *  the operator-only display #127 relies on for the same kind of string. */
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
 *  best-effort, deliberately narrow to avoid false positives. The matched
 *  text itself is discarded; only the resulting code is kept. */
function classifyByDetailKeywords(detail: string): string | null {
  const lower = detail.toLowerCase();
  if (/rate.?limit|too many requests|\b429\b/.test(lower)) return "rate_limit";
  if (/context (window|length)|prompt too long|token limit/.test(lower)) {
    return "context_overflow";
  }
  return null;
}

/** Fixed, safe notice text per error code (issue #131 must-fix 2): never the
 *  adapter's raw reason/detail, which may carry unstructured text (subprocess
 *  exception strings, SDK error text) unsafe to inject verbatim into a peer
 *  agent's LLM context. `disconnected` is documented for vocabulary parity
 *  with the server-synthesized notice even though this classifier never
 *  produces it (see classifyInterAgentError doc). */
const ERROR_CODE_MESSAGE: Readonly<Record<string, string>> = {
  rate_limit: "the peer hit a rate limit",
  context_overflow: "the peer's context window overflowed",
  api_error: "the peer reported an unspecified error",
  timeout: "the peer's turn timed out",
  interrupted: "the peer's turn was interrupted",
  disconnected: "the peer disconnected",
};
const DEFAULT_ERROR_MESSAGE = "the peer reported an unrecognized error";

/** Canonical error-code list (issue #131's initial set), derived from
 *  `ERROR_CODE_GUIDANCE` so there is exactly one place that enumerates the
 *  codes this wrapper's classifier/templates recognize. Exported for issue
 *  #134's docs-sync test (`docs/specs/protocol-inter-agent.md`'s
 *  「エラー種別コード」table): that test asserts this set,
 *  `ERROR_CODE_MESSAGE`'s key set (via `INTER_AGENT_ERROR_MESSAGE_CODES`
 *  below), and the docs table's `code` column all agree, so a code added
 *  to only one of the three is caught instead of drifting silently. */
export const INTER_AGENT_ERROR_CODES: readonly string[] = Object.keys(
  ERROR_CODE_GUIDANCE,
);
/** `ERROR_CODE_MESSAGE`'s key set, exported for the same issue #134
 *  drift check as `INTER_AGENT_ERROR_CODES` above — the two tables have
 *  no other mechanism keeping their key sets in sync with each other. */
export const INTER_AGENT_ERROR_MESSAGE_CODES: readonly string[] = Object.keys(
  ERROR_CODE_MESSAGE,
);

function messageForCode(code: string): string {
  return ERROR_CODE_MESSAGE[code] ?? DEFAULT_ERROR_MESSAGE;
}

/** Maps adapter-reported engine error info to the open error-code vocabulary
 *  (issue #131: rate_limit / context_overflow / api_error / timeout /
 *  interrupted / disconnected). Unrecognized input degrades to "api_error"
 *  per the design decision — "disconnected" is intentionally never produced
 *  here since only the server can observe a wrapper disconnect. The returned
 *  `message` is always one of the fixed ERROR_CODE_MESSAGE templates, never
 *  the raw `reason`/`detail` (must-fix 2) — those are classification input
 *  only, not notice content. */
export function classifyInterAgentError(
  input: InterAgentErrorClassifyInput,
): InterAgentErrorPayload {
  const reason = input.reason;
  if (reason !== undefined) {
    if (RATE_LIMIT_REASONS.has(reason)) {
      return { code: "rate_limit", message: messageForCode("rate_limit") };
    }
    if (CONTEXT_OVERFLOW_REASONS.has(reason)) {
      return { code: "context_overflow", message: messageForCode("context_overflow") };
    }
    if (INTERRUPTED_REASONS.has(reason)) {
      return { code: "interrupted", message: messageForCode("interrupted") };
    }
    if (TIMEOUT_REASONS.has(reason)) {
      return { code: "timeout", message: messageForCode("timeout") };
    }
    if (reason === "api_error") {
      return { code: "api_error", message: messageForCode("api_error") };
    }
  }
  if (input.detail !== undefined) {
    const byKeyword = classifyByDetailKeywords(input.detail);
    if (byKeyword !== null) {
      return { code: byKeyword, message: messageForCode(byKeyword) };
    }
  }
  return { code: "api_error", message: messageForCode("api_error") };
}

/** Default wait chosen for synchronous peer collaboration. Callers may raise
 * it to the master-approved hard maximum below for a long-running peer. */
const DEFAULT_REPLY_TIMEOUT_MS = 300_000;
const MAX_REPLY_TIMEOUT_MS = 300_000;

/** Maximum number of pending inbound envelopes coalesced into one SDK turn
 *  (issue #221 段階3, direction 2 — coalescing unit is same-peer, クロエ
 *  裁定 2026-08-11). Matches `MAX_ATTACHMENTS_PER_INSTRUCTION`
 *  (claude-code/codex `upload.ts`) on the same axis: how many discrete
 *  items get bundled into one turn's content. Not imported from there
 *  directly — agent-common is engine-agnostic and upload.ts is
 *  per-package — this is a separately-defined constant chosen to match
 *  that one's order of magnitude, per クロエ's instruction not to invent an
 *  unrelated number. A batch that would exceed this is cut here; the
 *  excess starts a NEW batch (cli.ts's flush scheduling) rather than being
 *  dropped — see `canAddToCoalescedBatch()`. */
export const MAX_COALESCED_MESSAGES = 10;

/** Maximum combined byte size (UTF-8, of each envelope's OWN
 *  `formatInboundMessage()` rendering) of one coalesced batch (issue #221
 *  段階3, direction 2). Matches the independently-chosen 16_384 already
 *  used for `MAX_INPUT_BYTES` (permission.ts), `MAX_TASKLIST_ITEMS_JSON_BYTES`
 *  (tasklist.ts), and `MAX_LOG_BYTES` (logpayload.ts) — three unrelated
 *  call sites landed on the same order of magnitude for "a reasonable
 *  bound on one agent-facing text/JSON blob", which makes it the natural
 *  anchor here too instead of an invented number. Checked against the
 *  FORMATTED text size, since that is what actually reaches the model's
 *  context, not the raw envelope/payload bytes. */
export const MAX_COALESCED_BYTES = 16_384;

/** Whether one more envelope of `candidateBytes` may join a batch that
 *  already holds `currentCount` items totalling `currentBytes` (issue #221
 *  段階3). An EMPTY batch (`currentCount === 0`) always accepts its first
 *  item regardless of that item's own size — a single already-oversized
 *  inbound message must still be delivered unbatched, matching today's
 *  uncapped single-message behaviour; only ADDITIONAL items sharing a
 *  batch are ever refused. Pure/stateless: cli.ts's batching loop and this
 *  module's own tests can both exercise it without constructing a live
 *  `InterAgentTool`. */
export function canAddToCoalescedBatch(
  currentCount: number,
  currentBytes: number,
  candidateBytes: number,
): boolean {
  if (currentCount === 0) return true;
  if (currentCount + 1 > MAX_COALESCED_MESSAGES) return false;
  if (currentBytes + candidateBytes > MAX_COALESCED_BYTES) return false;
  return true;
}

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
  "List other kaoiro agents currently known to the server. Returns each peer's agent_id, persona (id/name/sprite_set), current state (idle / thinking / tool_running / waiting_permission / waiting_input / done / error / disconnected), and engine/model/effort when reported. Use this to resolve a peer's display name and execution traits before calling send_to_agent. The calling agent is NOT included — call whoami for self-info. When multiple peers share a display name, ask the operator which one to address. A proper-name collaboration request refers to an existing kaoiro peer — resolve it here first: 1 match → send_to_agent, several → ask the operator, 0 matches → report the persona is absent and never spawn a same-named internal sub-agent as a substitute.\n\nEach peer may also carry status fields for deciding WHO to delegate to: `context` ({used_tokens, max_tokens, used_percentage}) — avoid handing heavy work to a peer whose context is nearly full; `rate_limits` ({<window>: {status?, utilization?, resets_at?}}, windows `five_hour` / `seven_day`) — a peer near its limit will fail or stall, so prefer another or wait; `conversation` ({active, peers}) — a peer already in an active conversation is mid-collaboration, so avoid interrupting unless your message belongs to that work; `session_started_at` / `turns` / `last_activity_at` — a long-idle `last_activity_at` suggests the peer is stalled or done, worth reporting rather than delegating to.\n\nTwo rules when reading these: (1) `rate_limits` is a snapshot from the peer's LAST turn and is NOT refreshed while it idles — compare `resets_at` (Unix seconds) against the current time yourself, and once it has passed, treat that window as reset and stop trusting its `utilization` / `status`; use `last_activity_at` to judge how stale the snapshot is. (2) A field that is ABSENT means unknown, never zero and never fine — an omitted `turns` does not mean no turns, an omitted `context` does not mean plenty of room, and an omitted `rate_limits` does not mean unlimited. Ask the operator instead of assuming when an absent field would change your decision.\n\nThe reply also carries `users`: the kaoiro human users (operator/viewer) currently REGISTERED and authorized, each with id/kind/display_name/role — 'kind' is always the literal \"user\" here, distinguishing them from `agents`. `users` are NOT valid `send_to_agent` destinations — that tool only ever delivers to an agent_id from the `agents` list. This is a registry, not an online-presence list: it includes every currently-authorized user whether or not they are actively connected right now, and it does NOT currently identify who issued any particular instruction or inter-agent message — that attribution is not wired yet, so do not infer it from this list. Read it only to know which users exist and what role each holds; never pass a user's id as `send_to_agent`'s `to`. This array can be empty even when users exist — the operator can opt out of this disclosure server-side (default is disclosed).";

const WHOAMI_DESCRIPTION =
  "Return this agent's identity from the kaoiro server's perspective: agent_id, persona (id/name/sprite_set), current state, engine, effective model/effort and their sources, engine-neutral permission (sandbox/approval), network_access, legacy permission_mode/fast_mode when applicable, session_id, working directory, and — on engines that report it — `context` ({used_tokens, max_tokens, used_percentage}), your own context-window usage in the same shape peers see via list_agents. Fields that the SDK has not yet reported are omitted. Use this to confirm what the operator sees you as, or to self-narrate (e.g., when telling a peer who you are). `context` is a cached last successful measurement; whoami itself does not refresh it, so it can lag the current turn. Read it only when a decision actually turns on it — sizing a delegation you are about to accept, or answering the operator's question about your own headroom. It is not a meter to watch: do not check it each turn and do not bring it up unprompted. An absent `context` means unknown, not empty.";

/** issue #177: how a `formatInboundMessage()`-injected inbound should read
 *  to the model. `reply-owed` is the ordinary case (unchanged wording).
 *  `close-proposal` is a one-sided done=true — the peer proposes closing
 *  but this wrapper has not reciprocated, so a reply is still owed (either
 *  a closing done=true or a substantive response). `terminal` is both
 *  sides done — informational only, no reply directive (AC7/AC8). */
export type InboundReplyMode = "reply-owed" | "close-proposal" | "terminal";

/** Per-conversation_id lifecycle state (issue #177). `turnNumber` is the
 *  highest turn_number observed so far, from either side — used both for
 *  outbound monotonicity (existing behaviour) and to reject late / stale /
 *  duplicate inbound turns (AC9). `localDone` / `remoteDone` track each
 *  side's `meta.done=true` signal independently (spec MUST: both sides);
 *  `closed` is true only once both are — the terminal state that stops the
 *  done/escalate ping-pong the issue exists to fix. `closedAtMs` is set
 *  exactly once, when `closed` flips true, and drives TTL cleanup
 *  (`CLOSED_TRACK_TTL_MS`) independent of any later (stale) traffic on the
 *  same conversation_id — a sliding "last activity" window would let a
 *  flapping peer keep a closed track alive forever. `lastActivityMs` (issue
 *  #177 review M3) is refreshed on every `#getTrack()` touch (create or
 *  lookup) and drives the OPEN-track bound (`OPEN_TRACK_TTL_MS`,
 *  `#pruneStaleOpenTracks()`) — unlike `closedAtMs`, this one IS a sliding
 *  window, since an open track's own traffic is exactly the signal that it
 *  is still a real, live conversation. `autoAllowedPeer` (issue #175,
 *  ADR-0044 F2 追補; issue #175 review round 4 — ふじ design-review
 *  approve, gitea issue #211 comment 2719 条件 A) is the SOLE whitelist
 *  authority for `send_to_agent` auto-allow: present and equal to some
 *  `to` iff this wrapper has observed a SERVER-ACCEPTED ack for a
 *  `send_to_agent` on this conversation_id addressed to that `to`.
 *  `undefined` = no whitelist established yet. Written unconditionally
 *  (not sticky-first) the moment `#dispatch()` resolves
 *  `{kind: "accepted"}`, inside the same `#withCidLock` segment — see
 *  `invoke()`'s acceptance handling. `rejected` and `unknown` acceptance
 *  NEVER touch this field: an earlier design wrote it optimistically
 *  before dispatch and needed three rounds of case-by-case guards to
 *  approximate this same invariant, each round's guard reintroducing a
 *  new bug (failure history: #211 comment 2715). Piggybacks on the
 *  track's own TTL/cap eviction for cleanup (`#pruneTracks()`) rather
 *  than a separate Set, so the field's lifetime never drifts from the
 *  track it belongs to. Claude-only in practice (see
 *  `isConversationAutoAllowed()`); Codex has no canUseTool gate to bypass
 *  (ADR-0033 F3), so the field is written but never read there.
 *  `mutationGen` (issue #175 review, ふじ M3; review round 4, ふじ 条件
 *  C) is a monotonic counter bumped only when `receiveInbound()` /
 *  `observeInbound()` actually CHANGES the value of `turnNumber` /
 *  `remoteDone` / `closed` — see `invoke()`'s reject-cleanup branch for
 *  why: it lets that branch detect whether a concurrent legitimate
 *  inbound mutated the track WHILE this call's own send was in flight,
 *  so a stale pre-dispatch snapshot can never silently clobber it. A
 *  no-op touch (e.g. a synthetic `disconnected` notice with
 *  turn_number=0/done=false, which changes nothing) must NOT bump it, or
 *  that guard would wrongly read "something raced in" for a touch that
 *  changed nothing. */
interface ConversationTrack {
  turnNumber: number;
  localDone: boolean;
  remoteDone: boolean;
  closed: boolean;
  closedAtMs?: number;
  lastActivityMs: number;
  autoAllowedPeer?: string;
  mutationGen: number;
}

/** How long a CLOSED track is kept before being pruned (issue #177: "長寿命
 *  wrapper の memory leak を防ぐ"). The wrapper has no visibility into the
 *  server's own tombstone TTL config (`tombstone_ttl_ms`, also 24h by
 *  default as of issue #221 — deliberately matched to this constant, see
 *  protocol-inter-agent spec「CID 再利用は契約にしない」), so this value is
 *  chosen independently: a track surviving longer than the server's costs
 *  only a few bytes of memory, while pruning too early would let
 *  `invoke()`'s local closed-CID guard (AC10) miss a conversation_id the
 *  server would still reject. 24h comfortably outlives any realistic
 *  session. */
const CLOSED_TRACK_TTL_MS = 24 * 60 * 60 * 1000;

/** Upper bound on CLOSED tracks kept at once (issue #177 review M3, AC6),
 *  independent of TTL — a long-lived wrapper that closes many
 *  conversations within one TTL window must not grow `#conversations`
 *  without bound. Mirrors the server's own `max_conversations` default
 *  (conversation_states.ex) for a comparable order-of-magnitude memory
 *  bound. When exceeded, the OLDEST closed tracks (by `closedAtMs`) are
 *  evicted first — see `#pruneClosedTracks()`. */
const DEFAULT_MAX_CLOSED_TRACKS = 10_000;

/** Idle-age bound for OPEN tracks (issue #177 review round 2, "open track
 *  の unbounded 経路"): `#pruneClosedTracks()` only ever prunes tracks this
 *  wrapper itself learned were CLOSED, but the server's own periodic GC
 *  does not push a tombstone notice to this wrapper when it closes a
 *  conversation on its own (issue #209, deliberately deferred out of
 *  #177's scope) — so a track this wrapper never learned was closed (a
 *  dropped/missed closing turn, a crashed peer, …) stays OPEN, and
 *  therefore un-prunable by `#pruneClosedTracks()`, for the life of the
 *  process. issue #221 removed the server's old hard wall-clock limit
 *  (`max_wallclock`), so an OPEN entry this stale is no longer guaranteed
 *  to have been force-closed server-side by that mechanism — but the
 *  server's own `open_conversation_ttl_ms` GC sweep (also 24h by default)
 *  independently reclaims a `started_at`-stale OPEN entry into a
 *  tombstone regardless, so this local eviction still lines up with the
 *  server's own memory-reclaim horizon; evicting the local OPEN entry
 *  only discards this wrapper's now-stale bookkeeping for it
 *  (`turnNumber` / `localDone` / `remoteDone`) —
 *  a deliberate trade-off. A subsequent explicit send on the same
 *  conversation_id simply starts a fresh local track and gets a fresh,
 *  authoritative answer from the server: `conversation_closed` if the
 *  server still remembers it (now correctly learned back into the track —
 *  see the `conversation_closed` handling in `invoke()`, review M2) or an
 *  ordinary acceptance/`stale_turn` if it does not. Reuses the same 24h
 *  order of magnitude as `CLOSED_TRACK_TTL_MS` for the same reason: it
 *  comfortably outlives any realistic session while still keeping the map
 *  bounded for a long-lived wrapper. */
const OPEN_TRACK_TTL_MS = 24 * 60 * 60 * 1000;

/** Upper bound on ALL tracks combined — open and closed (issue #177 review
 *  round 2, "open track の unbounded 経路") — independent of every TTL
 *  above. A purely count-based backstop for a wrapper that is simply busy
 *  enough (many distinct peers/conversations within one TTL window) that
 *  TTL alone would not keep `#conversations` bounded; mirrors
 *  `DEFAULT_MAX_CLOSED_TRACKS`'s rationale but applies across the whole
 *  map. When exceeded, the globally OLDEST tracks are evicted first — see
 *  `#enforceTrackCap()` — using `closedAtMs` for closed tracks (matching
 *  `#pruneClosedTracks()`'s own ordering) and `lastActivityMs` for open
 *  ones. Sized well above `DEFAULT_MAX_CLOSED_TRACKS` so normal traffic
 *  hits the closed-specific bound first, as before; this one is a backstop
 *  for the combined total, not a tighter replacement for it. */
const DEFAULT_MAX_TRACKS = 20_000;

function freshTrack(nowMs: number): ConversationTrack {
  return {
    turnNumber: 0,
    localDone: false,
    remoteDone: false,
    closed: false,
    lastActivityMs: nowMs,
    mutationGen: 0,
  };
}

/** Age used to order a track for the total-count backstop
 *  (`#enforceTrackCap()`) — `closedAtMs` once closed (matching
 *  `#pruneClosedTracks()`'s own ordering), else `lastActivityMs`. */
function trackAge(track: ConversationTrack): number {
  return track.closed ? (track.closedAtMs ?? track.lastActivityMs) : track.lastActivityMs;
}

/** Disposition returned by `receiveInbound()` for one inbound envelope
 *  (issue #177). `consumed`: a `wait_for_response` waiter took it as its
 *  reply — the caller injects nothing. `inject: false` has TWO distinct
 *  causes the caller must not conflate (issue #221 direction 1):
 *  - a late / stale / duplicate turn_number (AC9) — never happened; the
 *    track was never mutated, drop it silently, log nothing worth keeping.
 *  - `mode === "terminal"` — did happen (the track just learned `closed`),
 *    but owes no reply, so no SDK turn should be spent on it either. The
 *    caller CAN and should still note this happened (e.g. its own log
 *    line), just must not `host.send()` it.
 *  `mode`: see {@link InboundReplyMode} — always populated, but only
 *  actionable (decides HOW to render an injected message) when `inject`
 *  is true; when `inject` is false it still tells the caller WHICH of the
 *  two `inject: false` causes above applies. */
export interface InboundDisposition {
  consumed: boolean;
  inject: boolean;
  mode: InboundReplyMode;
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
  /** Inter-agent sink that resolves with the server's acceptance outcome
   *  (ADR-0051 D3-2, normally ServerLink#sendInterAgent). Production always
   *  wires it; without one `send_to_agent` falls back to the fire-and-forget
   *  `send` above and reports "sent" without ever learning whether the
   *  server took the message — the pre-ADR-0051 behaviour, kept only so
   *  unit tests that exercise payload construction need not model a
   *  transport. */
  sendInterAgent?: (envelope: Envelope) => Promise<InterAgentAcceptance>;
  /** Peer directory provider, normally `ServerLink#requestDirectory` bound
   *  to the wrapper's channel. Omitting it (unit tests only — production
   *  always supplies it under ADR-0029 F10) makes `list_agents` return
   *  an error result. `agents` and `users` (issue #197 段階2) are
   *  returned as separate arrays — see `DirectoryResult`'s own doc for
   *  why they are never merged. */
  requestDirectory?: () => Promise<DirectoryResult>;
  /** Self-identity provider, normally `AgentHost#statusSnapshot`. Omitting
   *  it (unit tests only) makes `whoami` fall back to the wrapper config
   *  (no live SDK fields). */
  getWhoami?: () => WhoamiSnapshot;
  /** ISO timestamp source; injectable for tests. */
  now?: () => string;
  /** conversation_id source for new conversations; injectable for tests. */
  newId?: () => string;
  /** ms-epoch clock for the closed-track TTL (issue #177); injectable for
   *  tests. Separate from `now` (ISO string, stamped onto envelopes) since
   *  this one only ever feeds arithmetic. */
  nowMs?: () => number;
  /** Cap on CLOSED tracks kept at once (issue #177 review M3, AC6);
   *  injectable for tests. Default {@link DEFAULT_MAX_CLOSED_TRACKS}. */
  maxClosedTracks?: number;
  /** Cap on ALL tracks kept at once, open + closed combined (issue #177
   *  review round 2, "open track の unbounded 経路"); injectable for
   *  tests. Default {@link DEFAULT_MAX_TRACKS}. */
  maxTracks?: number;
}

/** Result of `invoke()`'s locked segment (issue #177 review M1) — decides
 *  what the caller does once `#withCidLock()` releases. `local-reject` /
 *  `rejected` both resolve to an immediate `errorResult()`, kept distinct
 *  only for clearer call-site naming (a local guard vs. a server answer).
 *  `dispatched` carries everything the UNLOCKED remainder of `invoke()`
 *  (the `wait_for_response` reply-await, which must NOT hold the lock —
 *  see `#withCidLock()`) needs to finish building the tool result. */
type InvokeLockOutcome =
  | { kind: "local-reject"; message: string }
  | { kind: "rejected"; message: string }
  | {
      kind: "dispatched";
      acceptance: InterAgentAcceptance;
      sentTurnNumber: number;
      sent: string;
      reply: Promise<Envelope | undefined> | undefined;
      timeoutMs: number;
    };

/**
 * Owns the send_to_agent tool registration and the per-conversation turn
 * counter. One instance per wrapper; safe across concurrent send / receive
 * (single-threaded JS event loop, no internal awaits between read+write).
 */
export class InterAgentTool {
  readonly #options: InterAgentToolOptions;
  readonly #now: () => string;
  readonly #newId: () => string;
  readonly #nowMs: () => number;
  readonly #maxClosedTracks: number;
  readonly #maxTracks: number;
  readonly #conversations = new Map<string, ConversationTrack>();
  readonly #replyWaiters = new Map<string, ReplyWaiter>();
  readonly #pendingInjections = new Map<string, PendingInjection>();
  /** Per-conversation_id serialization for `invoke()`'s turn-allocation-
   *  through-acceptance-handling segment (issue #177 review M1). Holds the
   *  tail promise of the current lock chain for a conversation_id; absent
   *  when uncontended. See `#withCidLock()`. */
  readonly #cidLocks = new Map<string, Promise<void>>();
  /** Present for a conversation_id only while an `invoke()` call's
   *  optimistic `localDone` flip (done=true) is unconfirmed — from the
   *  flip itself until that call's acceptance is decided (issue #177
   *  review round 2, ふじ差し戻し). `receiveInbound()` awaits this (when
   *  present) before reading or mutating anything derived from
   *  `localDone`/`closed`. Distinct from `#cidLocks`: this gate is NOT a
   *  replacement or subset of it — `#cidLocks` for the same
   *  conversation_id is held throughout this gate's entire lifetime and
   *  is only released strictly AFTER it (both release inside the same
   *  `#withCidLock` callback, this one first). `receiveInbound()` reads
   *  only THIS map, never `#cidLocks` — the two locks are independent
   *  mechanisms guarding different callers (`invoke()` vs `invoke()`, and
   *  `invoke()` vs `receiveInbound()`, respectively), not layered stages
   *  of one lock. See the registration site in `invoke()`. */
  readonly #pendingDoneAcks = new Map<string, Promise<void>>();

  constructor(options: InterAgentToolOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#newId = options.newId ?? randomUUID;
    this.#nowMs = options.nowMs ?? Date.now;
    this.#maxClosedTracks = options.maxClosedTracks ?? DEFAULT_MAX_CLOSED_TRACKS;
    this.#maxTracks = options.maxTracks ?? DEFAULT_MAX_TRACKS;
  }

  /** Returns the track for `conversationId`, creating one if absent, and
   *  refreshes its `lastActivityMs` (issue #177 review M3 — every touch,
   *  create or lookup, counts as activity for the OPEN-track idle bound).
   *  Opportunistically prunes stale tracks first (issue #177 /
   *  #pruneTracks()) — cheap relative to normal traffic volume and keeps
   *  the map bounded without a dedicated timer. */
  /** `skipPrune` (review-round2 finding, QUALITY/perf): `invoke()`'s locked
   *  segment already calls `#pruneTracks()` explicitly right before this —
   *  to read the AC10 closed-check via a raw, unmutated map lookup ahead
   *  of any track creation — so re-pruning here moments later, with
   *  nothing having touched `#conversations` in between, is a pure
   *  redundant full-map rescan on every `send_to_agent` call. Every OTHER
   *  caller (`observeInbound`, `receiveInbound`, `resolveTurnEnd`) still
   *  gets the default (prune-on-every-touch) behaviour unchanged. */
  #getTrack(
    conversationId: string,
    opts?: { skipPrune?: boolean },
  ): ConversationTrack {
    if (!opts?.skipPrune) {
      this.#pruneTracks();
    }
    const existing = this.#conversations.get(conversationId);
    if (existing) {
      existing.lastActivityMs = this.#nowMs();
      return existing;
    }
    const track = freshTrack(this.#nowMs());
    this.#conversations.set(conversationId, track);
    return track;
  }

  /** Runs every track-pruning pass together (issue #177 review round 2
   *  folds the new OPEN-track bounds into the same call sites that already
   *  pruned CLOSED tracks): closed-track TTL + count-cap (unchanged,
   *  `#pruneClosedTracks()`), then open-track idle TTL
   *  (`#pruneStaleOpenTracks()`), then the whole-map count backstop
   *  (`#enforceTrackCap()`). Order matters only in that the two TTL passes
   *  should run before the count backstop, so the backstop only ever has
   *  to reach further when TTL alone did not already bring the map within
   *  bound.
   *
   *  issue #175 review round 3 (internal review perf finding, considered
   *  and reverted): `isConversationAutoAllowed()` (canUseTool) and
   *  `invoke()`'s own AC10 check both call this for the same
   *  `send_to_agent` turn, an extra O(n) pass beyond what `skipPrune`
   *  already avoids for invoke()'s own two internal call sites. A first
   *  attempt memoized (nowMs, map size) to skip a same-tick repeat call,
   *  but this is UNSAFE, not just imprecise: a `receiveInbound()` call
   *  that flips an EXISTING track to `closed` (no size change) right
   *  before a later, same-tick prune elsewhere would make that later
   *  call wrongly skip the very pass meant to catch the now-excess
   *  closed-track count — confirmed by an existing regression test
   *  actually failing under a deterministic-clock repro before this was
   *  reverted. A correct cache needs invalidation on every field
   *  mutation that affects eviction eligibility (closed/closedAtMs
   *  transitions across `receiveInbound()`/`invoke()`'s several
   *  branches), not just size — a change with real risk of missing a
   *  site, for a bounded-cost O(n) scan (n capped by `#maxTracks`) that
   *  is not itself a correctness concern. Left as the accepted,
   *  documented tradeoff. */
  #pruneTracks(): void {
    this.#pruneClosedTracks();
    this.#pruneStaleOpenTracks();
    this.#enforceTrackCap();
  }

  /** Removes TTL-expired closed tracks, then — issue #177 review M3, AC6 —
   *  evicts the OLDEST remaining closed tracks (by `closedAtMs`) beyond
   *  `#maxClosedTracks`, so a wrapper that closes many conversations
   *  within one TTL window still has a hard memory bound. Open tracks are
   *  never evicted here (only TTL/count-bound closed ones — an active
   *  conversation's state must not be discarded out from under it by this
   *  pass specifically; see `#pruneStaleOpenTracks()` for the OPEN-track
   *  equivalent). */
  #pruneClosedTracks(): void {
    const now = this.#nowMs();
    const closed: [string, ConversationTrack][] = [];
    for (const [id, track] of this.#conversations) {
      if (track.closed && track.closedAtMs !== undefined) {
        if (now - track.closedAtMs > CLOSED_TRACK_TTL_MS) {
          this.#conversations.delete(id);
        } else {
          closed.push([id, track]);
        }
      }
    }
    const excess = closed.length - this.#maxClosedTracks;
    if (excess > 0) {
      closed.sort(([, a], [, b]) => (a.closedAtMs ?? 0) - (b.closedAtMs ?? 0));
      for (let i = 0; i < excess; i++) {
        this.#conversations.delete(closed[i]![0]);
      }
    }
  }

  /** Removes OPEN tracks idle for longer than `OPEN_TRACK_TTL_MS` (issue
   *  #177 review round 2, "open track の unbounded 経路") — see that
   *  constant's doc comment for the full rationale. */
  #pruneStaleOpenTracks(): void {
    const now = this.#nowMs();
    for (const [id, track] of this.#conversations) {
      if (!track.closed && now - track.lastActivityMs > OPEN_TRACK_TTL_MS) {
        this.#conversations.delete(id);
      }
    }
  }

  /** Whole-map count backstop beyond `#maxTracks`, open and closed
   *  combined (issue #177 review round 2) — evicts the globally OLDEST
   *  tracks first (`trackAge()`) once the TTL passes above have already
   *  run. */
  #enforceTrackCap(): void {
    const excess = this.#conversations.size - this.#maxTracks;
    if (excess <= 0) return;
    const byAge = [...this.#conversations.entries()].sort(
      ([, a], [, b]) => trackAge(a) - trackAge(b),
    );
    for (let i = 0; i < excess; i++) {
      this.#conversations.delete(byAge[i]![0]);
    }
  }

  /** Serializes `invoke()`'s turn-allocation-through-acceptance-handling
   *  segment per conversation_id (issue #177 review M1) — NOT the whole
   *  call: releasing the lock before an eventual `wait_for_response`
   *  reply-await (up to 300s) would otherwise block a sibling `invoke()`
   *  on the same conversation_id for the full timeout. A standard
   *  promise-chained mutex, keyed by conversation_id.
   *
   *  Deliberately NOT declared `async`: an uncontended call (the common
   *  case — no OTHER invoke() currently in flight for this
   *  conversation_id) runs `fn` SYNCHRONOUSLY, in the same synchronous
   *  frame as the caller, exactly as `invoke()` did before this lock
   *  existed. An unconditional `await prior` here — even on an
   *  already-resolved placeholder — would defer `fn`'s synchronous prefix
   *  (envelope dispatch, waiter registration) by a full microtask tick for
   *  EVERY call, uncontended or not, which several existing tests observe
   *  synchronously (no tick) right after calling `invoke()` without
   *  awaiting it.
   *
   *  The map slot for `conversationId` is still reserved SYNCHRONOUSLY on
   *  every call, contended or not — this is what keeps 3-way-or-more
   *  contention correctly ordered: a THIRD call issued in the same
   *  synchronous burst, before the first two have had a chance to run,
   *  must see the SECOND call's slot as its `prior`, not the first's, or
   *  the second and third would both chain off the first independently
   *  and could run concurrently with each other — reintroducing the same
   *  race this lock exists to close, one level removed. */
  #withCidLock<T>(conversationId: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.#cidLocks.get(conversationId);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chained = prior === undefined ? held : prior.then(() => held);
    this.#cidLocks.set(conversationId, chained);

    const run = (): Promise<T> =>
      fn().finally(() => {
        release();
        if (this.#cidLocks.get(conversationId) === chained) {
          this.#cidLocks.delete(conversationId);
        }
      });

    return prior === undefined ? run() : prior.then(run);
  }

  /** Whether `send_to_agent` for `(conversationId, to)` may skip the
   *  operator canUseTool dialog (issue #175, ADR-0044 F2 追補 —
   *  conversation 単位 whitelist, 案 B). The whole invariant lives in one
   *  field now (issue #175 review round 4 — ふじ design-review approve,
   *  #211 comment 2719 条件 A): `to` is auto-allowed iff
   *  `track.autoAllowedPeer === to` — see that field's doc comment on
   *  `ConversationTrack`. Does NOT go through `#getTrack()`, which would
   *  create a track (and touch `lastActivityMs`) as a side effect of
   *  what must stay a pure read; an unknown or since-pruned
   *  conversation_id simply reads as not auto-allowed, matching "this
   *  wrapper has no live memory of having sent here before".
   *
   *  Prunes FIRST (issue #175 review, ふじ M1): without this, a
   *  conversation_id whose track already aged out (TTL) or was evicted
   *  (cap) still read auto-allowed until the NEXT `invoke()` call
   *  happened to prune it from inside its own `#withCidLock` segment —
   *  a real window where canUseTool would wrongly skip the dialog for a
   *  conversation_id this wrapper no longer has any live memory of
   *  having approved. `#pruneTracks()` only evicts; it never creates or
   *  touches a surviving entry's `lastActivityMs`, so this stays a pure
   *  read as far as `conversationId` itself is concerned. This does mean
   *  a `send_to_agent` call now runs `#pruneTracks()` twice in the
   *  common case — once here from canUseTool, once more from `invoke()`'s
   *  own AC10 check moments later — see `#pruneTracks()`'s doc comment
   *  for why that redundant O(n) pass is an accepted tradeoff rather
   *  than something this method tries to cache around.
   *
   *  Consulted by the Claude host's canUseTool before invoking the
   *  permission broker — Codex has no such gate to consult (ADR-0033
   *  F3, approval pinned to `never`). Auto-allow gates only the DIALOG;
   *  `invoke()` still runs its own validity checks (AC10 closed guard,
   *  etc.) regardless of this flag. */
  isConversationAutoAllowed(conversationId: string, to: string): boolean {
    this.#pruneTracks();
    const track = this.#conversations.get(conversationId);
    return track?.autoAllowedPeer === to;
  }

  /** Records the turn_number of an inbound message so subsequent outbound
   *  turns stay monotonic per conversation regardless of which side authored
   *  the latest message. A narrower sibling of `receiveInbound()` — no
   *  done/closed/staleness handling — kept for direct turn-number
   *  bookkeeping (e.g. tests exercising outbound ordering in isolation). */
  observeInbound(conversationId: string, turnNumber: number): void {
    const track = this.#getTrack(conversationId);
    if (turnNumber > track.turnNumber) {
      track.turnNumber = turnNumber;
      // issue #175 review round 3 (ふじ M3): see `mutationGen`'s doc
      // comment on `ConversationTrack` / `genAtDispatch` in `invoke()`.
      track.mutationGen += 1;
    }
  }

  /** Handles an inbound envelope before the CLI schedules normal next-turn
   *  injection. A matching synchronous waiter consumes exactly one reply, so
   *  its body/meta reaches the current tool result instead of being injected
   *  a second time on the SDK's next turn.
   *
   *  issue #177: also classifies the envelope for the non-consumed path.
   *  `inject: false` (AC9) fires for a turn_number no greater than the
   *  highest already observed for this conversation_id — a late, stale, or
   *  duplicate delivery, never the waiter's actual next reply either, so
   *  staleness is checked BEFORE the waiter lookup. `turn_number=0` is
   *  exempt (Stage 4): the server's own synthesized notices (hard-limit
   *  escalate, disconnected) always use it, a distinct provenance from the
   *  wrapper-origin turn stream that must not be judged against it. `mode`
   *  (AC7/AC8) reflects the CONVERSATION's state after this envelope, not
   *  just this message's own `meta.done` — once the peer has signalled done
   *  at any point without this side reciprocating, every further inbound
   *  reads as a close proposal until this side closes it too.
   *
   *  issue #177 review round 2 (ふじ差し戻し): async — awaits
   *  `#pendingDoneAcks` (when set for this conversation_id) before reading
   *  or mutating anything below. Without this, a done=true `invoke()` still
   *  awaiting its own acceptance leaves `localDone` optimistically true;
   *  this method could then either (a) hand the caller a "terminal, do not
   *  reply" disposition that becomes wrong and unrecoverable the moment
   *  that send is later rejected (the SDK queue already has the
   *  "informational only" text, `notePendingInjection` was already
   *  skipped), or (b) — for a server-synthesized hard-limit notice — set an
   *  authoritative `closed=true` that the later-settling rejection's
   *  rollback then reverts back to OPEN, a server=CLOSED / wrapper=OPEN
   *  split-brain that also defeats the local AC10 guard. The gate is short
   *  (until that ONE send's ack lands), never the full
   *  `wait_for_response` window. */
  async receiveInbound(envelope: Envelope): Promise<InboundDisposition> {
    const payload = envelope.payload as Partial<InterAgentMessagePayload>;
    if (
      typeof payload.conversation_id !== "string" ||
      typeof payload.turn_number !== "number"
    ) {
      // Malformed shape: fail open to injection (existing behaviour) rather
      // than silently dropping a message the model might still need to see.
      return { consumed: false, inject: true, mode: "reply-owed" };
    }

    const conversationId = payload.conversation_id;
    const turnNumber = payload.turn_number;
    const doneGate = this.#pendingDoneAcks.get(conversationId);
    if (doneGate) await doneGate;
    const track = this.#getTrack(conversationId);
    // issue #177 review M1: turn_number=0 alone is not proof of server
    // provenance — a peer wrapper's own live ingress is now rejected
    // structurally by the server for any non-positive turn_number
    // (wrapper_channel.ex), but this classifier must not rely on that
    // alone. A malformed/forged turn_number=0 that slipped through would
    // otherwise let a peer force THIS side's track into `closed` (or skip
    // the stale check) without the server ever agreeing the conversation
    // ended — a split-brain (server=open, this wrapper=closed). Server
    // envelopes are always `agent_id: "server"`
    // (`KaoiroServerWeb.SynthEnvelope.build/2`, server-side); require both.
    const isSynthetic = turnNumber === 0 && envelope.agent_id === "server";
    const stale = !isSynthetic && turnNumber <= track.turnNumber;

    if (stale) {
      return { consumed: false, inject: false, mode: "reply-owed" };
    }

    // issue #175 review round 4 (ふじ 条件 C, #211 comment 2719):
    // `mutated` tracks whether this envelope actually changed
    // `turnNumber` / `remoteDone` / `closed` — `mutationGen` below is
    // bumped only when it did (see that field's doc comment on
    // `ConversationTrack`). A no-op touch (e.g. a synthetic
    // `disconnected` notice with turn_number=0/done=false) must read as
    // unmutated, or `invoke()`'s reject-cleanup race guard would wrongly
    // treat it as proof that something raced in.
    let mutated = false;
    if (turnNumber > track.turnNumber) {
      track.turnNumber = turnNumber;
      mutated = true;
    }
    if (payload.meta?.done === true && !track.remoteDone) {
      track.remoteDone = true;
      mutated = true;
    }
    // issue #177 (review must-fix): closed(terminal) has two independent
    // routes, not one — protocol-inter-agent.md's lifecycle section: "両
    // owner-side の done=true が揃った、または hard limit 超過". A
    // server-synthesized hard-limit termination (turn_number=0,
    // meta.done=true, e.g. kind="escalate-to-user") ends the conversation
    // for BOTH sides by server fiat — the server already tombstoned it
    // (Stage 1) — regardless of whether THIS side ever sent its own
    // done=true. Gating solely on `localDone && remoteDone` misread that
    // broadcast as a one-sided close-proposal, which invited exactly the
    // further send_to_agent call AC8 exists to prevent (and which the
    // local AC10 guard below would not have caught either, since it also
    // reads `closed`).
    if (
      !track.closed &&
      ((track.localDone && track.remoteDone) ||
        (isSynthetic && payload.meta?.done === true))
    ) {
      track.closed = true;
      track.closedAtMs = this.#nowMs();
      mutated = true;
    }
    // issue #175 review round 3 (ふじ M3); round 4 (ふじ 条件 C): bumped
    // only when `mutated` above is true — see `mutationGen`'s doc
    // comment on `ConversationTrack` / `genAtDispatch` in `invoke()`.
    // Deliberately still gated on reaching this point AFTER the `stale`
    // early-return above: a stale/duplicate delivery is never a
    // mutation candidate at all.
    if (mutated) track.mutationGen += 1;
    const mode: InboundReplyMode = track.closed
      ? "terminal"
      : track.remoteDone
        ? "close-proposal"
        : "reply-owed";

    const waiter = this.#replyWaiters.get(conversationId);
    if (waiter) {
      this.#replyWaiters.delete(conversationId);
      clearTimeout(waiter.timeout);
      waiter.resolve(envelope);
      return { consumed: true, inject: false, mode };
    }

    // issue #221 direction 1: a `terminal` envelope (mutual done, or a
    // server-synthesized closure notice) owes no reply and must not wake
    // the model — the track above already learned `closed`, which is the
    // whole point; injecting it into the SDK just to say "nothing to do"
    // burns a full model turn for no actionable content. Distinct from
    // AC9's stale-drop `inject: false` above: THAT means "never happened"
    // (track never mutated), this means "happened, track updated, but no
    // reply is owed" — cli.ts must tell the two apart in its own logging
    // (mode is always returned alongside, so it can).
    if (mode === "terminal") return { consumed: false, inject: false, mode };

    return { consumed: false, inject: true, mode };
  }

  /** Records that an inbound inter-agent message is about to be injected
   *  into the SDK as ordinary user input (cli.ts's formatInboundMessage
   *  branch — i.e. `receiveInbound` did NOT consume it as a waiter reply),
   *  so this wrapper now owes a reply on the conversation. Called by cli.ts
   *  right before it queues the injection (the same call also tags the queued
   *  turn with this conversation_id — see AgentHost#send /
   *  CodexHost#send's third parameter). If the SPECIFIC turn that injection
   *  started ends without an outbound reply clearing the entry (see
   *  `invoke()`), `resolveTurnEnd()` resolves it (issue #131).
   *
   *  Call-site timing matters (issue #221 段階3 MF-1, ふじレビュー差し戻し):
   *  cli.ts calls this at DISPATCH time — inside `trySendNextBatch()`,
   *  immediately before the actual `host.send()` — not at receipt time.
   *  This map is keyed by conversation_id, one entry each, so registering
   *  eagerly on arrival would let a second same-cid message queued into a
   *  LATER coalesced batch (peer still busy on an EARLIER one) overwrite
   *  that earlier batch's still-pending entry before its turn even
   *  completes; the earlier turn's `resolveTurnEnd()` would then delete the
   *  wrong (later) registration, silently breaking the later turn's own
   *  resolution on failure. Registering per-item at dispatch time ties each
   *  cid's entry one-for-one to the batch actually being sent. */
  notePendingInjection(envelope: Envelope): void {
    const payload = envelope.payload as Partial<InterAgentMessagePayload>;
    if (typeof payload.conversation_id !== "string") return;
    this.#pendingInjections.set(payload.conversation_id, {
      from: envelope.agent_id,
    });
  }

  /** Called by cli.ts once per SDK turn boundary (success or error), with the
   *  conversation_id(s) the CLI/host tagged that specific turn with — an
   *  empty array for an ordinary operator-instruction turn, one entry for an
   *  ordinary (non-coalesced) inter-agent turn, or MULTIPLE entries when the
   *  turn was a coalesced batch (issue #221 段階3, direction 2 — same-peer
   *  unit). Turn-scoped by design (issue #131 must-fix 1, extended for
   *  coalescing): sweeping the entire pending set on any is_error turn
   *  misattributes failures across unrelated, concurrently queued
   *  conversations and never resolves a conversation whose turn quietly
   *  succeeded without a reply — this still holds per-cid inside the loop
   *  below, only the CALLER now supplies a list instead of one value. Each
   *  cid is resolved independently and exactly once; a cid with no pending
   *  entry (already resolved by `invoke()` sending a reply during the turn —
   *  the primary resolution path) is skipped, not an error.
   *
   *  On success (`error` omitted) each entry is simply cleared — the model
   *  had its turn to reply and chose not to, which is not itself an error
   *  worth surfacing. On failure, one error-notice envelope is built and
   *  returned PER unresolved cid in the batch — issue #221 段階3 direction 2
   *  (クロエ裁定): the wrapper does not know which ONE message in a coalesced
   *  batch caused the turn to fail, so every peer whose message was bundled
   *  into it gets its own peer_error notice, addressed back to ITS own
   *  sender. This fan-out is a deliberate, documented tradeoff of coalescing
   *  (protocol-inter-agent.md「保留メッセージの合流」) — trading fewer turns
   *  for a wider blast radius on a single turn-level failure, not an
   *  oversight. Each notice: kind="inform" (no new enum value), meta.done=
   *  false (ending the conversation is the sender's call), payload.error
   *  set. Callers push each result straight through ServerLink#send: these
   *  notices did not come from a model tool call (the turn just failed to
   *  produce one), so they bypass the broker entirely. */
  resolveTurnEnd(
    conversationIds: readonly string[],
    error?: InterAgentErrorPayload,
  ): Envelope[] {
    const notices: Envelope[] = [];
    for (const conversationId of conversationIds) {
      const injection = this.#pendingInjections.get(conversationId);
      if (!injection) continue;
      this.#pendingInjections.delete(conversationId);
      if (!error) continue;

      const track = this.#getTrack(conversationId);
      track.turnNumber += 1;
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
      notices.push(
        makeInterAgentMessage(
          this.#options.config,
          this.#options.getState(),
          this.#now(),
          payload,
        ),
      );
    }
    return notices;
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
   *  JSON list as a tool-shaped text result so the model can read it.
   *  `agents` and `users` (issue #197 段階2) are surfaced as separate
   *  top-level keys, matching `DirectoryResult` — `users` are never
   *  merged into `agents` since they are not valid `send_to_agent`
   *  destinations (director D7, see `LIST_AGENTS_DESCRIPTION`). */
  async listAgents(): Promise<InterAgentToolResult> {
    const provider = this.#options.requestDirectory;
    if (!provider) {
      return errorResult(
        "list_agents unavailable: wrapper is not connected to a server",
      );
    }
    try {
      const { agents, users } = await provider();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ agents, users }, null, 2),
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

    // issue #177 review M1: the turn-allocation-through-acceptance-handling
    // segment below is serialized per conversation_id via #withCidLock —
    // NOT the whole call (releasing before an eventual wait_for_response
    // reply-await, up to 300s, would otherwise block a sibling invoke() on
    // the same conversation_id for the full timeout). Without this, two
    // concurrent invoke() calls on the same conversation_id each run their
    // synchronous prefix (turn number allocation, optimistic localDone
    // flip / snapshot below) against the SAME shared track object before
    // either awaits its own #dispatch — so a REJECTED call's rollback
    // restores a snapshot that predates a sibling call's already-committed
    // (accepted) mutation and silently erases it. See the M1 review
    // finding for the concrete repro (two concurrent done=true sends, one
    // rejected, one accepted, same conversation_id).
    const outcome = await this.#withCidLock(
      conversationId,
      async (): Promise<InvokeLockOutcome> => {
        // issue #177 AC10: a conversation this wrapper already knows is
        // CLOSED is rejected locally, before any network round-trip — the
        // server would say the same via conversation_closed, but there is
        // no reason to pay a push for an answer we already know. Read
        // (and pruned) INSIDE the lock — review M1 — so a concurrent
        // sibling call cannot have changed `closed` out from under this
        // check between reading it and acting on it. A freshly generated
        // conversation_id (omitted by the caller) can never already be in
        // the map, so this is a no-op for that case, same as before.
        this.#pruneTracks();
        const existing = this.#conversations.get(conversationId);
        if (existing?.closed) {
          // issue #177 review S3: reason-neutral — closed(terminal) has
          // two routes (mutual done, OR a server hard-limit escalate), so
          // this must not assert "both sides signalled done" when the
          // real cause may have been a hard limit.
          return {
            kind: "local-reject",
            message:
              `send_to_agent failed: conversation_id=${conversationId} is ` +
              "already closed — omit conversation_id to start a new " +
              "conversation with this peer.",
          };
        }

        // issue #177 review M1: checked HERE (not before the lock) so it
        // is evaluated at the same point #waitForReply() actually
        // registers, below — a sibling call queued behind this lock would
        // otherwise pass a dupe-check performed before this call had
        // registered its own waiter yet, then silently overwrite it.
        if (waitForResponse && this.#replyWaiters.has(conversationId)) {
          return {
            kind: "local-reject",
            message:
              "send_to_agent failed: a synchronous reply wait is already " +
              `active for conversation_id=${conversationId}`,
          };
        }

        // review-round2 (QUALITY/perf): the AC10 check above already ran
        // #pruneTracks() moments ago, synchronously, with nothing having
        // touched #conversations in between (the closed-check and
        // dupe-waiter-check are both read-only) — re-pruning here would be
        // a pure redundant full-map rescan on every send_to_agent call.
        const track = this.#getTrack(conversationId, { skipPrune: true });
        // issue #177 review M3 (originally `trackExistedBefore`, map
        // presence): remember whether this track had NO real history yet
        // — no turn, no done/closed signal from either side — so a
        // rejected send (nothing reached the peer) can be treated as
        // "nothing happened" below instead of leaving stale state behind.
        //
        // issue #175 review round 2: reads track FIELDS rather than map
        // presence, and is captured BEFORE this call's own optimistic
        // mutations just below. Map presence stopped being the right
        // signal once the round-1 fix changed the rejection-cleanup gate
        // (below) from deleting the track to resetting it in place — see
        // that gate's comment (issue #175 review round 4) for the
        // current rationale: once the entry is left in the map instead
        // of removed, a SECOND
        // rejected retry on the same conversation_id would read
        // `trackExistedBefore=true` and skip the reset — leaving
        // turnNumber stuck non-zero and misclassifying the next
        // legitimate inbound as a stale duplicate (reproduced and
        // confirmed). `wasBlank` instead reads true on every repeated
        // failed retry, since each reset leaves the track blank again;
        // an inbound arriving first (or a previously ACCEPTED send)
        // leaves at least one field non-blank, so it still reads false —
        // preserving the original "don't erase real history" intent.
        const wasBlank =
          track.turnNumber === 0 &&
          !track.localDone &&
          !track.remoteDone &&
          !track.closed;
        // issue #175 review round 3 (ふじ M3): the generation this track
        // is at right now, BEFORE this call's own optimistic mutations
        // and BEFORE the `#dispatch()` await below. `#pendingDoneAcks`
        // only gates `done=true` sends against a concurrent
        // `receiveInbound()` — a non-`done` send (this path) has no such
        // protection, so a legitimate inbound (a genuine reply, or a
        // server-synthesized hard-limit close) can race in and mutate
        // this SAME track while `#dispatch()` is still in flight. If
        // that happens and this send is then rejected for a reason
        // OTHER than `conversation_closed`, the reject-cleanup below
        // must NOT act on the stale `wasBlank` snapshot as if nothing
        // happened — that would silently discard the concurrent
        // inbound's legitimate mutation (e.g. an authoritative
        // `closed=true` reverting to OPEN, restoring exactly the split-
        // brain #177 review M2's `#pendingDoneAcks` gate was built to
        // prevent for `done=true` sends, but here for the reject-cleanup
        // path instead of the localDone flip). Comparing
        // `track.mutationGen` against this snapshot after the await
        // detects whether any such race happened, without needing to
        // gate `receiveInbound()` behind a lock for every send (only
        // `done=true` ones are — see `#pendingDoneAcks`).
        const genAtDispatch = track.mutationGen;
        // issue #175 (ADR-0044 F2 追補; issue #175 review round 4 — ふじ
        // design-review approve, #211 comment 2719 条件 A): reaching
        // this point already required canUseTool to allow this call
        // (operator dialog or a prior auto-allow), but that alone is
        // NOT sufficient to establish the (conversation_id, to)
        // whitelist pair — `autoAllowedPeer` is written only once the
        // SERVER has actually accepted the send (see the
        // `acceptance.kind === "accepted"` branch below), never here,
        // and never on reject/unknown. An earlier design wrote it
        // optimistically here, pre-dispatch, and needed three rounds of
        // case-by-case guards (sticky-first, `wasBlank`-gated overwrite,
        // …) to approximate the same invariant, each guard
        // reintroducing a new bug: an established peer's binding
        // revoked by a rejected different-`to` attempt, a typo'd first
        // attempt permanently squatting the slot, and a rejected peer
        // ending up auto-allowed instead of the actually-established one
        // (full failure history: #211 comment 2715). Moving the write
        // to "accepted only, unconditional overwrite" makes all of
        // those structurally impossible instead of separately guarded
        // against.
        track.turnNumber += 1;
        // receiveInbound() can advance the shared conversation track while
        // this invocation awaits a peer, but the acknowledgement must
        // describe the turn that was actually sent.
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

        // issue #177 review M2: mark this side done=true BEFORE awaiting
        // the send ack below, not after — otherwise a peer's closing
        // reply that races in (via this wrapper's own independent
        // onInterAgentMessage -> receiveInbound() path, e.g. while this
        // call is still awaiting its OWN ack) reads `localDone` as still
        // false and misclassifies a genuinely mutual close as a
        // one-sided close-proposal, enqueueing a needless reply.
        // Snapshotting the pre-flip state lets a REJECTED send (below)
        // roll it back precisely — including any `closed` transition
        // this flip alone caused — since a rejected send never reached
        // the peer and must not close this side locally. Skipped when
        // localDone is already true (idempotent repeat; nothing to roll
        // back either way).
        let localDoneSnapshot:
          | {
              localDone: boolean;
              closed: boolean;
              closedAtMs: number | undefined;
            }
          | null = null;
        // issue #177 review round 2 (ふじ差し戻し): a short per-CID gate,
        // held only while THIS optimistic flip is unconfirmed — distinct
        // from #withCidLock (which serializes invoke() vs invoke(); the
        // #cidLocks entry for this conversation_id is still held
        // throughout this gate's lifetime too, released only strictly
        // AFTER it, in the same #withCidLock callback — the two locks
        // guard different callers, not two stages of one lock).
        // receiveInbound() awaits this one (when present) before
        // computing/mutating anything off of `localDone` or `closed`, so
        // neither of two failure modes can happen: (1) an authoritative
        // CLOSED set by a concurrently-arriving inbound (peer done, or a
        // server hard-limit notice) getting reverted to OPEN by this
        // call's rollback below, restoring a pre-flip snapshot that
        // predates that inbound's legitimate mutation; (2) that SAME
        // inbound reading the still-optimistic `localDone` and handing
        // the adapter a "terminal, do not reply" disposition that turns
        // out, once this send is actually rejected, to have been wrong
        // and is by then unrecoverable (already injected into the SDK
        // queue, already skipped notePendingInjection). Released via
        // releaseGateIfHeld() in the `finally` below — unconditionally,
        // even if #dispatch() throws or its promise rejects, so a
        // transport failure can never leave this conversation_id's gate
        // stuck forever (which would hang every later receiveInbound()
        // call for it — review round 3 must-fix).
        let releaseDoneGate: (() => void) | null = null;
        if (args.done === true && !track.localDone) {
          localDoneSnapshot = {
            localDone: track.localDone,
            closed: track.closed,
            closedAtMs: track.closedAtMs,
          };
          track.localDone = true;
          if (!track.closed && track.remoteDone) {
            track.closed = true;
            track.closedAtMs = this.#nowMs();
          }
          const gate = new Promise<void>((resolve) => {
            releaseDoneGate = resolve;
          });
          this.#pendingDoneAcks.set(conversationId, gate);
        }
        const releaseGateIfHeld = (): void => {
          if (releaseDoneGate) {
            releaseDoneGate();
            this.#pendingDoneAcks.delete(conversationId);
          }
        };

        const timeoutMs = args.timeout_ms ?? DEFAULT_REPLY_TIMEOUT_MS;
        const reply = waitForResponse
          ? this.#waitForReply(conversationId, timeoutMs)
          : undefined;

        const sent = `sent to ${args.to} (conversation_id=${conversationId}, turn_number=${sentTurnNumber})`;

        // review round 3 must-fix: everything from the dispatch call
        // through the accept/reject decision runs inside try/finally so
        // releaseGateIfHeld() ALWAYS runs — including when #dispatch()
        // itself throws synchronously or its returned promise rejects
        // (the injectable `sendInterAgent` sink's type only describes the
        // resolved shape; it does not rule out either). Without this, an
        // exception here would leave the pending-done gate registered
        // forever, and every later receiveInbound() for this
        // conversation_id (`if (doneGate) await doneGate;`) would hang.
        try {
          // ふじ 30-10 must-fix M5: the acceptance ack decides the tool
          // result. Reporting "sent" for a message the server explicitly
          // refused (unknown_agent / participants_mismatch / quota) told
          // the model its delegation had landed when no peer would ever
          // see it — ADR-0051 D3-2 requires reject and timeout to surface
          // here.
          const acceptance = await this.#dispatch(envelope);

          // issue #131 / ふじ 30-10 R2: this wrapper stops owing an error
          // notice for the inbound it was injected to answer only once
          // the send actually got somewhere. A REJECTED send is not a
          // reply — clearing the pending injection there would silently
          // swallow the very notice #131 exists to produce. `unknown`
          // still clears it: the message may well have been delivered,
          // and layering an error notice on top of a delivered reply
          // would read to the peer as two contradictory answers.
          if (acceptance.kind !== "rejected") {
            this.#pendingInjections.delete(conversationId);
          }

          // issue #175 review round 4 (ふじ design-review approve, #211
          // comment 2719 条件 A/B): the (conversation_id, to) whitelist
          // pair is established HERE and ONLY here — a server-ACCEPTED
          // ack, written unconditionally (overwriting any prior peer
          // bound to this conversation_id; see `autoAllowedPeer`'s doc
          // comment on `ConversationTrack` for why that overwrite is
          // correct, not a regression). `unknown` deliberately does NOT
          // promote (条件 B): an unacknowledged send is not proof the
          // conversation is genuinely established with this peer —
          // treating it as a whitelist trigger would let a send whose
          // delivery is still unconfirmed auto-allow every later send to
          // that peer.
          if (acceptance.kind === "accepted") {
            track.autoAllowedPeer = args.to;
          }

          if (acceptance.kind === "rejected") {
            if (acceptance.reason === "conversation_closed") {
              // issue #177 review M2: the server is authoritative that
              // this CID is done — closed forever, whether or not THIS
              // wrapper ever locally observed it (e.g. after a restart,
              // or a hallucinated/reused id). Learn that into the local
              // track instead of discarding it (brand-new-delete, below)
              // or rolling back to a pre-flip snapshot: either would
              // forget the closure and let the NEXT identical
              // explicit-CID attempt round-trip to the server again — and
              // once the server's own (much shorter) tombstone TTL
              // elapses, succeed, directly undermining the wrapper's 24h
              // guard being the real enforced CID-reuse boundary
              // (protocol-inter-agent.md "CID 再利用は契約にしない").
              if (!track.closed) {
                track.closed = true;
                track.closedAtMs = this.#nowMs();
              }
            } else if (wasBlank && track.mutationGen === genAtDispatch) {
              // A track with no real history, rejected on its first real
              // attempt, represents a conversation that never actually
              // started — reset it to a blank state rather than leaving
              // it looking like a live conversation (AC6's phantom-OPEN-
              // entry concern), which also discards any optimistic
              // localDone flip on the same track (no separate rollback
              // needed for the blank case).
              //
              // issue #175 review round 4 (ふじ design-review approve,
              // #211 comment 2719 条件 A): `autoAllowedPeer` needs no
              // explicit preservation here, unlike in rounds 1-3. It is
              // never written before `#dispatch()` resolves to
              // `{kind: "accepted"}` (see that branch above), and a
              // rejected first attempt on a `wasBlank` track by
              // definition never reached it — so there is nothing to
              // preserve. `freshTrack()` does not set the field either,
              // so `Object.assign` below simply leaves whatever value it
              // already held (always `undefined` in this branch)
              // untouched.
              //
              // issue #175 review round 3 (ふじ M3, #211): guarded by
              // `track.mutationGen === genAtDispatch` in addition to
              // `wasBlank`. `wasBlank` alone told us the track was blank
              // BEFORE this call's own optimistic mutations — it says
              // nothing about whether a concurrent `receiveInbound()`
              // legitimately mutated the SAME track while `#dispatch()`
              // was in flight (see `genAtDispatch`'s doc comment).
              // Without this half, a race — non-`done` send in flight, a
              // genuine inbound (including a server-synthesized
              // hard-limit close) lands on the same conversation_id,
              // THEN this send is rejected for a reason other than
              // `conversation_closed` — would still reset here and
              // silently discard that inbound's legitimate mutation
              // (e.g. an authoritative `closed=true` reverting to OPEN).
              // `mutationGen` is bumped only when `receiveInbound()` /
              // `observeInbound()` actually changes `turnNumber` /
              // `remoteDone` / `closed` (issue #175 review round 4, ふじ
              // 条件 C — a no-op touch, e.g. a synthetic `disconnected`
              // notice, must not trip this guard), so comparing it
              // against the pre-dispatch snapshot detects exactly this:
              // unchanged means nothing raced in, safe to reset; changed
              // means fall through and leave the track as the
              // concurrent, legitimate mutation left it (below, for a
              // non-`done` send `localDoneSnapshot` is always null, so
              // nothing further runs — the concurrent write stands as
              // the final state, which is correct: it is the more
              // recent, authoritative one).
              Object.assign(track, freshTrack(track.lastActivityMs));
              delete track.closedAtMs;
            } else if (localDoneSnapshot) {
              track.localDone = localDoneSnapshot.localDone;
              track.closed = localDoneSnapshot.closed;
              // `exactOptionalPropertyTypes`: an optional field can be
              // omitted but never explicitly assigned `undefined`.
              if (localDoneSnapshot.closedAtMs === undefined) {
                delete track.closedAtMs;
              } else {
                track.closedAtMs = localDoneSnapshot.closedAtMs;
              }
            }

            // Nothing was routed, so nothing will ever reply on this
            // conversation because of this call: release the waiter
            // instead of parking the tool for the full reply timeout.
            this.#cancelReplyWait(conversationId);
            return {
              kind: "rejected",
              message: `send_to_agent failed: server rejected the message (${acceptance.reason})`,
            };
          }

          return {
            kind: "dispatched",
            acceptance,
            sentTurnNumber,
            sent,
            reply,
            timeoutMs,
          };
        } finally {
          // Final either way — accepted/unknown confirms localDone as
          // sent (nothing to roll back), rejected has already applied its
          // rollback/learn decision above; an uncaught exception leaves
          // the track exactly as the optimistic flip left it, which is
          // the same "assume nothing changed" posture the rest of this
          // method takes when #dispatch's contract is violated.
          releaseGateIfHeld();
        }
      },
    );

    if (outcome.kind !== "dispatched") {
      return errorResult(outcome.message);
    }
    const { acceptance, sentTurnNumber, sent, reply, timeoutMs } = outcome;

    // ふじ 30-10 R3: a peer reply that has ALREADY landed is proof the
    // message was delivered, whatever happened to the acceptance ack. The
    // waiter is gone from the map exactly when it has settled, so consume
    // it before deciding — otherwise a lost ack threw away a reply the
    // caller was synchronously waiting for and reported "delivery unknown".
    let settledReply: Envelope | undefined;
    if (
      acceptance.kind === "unknown" &&
      reply !== undefined &&
      !this.#replyWaiters.has(conversationId)
    ) {
      settledReply = await reply;
    }

    if (acceptance.kind === "unknown" && settledReply === undefined) {
      // Still no evidence either way (no waiter, or the reply window itself
      // expired without an envelope).
      this.#cancelReplyWait(conversationId);
      return {
        content: [
          {
            type: "text",
            text:
              `send_to_agent delivery unknown: ${sent}; the server never ` +
              `acknowledged it (${acceptance.reason}). It may or may not ` +
              `have been delivered — resending could duplicate it.`,
          },
        ],
      };
    }

    if (!reply) {
      return { content: [{ type: "text", text: sent }] };
    }

    const inbound = settledReply ?? (await reply);
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

  /** Pushes through the acceptance-aware sink when one is wired, else falls
   *  back to the fire-and-forget sink and assumes acceptance (see
   *  `sendInterAgent` in the options). */
  #dispatch(envelope: Envelope): Promise<InterAgentAcceptance> {
    const sink = this.#options.sendInterAgent;
    if (sink === undefined) {
      this.#options.send(envelope);
      return Promise.resolve({ kind: "accepted", stamp: null });
    }
    return sink(envelope);
  }

  /** Settles a pending `wait_for_response` waiter as "no reply" without
   *  waiting out its timer. */
  #cancelReplyWait(conversationId: string): void {
    const waiter = this.#replyWaiters.get(conversationId);
    if (waiter === undefined) return;
    clearTimeout(waiter.timeout);
    this.#replyWaiters.delete(conversationId);
    waiter.resolve(undefined);
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

/** Canonical lead-in prefixes for the `[Inter-agent message...]` line
 *  (issue #177 review S4). `reply-owed` has its own distinct wording;
 *  `close-proposal` and `terminal` share the same lead-in up to the
 *  conversation_id — only the guidance text after it differs (see
 *  `markerLine()`). `isFormattedInterAgentMessage()` and resume
 *  reconstruction (#105) key on these EXACT prefixes rather than a short
 *  generic "[Inter-agent message" fragment, so unrelated text that merely
 *  happens to start with that fragment cannot be mistaken for a genuine
 *  injection. Do not trim either constant: an operator quoting one later
 *  in ordinary text must remain an ordinary user log during resume
 *  reconstruction. */
const REPLY_OWED_MARKER_PREFIX =
  '[Inter-agent message — to reply, call send_to_agent with conversation_id="';
const CLOSING_MARKER_PREFIX = '[Inter-agent message — conversation_id="';

/** True only for the reserved first-line framing injected into an SDK
 *  turn — either canonical prefix above. */
export function isFormattedInterAgentMessage(text: string): boolean {
  return (
    text.startsWith(REPLY_OWED_MARKER_PREFIX) ||
    text.startsWith(CLOSING_MARKER_PREFIX)
  );
}

/** issue #177: the full leading marker line per {@link InboundReplyMode},
 *  built from the canonical prefixes above (single source of truth with
 *  `isFormattedInterAgentMessage()`). `reply-owed` is byte-identical to
 *  the pre-#177 wording — existing callers and tests depend on the exact
 *  string. `close-proposal` / `terminal` deliberately do NOT say "to
 *  reply, call send_to_agent" (AC7/AC8: no reply directive once a close is
 *  on the table) — folding that into the LEADING line rather than a
 *  trailing disclaimer is what actually stops a model from acting on an
 *  instruction-shaped opener before it reads the rest of the message.
 *  `terminal`'s text is reason-neutral (issue #177 review S3): closed
 *  (terminal) has two routes — mutual done, OR a server hard-limit
 *  escalate — so it must not assert "both sides signalled done" when the
 *  real cause may have been a hard limit. */
function markerLine(conversationId: string, mode: InboundReplyMode): string {
  switch (mode) {
    case "reply-owed":
      return `${REPLY_OWED_MARKER_PREFIX}${conversationId}".]`;
    case "close-proposal":
      return (
        `${CLOSING_MARKER_PREFIX}${conversationId}": the peer signalled ` +
        "done=true, proposing to close. Reply once with done=true to " +
        "close it too, or send a substantive response to continue.]"
      );
    case "terminal":
      return (
        `${CLOSING_MARKER_PREFIX}${conversationId}" is now closed. This ` +
        "message is informational only — do not call send_to_agent for it.]"
      );
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
 *  fields collapse to empty.
 *
 *  `mode` (issue #177, default `"reply-owed"`) changes the leading marker
 *  line's guidance text — see {@link InboundReplyMode} and `markerLine()`.
 *  Everything after it (from/kind/body/meta) is unchanged across modes. */
export function formatInboundMessage(
  envelope: Envelope,
  opts?: { mode?: InboundReplyMode },
): string {
  const payload = envelope.payload as Partial<InterAgentMessagePayload>;
  const from = envelope.agent_id;
  const kind = payload.kind ?? "inform";
  const body = payload.body ?? "";
  const done = payload.meta?.done === true;
  const proposeNext = payload.meta?.propose_next ?? "";
  const conversationId = payload.conversation_id ?? "";
  const turnNumber = payload.turn_number ?? 0;
  const error = payload.error;
  const mode = opts?.mode ?? "reply-owed";
  // issue #131: an error notice gets its own line format — a plain
  // "kind: body" render would bury the machine-readable code the receiving
  // model needs to decide whether retrying is worthwhile.
  const messageLine = error
    ? `[from ${from}] peer-error(${error.code}): ${error.message} — ${errorGuidance(error.code)}.`
    : `[from ${from}] ${kind}: ${body}`;
  return [
    markerLine(conversationId, mode),
    "",
    messageLine,
    "",
    `(meta: done=${done}, propose_next=${proposeNext}, conversation_id=${conversationId}, turn_number=${turnNumber})`,
  ].join("\n");
}

/** Formats one or more inbound envelopes from the SAME peer into the text
 *  injected for a single (possibly coalesced) SDK turn (issue #221 段階3,
 *  direction 2 — coalescing unit is same-peer). A single-item batch returns
 *  EXACTLY `formatInboundMessage()`'s own output, unchanged — the common,
 *  idle-wrapper case (busy-trigger flush with nothing else queued) must not
 *  see a different wire format than before this feature existed. Two or
 *  more items get a preamble plus each item's own
 *  `formatInboundMessage()` block (own marker line, own conversation_id),
 *  joined in the given order — callers must already supply `items` in
 *  receipt order (issue #221 AC: 順序は保つこと); this function does not
 *  sort. Batching only changes how many of these blocks share one turn,
 *  never an individual block's own content, so the model can still address
 *  a reply to the RIGHT conversation_id from a mixed batch. */
export function formatInboundMessages(
  items: readonly { envelope: Envelope; mode: InboundReplyMode }[],
): string {
  if (items.length === 1) {
    return formatInboundMessage(items[0]!.envelope, { mode: items[0]!.mode });
  }
  const preamble =
    `[${items.length} pending inter-agent messages from the same peer, ` +
    "in receipt order — reply to each conversation_id separately]";
  const blocks = items.map(({ envelope, mode }) =>
    formatInboundMessage(envelope, { mode }),
  );
  return [preamble, "", blocks.join("\n\n---\n\n")].join("\n");
}

function errorResult(text: string): InterAgentToolResult {
  return {
    content: [{ type: "text", text }],
    isError: true,
  };
}
