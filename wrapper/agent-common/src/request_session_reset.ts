// `request_session_reset` — the agent-initiated fresh-session tool
// (phase-28 C2, ADR-0043). Same structural choices as `request_compact`
// (claude-code/src/request_compact.ts): it lives OUTSIDE
// InterAgentTool#descriptors(), and each engine adapter registers it behind
// its own per-call operator approval (ADR-0043 D4 / #168 決定 P2). On Claude
// its absence from the auto-allow default (read_only_tools.ts) routes the
// call through canUseTool → PermissionBroker; on codex the adapter wraps it
// in `operatorApprovalGated` (approval_gate.ts), which calls the same broker
// from inside the MCP call (issue #347).
//
// What differs from B2 is WHEN the effect happens. A compaction is queued as
// an ordinary turn; a reset kills this wrapper process and relaunches it, so
// it must not land inside a turn (ADR-0043 D3). The tool therefore only
// RESERVES; `SessionResetCoordinator` fires the reservation once the host has
// finished processing that turn's result, which is the wrapper's own turn
// boundary. The server then applies the same gate operator-initiated resets
// go through, so a reservation can still be refused after approval.

import { fitsApprovalPayload, MAX_INPUT_BYTES } from "./permission.js";
import type { ToolDescriptor, ToolResult } from "./tooling.js";
import { z } from "zod";

/** Full SDK-side tool name once mcpServers register the kaoiro server. */
export const REQUEST_SESSION_RESET_TOOL_FQN =
  "mcp__kaoiro__request_session_reset";

export type SessionResetMode = "new" | "clear";

const SESSION_RESET_MODES: readonly SessionResetMode[] = ["new", "clear"];

/** Delay before the single retry (phase-28 C2). Sized against the server's
 *  2 s dispatch cooldown (SessionResets `@dispatch_cooldown_ms`), which
 *  answers `agent_busy` for a request that arrives while the wrapper's own
 *  state_change is still in flight — the most likely refusal right after a
 *  turn boundary, and the one a retry actually fixes. */
export const SESSION_RESET_RETRY_DELAY_MS = 2_500;

/** What a refusal actually establishes (phase-28 CR-MF2).
 *
 *  - `retryable` — the server definitively did not start a reset, and the
 *    condition is one a moment's wait clears. Only this is retried.
 *  - `refused` — the server definitively did not start a reset, and retrying
 *    changes nothing. No retry, but "it did not happen" is a true statement.
 *  - `unconfirmed` — the outcome is NOT known. A push timeout does not mean
 *    the server never received the request, and `session_reset_pending` may
 *    well be OUR OWN reset already running (first push accepted, its reply
 *    lost). Claiming "not carried out" here would be a lie the agent then
 *    acts on. */
type ResetRefusalOutcome = "retryable" | "refused" | "unconfirmed";

/** Refusals that establish "no reset was started" without being worth a
 *  retry. Scoped to the four-value reply contract of `session_reset_request`
 *  (protocol.md): the engine cannot reset at all — which is also where the
 *  channel normalises a malformed request — or the runner is simply not
 *  there. Reasons from other reset paths never reach this endpoint, and
 *  anything unrecognised is collapsed to `unknown_error` by the transport
 *  before it gets here. */
const DETERMINED_REFUSALS: ReadonlySet<string> = new Set([
  "unsupported_session_reset",
  "runner_unavailable",
]);

/** Everything not named is `unconfirmed` — including `timeout`,
 *  `session_reset_pending`, `spawn_failed` / `rollback_failed` (the reset was
 *  attempted and the session's state is now in question) and the
 *  `unknown_error` collapse. Defaulting to "we do not know" is the safe
 *  direction: the honest message costs the agent a little caution, the
 *  confident one costs it a wrong assumption about its own context. */
function classifyRefusal(reason: string): ResetRefusalOutcome {
  if (reason === "agent_busy") return "retryable";
  return DETERMINED_REFUSALS.has(reason) ? "refused" : "unconfirmed";
}

const REQUEST_SESSION_RESET_DESCRIPTION =
  "Ask the operator to approve starting this session over from empty. `mode: \"new\"` keeps the operator's visible transcript and begins a fresh session below it; `mode: \"clear\"` also blanks your pane, leaving only the boundary marker. Either way the new session starts with NO memory of this conversation — unlike compaction, nothing is summarized and nothing is carried across. Write down anything you still need BEFORE calling this: a file, WORKLOG, an issue, a message to a peer. Work that exists only in this conversation is gone once the reset runs. The call returns as soon as the reset is RESERVED; it is applied at the end of the current turn, not immediately, and the server can still refuse it then (you are told in the next turn if it does). Use this when the conversation itself has become the problem — accumulated dead ends, a finished task whose context is now noise — rather than as routine hygiene.";

/** Appended only where `request_compact` is actually registered (Claude);
 *  codex has no compaction path and must not be pointed at a tool it
 *  cannot see. */
const REQUEST_SESSION_RESET_COMPACT_HINT =
  " If you only need headroom and want to keep continuity, request_compact is the smaller tool.";

const REQUEST_SESSION_RESET_INPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    mode: {
      type: "string",
      enum: [...SESSION_RESET_MODES],
      description:
        'Whether to keep the operator\'s visible transcript ("new") or blank the pane too ("clear"). Both start an empty session.',
    },
    reason: {
      type: "string",
      description:
        "One sentence on why a fresh session is warranted now. Shown to the operator in the approval dialog.",
    },
  },
  required: ["mode"],
  additionalProperties: false,
};

/** Zod mirror of REQUEST_SESSION_RESET_INPUT_SCHEMA (see the note on
 *  REQUEST_COMPACT_INPUT_SHAPE). `mode` is required on both sides — a reset
 *  with no mode has no sensible default. */
export const REQUEST_SESSION_RESET_INPUT_SHAPE = {
  mode: z.enum(["new", "clear"]),
  reason: z.string().optional(),
};

export interface RequestSessionResetOptions {
  /** Records the approved reservation. Fires at the next turn boundary, not
   *  here — see `SessionResetCoordinator`. */
  reserve: (mode: SessionResetMode, reason?: string) => void;
  /** Whether the description may point the model at `request_compact` as
   *  the lighter alternative. Default true (Claude registers both); the
   *  codex adapter passes false because it registers no compaction tool. */
  offerCompact?: boolean;
}

/** Validates a `request_session_reset` input before anything acts on it.
 *  Exported for the codex approval gate, which runs it BEFORE the operator
 *  is asked: the bridge does not validate against `inputSchema`, so
 *  without this an oversized `reason` would reach the dialog as
 *  `truncated` and a malformed mode would fail only after the operator
 *  already approved. */
export function validateRequestSessionResetInput(
  input: Record<string, unknown>,
): { ok: true } | { ok: false; message: string } {
  const mode = input.mode;
  if (mode !== "new" && mode !== "clear") {
    return {
      ok: false,
      message: `needs mode "new" or "clear"; got ${JSON.stringify(mode)}`,
    };
  }
  if (input.reason !== undefined && typeof input.reason !== "string") {
    return { ok: false, message: "reason must be a string when given" };
  }
  if (!fitsApprovalPayload(input)) {
    return {
      ok: false,
      message:
        `the input is over the ${MAX_INPUT_BYTES} byte approval-payload ` +
        "ceiling once serialized. Shorten reason and retry.",
    };
  }
  return { ok: true };
}

/** The `request_session_reset` descriptor. The Claude adapter registers it
 *  on its SDK MCP server; the codex adapter registers it on the bridge
 *  wrapped in `operatorApprovalGated`. */
export function requestSessionResetDescriptor(
  options: RequestSessionResetOptions,
): ToolDescriptor {
  return {
    name: "request_session_reset",
    description:
      REQUEST_SESSION_RESET_DESCRIPTION +
      (options.offerCompact === false ? "" : REQUEST_SESSION_RESET_COMPACT_HINT),
    inputSchema: REQUEST_SESSION_RESET_INPUT_SCHEMA,
    handler: async (input) => {
      const mode = input.mode;
      if (mode !== "new" && mode !== "clear") {
        return errorResult(
          `request_session_reset needs mode "new" or "clear"; got ${JSON.stringify(mode)}`,
        );
      }
      const trimmed = typeof input.reason === "string" ? input.reason.trim() : "";
      try {
        options.reserve(mode, trimmed === "" ? undefined : trimmed);
      } catch (err) {
        return errorResult(`request_session_reset failed: ${String(err)}`);
      }
      // The reason is NOT echoed here. It travels only in the server payload
      // (ADR-0043 D1), which the server copies to the operator's lifecycle
      // broadcast — repeating it to the model that wrote it adds nothing and
      // widens where model-authored text can appear.
      return {
        content: [
          {
            type: "text",
            text:
              `session reset (${mode}) reserved. It is applied after this ` +
              "turn finishes, and the server may still refuse it then — you " +
              "will be told in the next turn if it does. If anything from " +
              "this conversation still matters, write it somewhere durable " +
              "before the turn ends.",
          },
        ],
      };
    },
  };
}

export interface SessionResetCoordinatorOptions {
  /** Pushes `session_reset_request` and settles with the server's reply,
   *  normally `ServerLink#requestSessionReset`. Its requestId proves only
   *  that the server reserved the reset; it correlates any terminal failure
   *  pushed back while this old wrapper is still alive (#258). */
  request: (
    mode: SessionResetMode,
    reason?: string,
  ) => Promise<SessionResetAccepted>;
  /** Queues a turn telling the agent the reset did not happen. Should ride
   *  the same serialization every other injection uses (cli.ts's instruction
   *  chain), so it cannot overtake a turn queued before it. */
  notify: (text: string) => Promise<void>;
  /** Emits an operator-visible line. */
  log: (text: string) => void;
  /** Overridable for tests; defaults to `SESSION_RESET_RETRY_DELAY_MS`. */
  retryDelayMs?: number;
  /** Overridable for tests; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
}

export interface SessionResetAccepted {
  requestId: string;
}

/** How a turn ended, as far as the reset boundary is concerned (issue #347
 *  M1). `authoritative` is true only when the engine itself declared the
 *  turn's terminal — a Claude ResultMessage, a codex `turn.completed` /
 *  `turn.failed`. A stream that merely ended, a rejected run, an interrupt
 *  or a watchdog stop is NOT a boundary the reset may ride: the turn's
 *  outcome is unknown and the model was never told its call completed. */
export interface TurnBoundary {
  turnToken: string;
  authoritative: boolean;
  /** Adapter-supplied cause for a non-authoritative end, used verbatim in
   *  the agent's cancellation notice (e.g. an operator interrupt whose
   *  terminal the SDK still delivered). Default wording when absent. */
  why?: string;
}

/** Holds an approved reset until the wrapper's own turn boundary, then sends
 *  it (ADR-0043 D3).
 *
 *  Failure handling: one retry after a short delay, then the agent is told in
 *  a turn of its own and the operator sees a log line. A refusal is never
 *  swallowed — an agent that believes it reset but did not would keep writing
 *  as if its context were about to be replaced. */
export class SessionResetCoordinator {
  readonly #options: SessionResetCoordinatorOptions;
  /** `owner` is the engine turn that made the reservation, when the
   *  adapter tracks one; a boundary for any other turn discards it. */
  #reserved: {
    mode: SessionResetMode;
    reason?: string;
    owner?: string;
  } | null = null;
  /** True from the moment a reservation is dispatched until its (possibly
   *  retried) outcome is known. A successful request replaces this process,
   *  so the flag mostly guards the failure path from re-entering on the
   *  turn the failure notice itself creates. */
  #dispatching = false;
  /** The accepted reset this old process is waiting to be replaced by. A
   *  successful reset kills this process, so only a terminal failure should
   *  consume this state and create a notice. */
  #accepted: { requestId: string; mode: SessionResetMode } | null = null;
  /** A fast runner failure may race ahead of the request's Phoenix `ok`
   *  callback. There can be at most one local dispatch, so retain one event
   *  until its request_id can be compared rather than losing it. */
  #earlyFailure: { requestId: string; reason: string } | null = null;

  constructor(options: SessionResetCoordinatorOptions) {
    this.#options = options;
  }

  /** Records an operator-approved reservation. A second reservation before
   *  the boundary replaces the first: both were approved individually, only
   *  one reset can happen, and the later call is the agent's current
   *  intent. `owner` binds it to the engine turn that made it (see
   *  `TurnBoundary`); adapters without a turn identity omit it. */
  reserve(mode: SessionResetMode, reason?: string, owner?: string): void {
    this.#reserved = {
      mode,
      ...(reason !== undefined ? { reason } : {}),
      ...(owner !== undefined ? { owner } : {}),
    };
  }

  /** True while a reservation is waiting for the next turn boundary. */
  get pending(): boolean {
    return this.#reserved !== null;
  }

  /** Receives the server's terminal lifecycle failure. This must be called
   *  only with transport-narrowed values. A different request id belongs to a
   *  stale/other wrapper and is ignored, so it cannot manufacture a notice in
   *  this session. */
  onResetFailed(requestId: string, reason: string): void {
    const accepted = this.#accepted;
    if (accepted !== null) {
      if (accepted.requestId !== requestId) return;
      this.#accepted = null;
      void this.#report(accepted.mode, reason, "lifecycle");
      return;
    }
    if (this.#dispatching && this.#earlyFailure === null) {
      this.#earlyFailure = { requestId, reason };
    }
  }

  /** Call once per turn end, AFTER the turn's result has been handled.
   *  Returns immediately; the request runs in the background so a slow or
   *  retrying server never stalls the host's run loop.
   *
   *  Without `boundary` (the Claude adapter, whose only turn end is the
   *  SDK's ResultMessage) every call is a boundary. With it, the
   *  reservation is consumed either way — dispatched on the owner turn's
   *  authoritative terminal, discarded with a notice on anything else — so
   *  it can never ride a later, unrelated turn's end. */
  onTurnEnd(boundary?: TurnBoundary): void {
    const reservation = this.#reserved;
    if (reservation === null) return;
    if (boundary !== undefined) {
      // An owner-bound reservation cannot be held for a later boundary the
      // way the unbound (Claude) one is: the next boundary belongs to
      // another turn and would drop it with a misleading reason. Settle it
      // now, with the true cause. What the notice may promise depends on
      // whether an earlier request is still being carried out, whichever
      // branch drops this one.
      const outcome = this.#dispatching ? "prior_pending" : "unchanged";
      const why = !boundary.authoritative
        ? (boundary.why ??
          "the turn that reserved it ended without a confirmed result")
        : reservation.owner !== undefined &&
            reservation.owner !== boundary.turnToken
          ? "reserved by a turn that is no longer active"
          : this.#dispatching
            ? "another reset request is still in flight"
            : null;
      if (why !== null) {
        this.#reserved = null;
        void this.#reportCancelled(reservation.mode, why, outcome);
        return;
      }
    }
    if (this.#dispatching) return;
    this.#reserved = null;
    this.#earlyFailure = null;
    this.#dispatching = true;
    void this.#dispatch(reservation).finally(() => {
      this.#dispatching = false;
    });
  }

  /** A reservation dropped at a non-boundary is reported like a refusal:
   *  the model was told "reserved" and must not keep acting as if its
   *  context were about to be replaced. `outcome` says what the notice may
   *  promise: `unchanged` — no reset of any kind is pending, so the
   *  context stays; `prior_pending` — only this later reservation was
   *  dropped while an earlier request is still being carried out, so
   *  nothing about the context can be promised yet. */
  async #reportCancelled(
    mode: SessionResetMode,
    why: string,
    outcome: "unchanged" | "prior_pending",
  ): Promise<void> {
    this.#options.log(`session reset (${mode}) reservation cancelled: ${why}`);
    const text =
      outcome === "unchanged"
        ? `[kaoiro] The session reset you reserved (mode: ${mode}) was cancelled: ${why}. ` +
          "Your context is unchanged, so continue as you were. You may request it " +
          "again at a better moment; the operator has to approve it again."
        : `[kaoiro] The session reset you reserved (mode: ${mode}) was cancelled: ${why}. ` +
          "Only this later reservation was dropped; the earlier reset request is " +
          "still being carried out and its outcome is not known yet. Do not request " +
          "another reset, and keep anything you still need written somewhere durable " +
          "until the earlier request is resolved.";
    await this.#options
      .notify(text)
      .catch((err: unknown) => {
        this.#options.log(
          `could not inject the session reset cancellation notice: ${String(err)}`,
        );
      });
  }

  async #dispatch(reservation: {
    mode: SessionResetMode;
    reason?: string;
  }): Promise<void> {
    const first = await this.#attempt(reservation);
    if (typeof first !== "string") {
      this.#acceptOrReportEarlyFailure(reservation.mode, first);
      return;
    }
    let reason = first;
    // Retry ONLY a refusal that establishes nothing happened AND is worth
    // re-sending (CR-MF2). Re-sending after a timeout could hand the server
    // a second reset for a request it already accepted.
    if (classifyRefusal(reason) === "retryable") {
      this.#options.log(
        `セッションリセット (${reservation.mode}) が拒否されました: ${reason}。再試行します`,
      );
      const sleep =
        this.#options.sleep ??
        ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
      await sleep(this.#options.retryDelayMs ?? SESSION_RESET_RETRY_DELAY_MS);
      const second = await this.#attempt(reservation);
      if (typeof second !== "string") {
        this.#acceptOrReportEarlyFailure(reservation.mode, second);
        return;
      }
      reason = second;
    }
    await this.#report(reservation.mode, reason);
  }

  /** Tells the agent — and the operator — what is known. A refusal that was
   *  retried and refused again IS determined, so only a genuinely unknown
   *  outcome gets the hedged wording. */
  #acceptOrReportEarlyFailure(
    mode: SessionResetMode,
    accepted: SessionResetAccepted,
  ): void {
    this.#accepted = { requestId: accepted.requestId, mode };
    const early = this.#earlyFailure;
    this.#earlyFailure = null;
    if (early === null || early.requestId !== accepted.requestId) return;
    this.#accepted = null;
    void this.#report(mode, early.reason, "lifecycle");
  }

  async #report(
    mode: SessionResetMode,
    reason: string,
    source: "request" | "lifecycle" = "request",
  ): Promise<void> {
    // A request-push timeout is ambiguous, but a terminal lifecycle failure
    // comes from the server's resolved SessionResets transaction. In the
    // latter case even `timeout` is a confirmed non-reset, not a guess.
    const unconfirmed =
      source === "request" && classifyRefusal(reason) === "unconfirmed";
    this.#options.log(
      unconfirmed
        ? `セッションリセット (${mode}) の結果を確認できませんでした: ${reason}`
        : `セッションリセット (${mode}) は実行されませんでした: ${reason}`,
    );
    // The unconfirmed wording states only what is known. It deliberately
    // offers no deadline after which the reset "did not run" (CR-MF2-R): the
    // server's reset transaction runs on its own 60 s timeout with no
    // relation to this wrapper's turn boundaries, so a short turn can easily
    // end before an accepted reset replaces the process. The only
    // authoritative answers are the process actually being replaced or an
    // operator-visible lifecycle event — neither of which this notice can
    // promise.
    const text = unconfirmed
      ? `[kaoiro] The session reset you requested (mode: ${mode}) could not be confirmed: ${reason}. ` +
        "This does NOT mean it was cancelled — the request may have reached the server and a reset " +
        "may still be running. Do not assume your context is about to be replaced, and do not assume " +
        "it is safe either. Do not request another reset. Keep working in a way that is safe under " +
        "both outcomes: make sure anything you still need is written somewhere durable."
      : `[kaoiro] The session reset you requested (mode: ${mode}) was not carried out. ` +
        `The server refused it: ${reason}. Your context is unchanged, so continue as you were. ` +
        "You may request it again at a better moment; the operator has to approve it again.";
    await this.#options.notify(text).catch((err: unknown) => {
      this.#options.log(
        `セッションリセット結果の通知を注入できませんでした: ${String(err)}`,
      );
    });
  }

  /** Returns the accepted request id, otherwise the refusal reason. */
  async #attempt(reservation: {
    mode: SessionResetMode;
    reason?: string;
  }): Promise<SessionResetAccepted | string> {
    try {
      return await this.#options.request(reservation.mode, reservation.reason);
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }
}

function errorResult(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}
