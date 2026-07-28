// `request_session_reset` — the agent-initiated fresh-session tool
// (phase-28 C2, ADR-0043). Same structural choices as `request_compact`
// (request_compact.ts): it lives OUTSIDE InterAgentTool#descriptors() because
// codex builds its stdio bridge from that list and has no reset path, and its
// absence from the auto-allow default (read_only_tools.ts) is what routes the
// call through canUseTool → PermissionBroker for per-call operator approval
// (ADR-0043 D4 / #168 決定 P2).
//
// What differs from B2 is WHEN the effect happens. A compaction is queued as
// an ordinary turn; a reset kills this wrapper process and relaunches it, so
// it must not land inside a turn (ADR-0043 D3). The tool therefore only
// RESERVES; `SessionResetCoordinator` fires the reservation once the host has
// finished processing that turn's result, which is the wrapper's own turn
// boundary. The server then applies the same gate operator-initiated resets
// go through, so a reservation can still be refused after approval.

import type { ToolDescriptor, ToolResult } from "@kaoiro/agent-common";
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

const REQUEST_SESSION_RESET_DESCRIPTION =
  "Ask the operator to approve starting this session over from empty. `mode: \"new\"` keeps the operator's visible transcript and begins a fresh session below it; `mode: \"clear\"` also blanks your pane, leaving only the boundary marker. Either way the new session starts with NO memory of this conversation — unlike compaction, nothing is summarized and nothing is carried across. Write down anything you still need BEFORE calling this: a file, WORKLOG, an issue, a message to a peer. Work that exists only in this conversation is gone once the reset runs. The call returns as soon as the reset is RESERVED; it is applied at the end of the current turn, not immediately, and the server can still refuse it then (you are told in the next turn if it does). Use this when the conversation itself has become the problem — accumulated dead ends, a finished task whose context is now noise — rather than as routine hygiene. If you only need headroom and want to keep continuity, request_compact is the smaller tool.";

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
}

/** The `request_session_reset` descriptor. Registered by the Claude adapter's
 *  `buildKaoiroMcpServer`; codex never sees it. */
export function requestSessionResetDescriptor(
  options: RequestSessionResetOptions,
): ToolDescriptor {
  return {
    name: "request_session_reset",
    description: REQUEST_SESSION_RESET_DESCRIPTION,
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
   *  normally `ServerLink#requestSessionReset`. Rejects with the server's
   *  closed-vocabulary reason (ADR-0036 F7). */
  request: (mode: SessionResetMode, reason?: string) => Promise<void>;
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

/** Holds an approved reset until the wrapper's own turn boundary, then sends
 *  it (ADR-0043 D3).
 *
 *  Failure handling: one retry after a short delay, then the agent is told in
 *  a turn of its own and the operator sees a log line. A refusal is never
 *  swallowed — an agent that believes it reset but did not would keep writing
 *  as if its context were about to be replaced. */
export class SessionResetCoordinator {
  readonly #options: SessionResetCoordinatorOptions;
  #reserved: { mode: SessionResetMode; reason?: string } | null = null;
  /** True from the moment a reservation is dispatched until its (possibly
   *  retried) outcome is known. A successful request replaces this process,
   *  so the flag mostly guards the failure path from re-entering on the
   *  turn the failure notice itself creates. */
  #dispatching = false;

  constructor(options: SessionResetCoordinatorOptions) {
    this.#options = options;
  }

  /** Records an operator-approved reservation. A second reservation before
   *  the boundary replaces the first: both were approved individually, only
   *  one reset can happen, and the later call is the agent's current
   *  intent. */
  reserve(mode: SessionResetMode, reason?: string): void {
    this.#reserved = { mode, ...(reason !== undefined ? { reason } : {}) };
  }

  /** True while a reservation is waiting for the next turn boundary. */
  get pending(): boolean {
    return this.#reserved !== null;
  }

  /** Call once per turn boundary, AFTER the turn's result has been handled.
   *  Returns immediately; the request runs in the background so a slow or
   *  retrying server never stalls the host's run loop. */
  onTurnEnd(): void {
    const reservation = this.#reserved;
    if (reservation === null || this.#dispatching) return;
    this.#reserved = null;
    this.#dispatching = true;
    void this.#dispatch(reservation).finally(() => {
      this.#dispatching = false;
    });
  }

  async #dispatch(reservation: {
    mode: SessionResetMode;
    reason?: string;
  }): Promise<void> {
    const first = await this.#attempt(reservation);
    if (first === null) return;
    this.#options.log(
      `セッションリセット (${reservation.mode}) が拒否されました: ${first}。再試行します`,
    );
    const sleep =
      this.#options.sleep ??
      ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    await sleep(this.#options.retryDelayMs ?? SESSION_RESET_RETRY_DELAY_MS);
    const second = await this.#attempt(reservation);
    if (second === null) return;
    this.#options.log(
      `セッションリセット (${reservation.mode}) は実行されませんでした: ${second}`,
    );
    await this.#options
      .notify(
        `[kaoiro] The session reset you requested (mode: ${reservation.mode}) was not carried out. ` +
          `The server refused it: ${second}. Your context is unchanged, so continue as you were. ` +
          "You may request it again at a better moment; the operator has to approve it again.",
      )
      .catch((err: unknown) => {
        this.#options.log(
          `セッションリセット失敗の通知を注入できませんでした: ${String(err)}`,
        );
      });
  }

  /** Returns null when the server accepted, otherwise the refusal reason. */
  async #attempt(reservation: {
    mode: SessionResetMode;
    reason?: string;
  }): Promise<string | null> {
    try {
      await this.#options.request(reservation.mode, reservation.reason);
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }
}

function errorResult(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}
