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
// interpreted as a slash command. How long the compaction then takes scales
// with the context being compacted — 13.7 s at ~22k tokens, 168.8 s at ~293k
// (phase-28 実機受け入れ) — so the tool reserves the compaction rather than
// awaiting it, and promises no duration. Completion is observed through the
// Phase A `compact_boundary` log line, not here.

import type { ToolDescriptor, ToolResult } from "@kaoiro/agent-common";
import { z } from "zod";

/** Full SDK-side tool name once mcpServers register the kaoiro server. */
export const REQUEST_COMPACT_TOOL_FQN = "mcp__kaoiro__request_compact";

/** Byte cap on `resume_prompt`, checked before `/compact` is even queued
 *  (ADR-0055 phase-33 Stage A round1 fix, turn7 #4 — director decision).
 *  Half of PermissionBroker's approval-payload ceiling
 *  (`MAX_INPUT_BYTES` = 16,384 bytes, agent-common/src/permission.ts),
 *  leaving room for `reason` and JSON overhead so a `resume_prompt` at the
 *  cap still fits whole inside the payload the operator actually reads —
 *  above the broker's own ceiling it would be silently dropped from the
 *  approval dialog and approved unread. */
export const RESUME_PROMPT_MAX_BYTES = 8_192;

/** The exact text queued on the SDK input stream. A fixed literal: the
 *  model's `reason` is shown to the operator in the approval dialog and
 *  echoed in the tool result, but never concatenated into the injected turn
 *  — the tool must not become a way to put arbitrary model-authored text on
 *  the input stream. */
export const COMPACT_COMMAND = "/compact";

const REQUEST_COMPACT_DESCRIPTION =
  "Ask the operator to approve compacting this session's context. On approval the wrapper queues `/compact`, which runs at the next turn boundary and replaces the older conversation with a summary; the call returns as soon as the compaction is RESERVED, not when it finishes. How long it then takes scales with how much context there is to compact and can run to several minutes; the transcript reports completion with whatever token counts the engine provides. Use this when you have judged that context headroom is actually limiting the work — after a long session, or before taking on a large task — not as routine hygiene. The operator may decline, in which case carry on as you were. Anything you still need after the compaction should be written down first (a file, an issue, a message to a peer): a compaction summarizes and drops detail, and nothing restores it. Optionally, resume_prompt lets you write yourself a note now, while full context is still available, that will be redelivered verbatim as your own next turn once compaction finishes — the mechanism this tool offers for picking work back up on your own, without the operator having to notice and wake you.";

const REQUEST_COMPACT_INPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    reason: {
      type: "string",
      description:
        "One sentence on why compaction is warranted now. Shown to the operator in the approval dialog.",
    },
    resume_prompt: {
      type: "string",
      description:
        "Optional note to your own post-compaction self: what you were doing, what's next, anything to watch out for. Written now, while full context is still present, so it can be the highest-quality instruction you can give yourself. Redelivered verbatim (behind a fixed explanatory prefix) as a turn once compaction actually completes. Omit it and nothing fires automatically — exactly today's behavior. Shown to the operator in the approval dialog, same as reason.",
    },
  },
  additionalProperties: false,
};

/** Zod mirror of REQUEST_COMPACT_INPUT_SCHEMA — `tool()` takes a Zod raw
 *  shape, and keeping it beside the JSON Schema makes a divergence visible
 *  in one file rather than across two. */
export const REQUEST_COMPACT_INPUT_SHAPE = {
  reason: z.string().optional(),
  resume_prompt: z.string().optional(),
};

export interface RequestCompactOptions {
  /** Queues a turn on the engine input stream, normally `AgentHost#send`.
   *  Its own serialization is what keeps the injected `/compact` from
   *  landing mid-turn (ADR-0036 F6: no automatic interrupt). */
  send: (text: string) => Promise<void>;
  /** Records a `request_compact` reservation, normally
   *  `AgentHost#reserveResume` (ADR-0055, phase-33 Stage A; FIFO round1
   *  fix, turn7 #2/#3). Called exactly once for every `/compact` that
   *  `send` above actually queued — `prompt` when `resume_prompt` was
   *  given, `null` when it was omitted/blank — so the host's FIFO queue
   *  stays 1:1 with real `/compact` calls regardless of whether each one
   *  carried a resume note. Required (not optional): a caller that leaves
   *  this out would have request_compact report a reservation it never
   *  actually made, which is exactly the "success" the round1 review
   *  found silently backed by nothing. */
  reserveResume: (prompt: string | null) => void;
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
      // Verbatim contract (round1 fix, turn7 #1): a resume_prompt that is
      // actually reserved/injected must be byte-for-byte what the model
      // wrote — leading newlines, trailing whitespace and all. `.trim()`
      // is used ONLY to decide "is this blank", never on the value that
      // gets carried forward.
      const resumePromptRaw =
        typeof input.resume_prompt === "string" ? input.resume_prompt : "";
      const resumePromptIsBlank = resumePromptRaw.trim() === "";
      const resumePrompt = resumePromptIsBlank ? null : resumePromptRaw;
      if (resumePrompt !== null) {
        // Byte cap (round1 fix, turn7 #4): validated BEFORE `/compact` is
        // queued, so an oversized resume_prompt fails the whole call
        // rather than reserving a note the operator's approval dialog
        // cannot show in full. Truncating instead of failing would break
        // the verbatim contract above, so overflow is never truncated.
        const byteLength = Buffer.byteLength(resumePrompt, "utf8");
        if (byteLength > RESUME_PROMPT_MAX_BYTES) {
          return errorResult(
            `request_compact failed: resume_prompt is ${byteLength} UTF-8 ` +
              `bytes, over the ${RESUME_PROMPT_MAX_BYTES} byte cap. ` +
              "Shorten it and retry — it is not truncated automatically, " +
              "which would corrupt the verbatim delivery contract.",
          );
        }
      }
      try {
        await options.send(COMPACT_COMMAND);
      } catch (err) {
        // The queue is closed or full. Fail loudly rather than reporting a
        // reservation the wrapper did not make — the model would otherwise
        // wait for a compaction that is never coming. Nothing is reserved
        // on this path either: a note for a compaction that was never
        // actually queued would sit and fire on some later, unrelated
        // boundary instead.
        return errorResult(`request_compact failed: ${String(err)}`);
      }
      // FIFO 1:1 (round1 fix, turn7 #2/#3): every /compact that `send`
      // above actually queued gets exactly one reservation slot, prompt or
      // null, so the host can consume its own queue in the same order
      // compactions actually happen instead of trusting a single shared
      // slot to still mean the right thing later.
      options.reserveResume(resumePrompt);
      const because = reason === "" ? "" : ` (reason: ${reason})`;
      const resumeNote =
        resumePrompt === null
          ? ""
          : " A resume note is reserved and will be redelivered to you " +
            "once compaction finishes.";
      return {
        content: [
          {
            type: "text",
            text:
              `compaction reserved${because}. It runs at the next turn ` +
              "boundary and can take several minutes on a large context; " +
              "the transcript reports completion. Nothing further is " +
              `needed from you.${resumeNote}`,
          },
        ],
      };
    },
  };
}

function errorResult(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}
