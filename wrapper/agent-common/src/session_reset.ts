import type { ToolDescriptor, ToolResult } from "./tooling.js";
import { z } from "zod";

export const REQUEST_SESSION_RESET_TOOL_FQN =
  "mcp__kaoiro__request_session_reset";

export type SessionResetMode = "new" | "clear";

const SESSION_RESET_MODES: readonly SessionResetMode[] = ["new", "clear"];

export const SESSION_RESET_RETRY_DELAY_MS = 2_500;

type ResetRefusalOutcome = "retryable" | "refused" | "unconfirmed";

const DETERMINED_REFUSALS: ReadonlySet<string> = new Set([
  "unsupported_session_reset",
  "runner_unavailable",
]);

function classifyRefusal(reason: string): ResetRefusalOutcome {
  if (reason === "agent_busy") return "retryable";
  return DETERMINED_REFUSALS.has(reason) ? "refused" : "unconfirmed";
}

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

export const REQUEST_SESSION_RESET_INPUT_SHAPE = {
  mode: z.enum(["new", "clear"]),
  reason: z.string().optional(),
};

export interface RequestSessionResetOptions {
  reserve: (mode: SessionResetMode, reason?: string) => void;
}

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
  request: (
    mode: SessionResetMode,
    reason?: string,
  ) => Promise<SessionResetAccepted>;
  notify: (text: string) => Promise<void>;
  log: (text: string) => void;
  retryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface SessionResetAccepted {
  requestId: string;
}

/** Coordinates one reset reservation across an engine's turn and transport
 * boundaries. The adapter owns both callback wires; their shared semantics
 * belong here so the exposed engines cannot drift. */
export class SessionResetCoordinator {
  readonly #options: SessionResetCoordinatorOptions;
  #reserved: { mode: SessionResetMode; reason?: string } | null = null;
  #dispatching = false;
  #accepted: { requestId: string; mode: SessionResetMode } | null = null;
  #earlyFailure: { requestId: string; reason: string } | null = null;

  constructor(options: SessionResetCoordinatorOptions) {
    this.#options = options;
  }

  reserve(mode: SessionResetMode, reason?: string): void {
    this.#reserved = { mode, ...(reason !== undefined ? { reason } : {}) };
  }

  get pending(): boolean {
    return this.#reserved !== null;
  }

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

  onTurnEnd(): void {
    const reservation = this.#reserved;
    if (reservation === null || this.#dispatching) return;
    this.#reserved = null;
    this.#earlyFailure = null;
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
    if (typeof first !== "string") {
      this.#acceptOrReportEarlyFailure(reservation.mode, first);
      return;
    }
    let reason = first;
    if (classifyRefusal(reason) === "retryable") {
      this.#options.log(
        `セッションリセット (${reservation.mode}) が拒否されました: ${reason}。再試行します`,
      );
      const sleep =
        this.#options.sleep ??
        ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
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
    const unconfirmed =
      source === "request" && classifyRefusal(reason) === "unconfirmed";
    this.#options.log(
      unconfirmed
        ? `セッションリセット (${mode}) の結果を確認できませんでした: ${reason}`
        : `セッションリセット (${mode}) は実行されませんでした: ${reason}`,
    );
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
