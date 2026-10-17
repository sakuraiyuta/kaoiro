// `request_peer_session_reset` — a director starts a peer's session over
// (issue #677). Unlike `request_session_reset` (request_session_reset.ts) it
// RESERVES nothing: the requester is not the process that gets replaced, so
// there is no turn boundary to wait for and the request goes out at once.
// Authority is decided by the server from its work record (director,
// assignee, active, epoch); the wrapper only forwards what the model typed
// and never claims to know the answer. The approval class matches
// `request_session_reset` (heavy): each engine adapter registers it exactly
// where it registers that tool, so the operator's mode-dependent approval
// applies unchanged (Claude: absent from READ_ONLY_TOOLS so it rides
// canUseTool; Codex / Antigravity: `operatorApprovalGated`).

import type {
  PeerSessionResetCall,
  PeerSessionResetNotice,
  PeerSessionResetRequestInput,
} from "@kaoiro/wrapper-core";
import { fitsApprovalPayload, MAX_INPUT_BYTES } from "./permission.js";
import type { ToolDescriptor, ToolResult } from "./tooling.js";
import { z } from "zod";

export type {
  PeerSessionResetCall,
  PeerSessionResetNotice,
  PeerSessionResetRequestInput,
} from "@kaoiro/wrapper-core";

/** Full SDK-side tool name once mcpServers register the kaoiro server. */
export const REQUEST_PEER_SESSION_RESET_TOOL_FQN =
  "mcp__kaoiro__request_peer_session_reset";

const PEER_SESSION_RESET_MODES = ["new", "clear"] as const;

const REQUEST_PEER_SESSION_RESET_DESCRIPTION =
  "As the DIRECTOR of an active work item, start a peer's session over from empty, at once. REQUIRED arguments: `agent_id` (the assignee of that work), `mode` (\"new\" keeps the operator's visible transcript and begins a fresh session below it; \"clear\" also blanks the pane), `work_id` and `expected_authority_epoch`. Take `work_id` and `expected_authority_epoch` from the result of YOUR OWN work operations (`work_control_result` / `work_status`), never from `list_agents` or from memory; the server accepts the request only while you are the director of that work, `agent_id` is its assignee, the work is active, and the epoch still matches (a transfer or override changes it). Every authority failure comes back as the single word `reset_not_authorized`. Before calling: the target must already have written down what it needs (a file, WORKLOG, an issue), because the new session starts with NO memory of its conversation; put the context it needs into your NEXT request to it; its status line survives the reset. The target must be idle: a busy target is refused with `agent_busy` (nothing is interrupted or queued), so use yield on its running work first and retry once it is idle. A target in an open conversation with a third agent is refused with `agent_in_conversation`, and one whose engine cannot reset with `unsupported_session_reset`. By default (`wait: true`) the call blocks for up to about 70 seconds until the reset has completed or failed and returns `{ request_id, agent_id, mode, work_id, outcome: \"completed\" | \"failed\" | \"timeout\", reason?, to_session_id? }`; `timeout` means no result arrived in time and the reset may still finish. With `wait: false` it returns `outcome: \"accepted\"` right away. A result that arrives after the call has returned is delivered to you as a message starting `Peer session reset completed:` or `Peer session reset failed:`. Optional `reason`: one sentence on why, shown to the operator.";

const REQUEST_PEER_SESSION_RESET_INPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    agent_id: {
      type: "string",
      description: "The target peer's agent id: the assignee of `work_id`.",
    },
    mode: {
      type: "string",
      enum: [...PEER_SESSION_RESET_MODES],
      description:
        'Whether to keep the operator\'s visible transcript ("new") or blank the pane too ("clear"). Both start an empty session.',
    },
    work_id: {
      type: "string",
      description:
        "The work item you direct, from your own work_control_result / work_status.",
    },
    expected_authority_epoch: {
      type: "integer",
      minimum: 0,
      description:
        "The work's authority_epoch as your last work_control_result / work_status reported it.",
    },
    reason: {
      type: "string",
      description:
        "One sentence on why a fresh session is warranted now. Shown to the operator in the session lifecycle event.",
    },
    wait: {
      type: "boolean",
      description:
        "Default true: wait (up to about 70 s) for the reset to complete or fail. False: return as soon as the server accepted.",
    },
  },
  required: ["agent_id", "mode", "work_id", "expected_authority_epoch"],
  additionalProperties: false,
};

/** Zod mirror of REQUEST_PEER_SESSION_RESET_INPUT_SCHEMA (see the note on
 *  REQUEST_COMPACT_INPUT_SHAPE). */
export const REQUEST_PEER_SESSION_RESET_INPUT_SHAPE = {
  agent_id: z.string().min(1),
  mode: z.enum(["new", "clear"]),
  work_id: z.string().min(1),
  expected_authority_epoch: z.number().int().min(0),
  reason: z.string().optional(),
  wait: z.boolean().optional(),
};

type ParsedInput = {
  request: PeerSessionResetRequestInput;
  wait: boolean;
};

function parseInput(
  input: Record<string, unknown>,
): { ok: true; value: ParsedInput } | { ok: false; message: string } {
  const { agent_id, mode, work_id, expected_authority_epoch, reason, wait } = input;
  if (typeof agent_id !== "string" || agent_id === "") {
    return { ok: false, message: "needs a non-empty agent_id" };
  }
  if (mode !== "new" && mode !== "clear") {
    return {
      ok: false,
      message: `needs mode "new" or "clear"; got ${JSON.stringify(mode)}`,
    };
  }
  if (typeof work_id !== "string" || work_id === "") {
    return { ok: false, message: "needs a non-empty work_id" };
  }
  if (
    typeof expected_authority_epoch !== "number" ||
    !Number.isSafeInteger(expected_authority_epoch) ||
    expected_authority_epoch < 0
  ) {
    return {
      ok: false,
      message: `needs expected_authority_epoch as a non-negative integer; got ${JSON.stringify(expected_authority_epoch)}`,
    };
  }
  if (reason !== undefined && typeof reason !== "string") {
    return { ok: false, message: "reason must be a string when given" };
  }
  if (wait !== undefined && typeof wait !== "boolean") {
    return { ok: false, message: "wait must be a boolean when given" };
  }
  if (!fitsApprovalPayload(input)) {
    return {
      ok: false,
      message:
        `the input is over the ${MAX_INPUT_BYTES} byte approval-payload ` +
        "ceiling once serialized. Shorten reason and retry.",
    };
  }
  const trimmed = typeof reason === "string" ? reason.trim() : "";
  return {
    ok: true,
    value: {
      request: {
        agentId: agent_id,
        mode,
        workId: work_id,
        expectedAuthorityEpoch: expected_authority_epoch,
        ...(trimmed === "" ? {} : { reason: trimmed }),
      },
      wait: wait !== false,
    },
  };
}

/** Validates a `request_peer_session_reset` input before anything acts on
 *  it. Exported for the Codex / Antigravity approval gate, which runs it
 *  BEFORE the operator is asked (the bridge does not validate against
 *  `inputSchema`). */
export function validateRequestPeerSessionResetInput(
  input: Record<string, unknown>,
): { ok: true } | { ok: false; message: string } {
  const parsed = parseInput(input);
  return parsed.ok ? { ok: true } : parsed;
}

/** What each closed reply reason tells the model to do next. Only the
 *  server's eight words plus the transport's own collapse are listed; any
 *  other message is a transport failure and gets no hint. */
const REFUSAL_HINTS: Readonly<Record<string, string>> = {
  reset_not_authorized:
    "The work grant does not allow this request. Re-read the work with work_status and check that you direct it, the target is its assignee, it is active, and the epoch is current.",
  work_control_unavailable:
    "This session did not negotiate work control with the server, so no peer reset can be requested from it.",
  unknown_agent: "The server does not know that agent id.",
  unsupported_session_reset:
    "The target's engine cannot reset its session. Nothing was changed.",
  agent_in_conversation:
    "The target is in an open conversation with another agent. Nothing was changed; retry after that conversation ends.",
  agent_busy:
    "The target is not idle. Nothing was changed or interrupted; yield its running work and retry once it is idle.",
  session_reset_pending:
    "The target already has a reset in progress, and this call was not accepted. Do not request another; check the target's state (for example with list_agents). Only the original requester is told how that reset ends, not this call.",
  runner_unavailable: "The target's runner is not reachable. Nothing was changed.",
  unknown_error: "The server's answer was not understood. Do not assume anything happened.",
};

/** The text the model reads as a tool result. snake_case keys, as in the
 *  tool contract. */
function resultText(
  request: PeerSessionResetRequestInput,
  call: PeerSessionResetCall,
): string {
  const body = {
    request_id: call.requestId,
    agent_id: request.agentId,
    mode: request.mode,
    work_id: request.workId,
    outcome: call.outcome,
    ...(call.outcome === "failed" ? { reason: call.reason } : {}),
    ...(call.outcome === "completed" ? { to_session_id: call.toSessionId } : {}),
  };
  const json = JSON.stringify(body);
  if (call.outcome === "accepted") {
    return `${json}\nThe server accepted the request. The result will reach you as a message starting "Peer session reset".`;
  }
  if (call.outcome === "timeout") {
    return `${json}\nNo result arrived in time; the reset may still complete. Do not request another. If a result arrives later it will reach you as a message starting "Peer session reset".`;
  }
  return json;
}

export interface RequestPeerSessionResetOptions {
  /** Sends `peer_session_reset_request`; normally
   *  `ServerLink#requestPeerSessionReset`. Rejects with the reply's closed
   *  reason, `unknown_error`, or `timeout` for a reply that never came. */
  request: (
    request: PeerSessionResetRequestInput,
    options: { wait: boolean },
  ) => Promise<PeerSessionResetCall>;
}

/** The `request_peer_session_reset` descriptor. The Claude adapter registers
 *  it on its SDK MCP server; the Codex and Antigravity adapters register it
 *  on the bridge wrapped in `operatorApprovalGated`. */
export function requestPeerSessionResetDescriptor(
  options: RequestPeerSessionResetOptions,
): ToolDescriptor {
  return {
    name: "request_peer_session_reset",
    description: REQUEST_PEER_SESSION_RESET_DESCRIPTION,
    inputSchema: REQUEST_PEER_SESSION_RESET_INPUT_SCHEMA,
    handler: async (input) => {
      const parsed = parseInput(input);
      if (!parsed.ok) {
        return errorResult(`request_peer_session_reset ${parsed.message}`);
      }
      const { request, wait } = parsed.value;
      let call: PeerSessionResetCall;
      try {
        call = await options.request(request, { wait });
      } catch (err) {
        return errorResult(refusalText(err));
      }
      return { content: [{ type: "text", text: resultText(request, call) }] };
    },
  };
}

function refusalText(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (message === "timeout") {
    // A reply timeout does not say the server never saw the request.
    return (
      "request_peer_session_reset could not confirm the request: the server " +
      "did not answer in time. It may have been accepted and a reset may be " +
      "running. Do not send it again. If it went through, the result will " +
      'reach you as a message starting "Peer session reset".'
    );
  }
  const hint = REFUSAL_HINTS[message];
  return hint === undefined
    ? `request_peer_session_reset failed: ${message}`
    : `request_peer_session_reset was refused: ${message}. ${hint}`;
}

/** The root input handed to the model for a result no call was waiting for
 *  (`wait: false`, or one that arrived after the call gave up). Same shape of
 *  hand-off as `Work notice: <json>`. */
export function peerSessionResetRootInput(
  notice: PeerSessionResetNotice,
): string {
  const body = {
    request_id: notice.requestId,
    agent_id: notice.agentId,
    mode: notice.mode,
    work_id: notice.workId,
    ...(notice.ok
      ? { to_session_id: notice.toSessionId ?? null }
      : { reason: notice.reason }),
  };
  return `Peer session reset ${notice.ok ? "completed" : "failed"}: ${JSON.stringify(body)}`;
}

function errorResult(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}
