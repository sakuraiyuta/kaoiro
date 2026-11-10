import type { DetachedReplyBasis, ReplyBasis } from "@kaoiro/agent-common";
import { escapeNativeScalar, nativeSummaryShown, parseContinuationBlocks, reportToken, MARKER_PREFIX, type NotificationBlock } from "./continuation_markers.js";
import { ContinuationRegistry, type LaunchCapability } from "./continuation_registry.js";
import { matchesPeerOpener } from "./native_peer_opener.js";
import type { NativeAnchor } from "./native_transcript.js";

export interface ContinuationProof {
  basis: DetachedReplyBasis;
  origin: Record<string, unknown>;
  sources: ReadonlyArray<{ taskId: string; runId: string }>;
  commit: () => boolean;
}
export type ProofResult = { proof: ContinuationProof } | { reason: string };
type Claim = { cap?: LaunchCapability | undefined; key: string; completion: boolean; live: () => boolean };

/** All constructors prepare first; the single commit cannot consume half a batch. */
export class ContinuationProofs {
  readonly #completions = new Set<string>();
  constructor(readonly registry: ContinuationRegistry, readonly basis: ReplyBasis) {}

  #agentCompletion(block: NotificationBlock): LaunchCapability | undefined {
    const run = this.registry.source(block.taskId);
    const terminal = run?.terminal;
    if (!run || run.source !== "Agent" || run.taskType !== "local_agent" || run.uncertain ||
        !run.background || run.explicitStop || run.stops.size || !terminal ||
        typeof terminal.tool_use_id !== "string" || terminal.tool_use_id !== block.toolUseId ||
        terminal.tool_use_id !== run.callId || terminal.task_id !== block.taskId || typeof terminal.run_id !== "string" ||
        terminal.session_id !== this.registry.sessionId || block.status !== terminal.status ||
        typeof terminal.output_file !== "string" || !terminal.output_file ||
        (block.outputFile !== undefined && block.outputFile !== terminal.output_file) ||
        typeof terminal.summary !== "string" || block.result !== escapeNativeScalar(terminal.summary) ||
        block.event !== undefined || block.workflowMetadata) return undefined;
    const cap = this.registry.byExecution(terminal.tool_use_id, block.taskId, terminal.run_id);
    if (!cap || cap.source !== "Agent" || cap.consumed || cap.quarantined) return undefined;
    const usage = terminal.usage as Record<string, unknown> | undefined;
    if (block.usage !== undefined && usage) {
      for (const [tag, key] of [["subagent_tokens", "total_tokens"], ["tool_uses", "tool_uses"], ["duration_ms", "duration_ms"]]) {
        const value = new RegExp(`<${tag}>(\\d+)</${tag}>`).exec(block.usage)?.[1];
        if (usage[key!] !== undefined && value !== String(usage[key!])) return undefined;
      }
    }
    for (const [value, key, escaped] of [[block.note, "note", true], [block.worktreePath, "worktreePath", false],
      [block.worktreeBranch, "worktreeBranch", true]] as const) {
      if (value !== undefined && terminal[key] !== undefined &&
          value !== (escaped ? escapeNativeScalar(String(terminal[key])) : String(terminal[key]))) return undefined;
    }
    return cap;
  }

  reserveCompletionFold(prompt: string, occurrence: string): void {
    for (const block of parseContinuationBlocks(prompt) ?? []) {
      const cap = this.#agentCompletion(block);
      if (cap) this.registry.quarantine(cap.token, occurrence);
    }
  }

  prove(anchor: NativeAnchor, prompt: string, openerBasis: DetachedReplyBasis): ProofResult {
    const row = anchor.row;
    const origin = row.origin as Record<string, unknown> | undefined;
    const message = row.message as { role?: unknown; content?: unknown } | undefined;
    if (!origin || row.promptSource !== "system" || message?.role !== "user") return { reason: "native_opener_mismatch" };
    const claims: Claim[] = [];
    const maps: DetachedReplyBasis[] = [];
    const sources: Array<{ taskId: string; runId: string }> = [];
    if (origin.kind === "peer") {
      if (row.turnOrigin !== "peer" || origin.handback !== true || typeof origin.body !== "string" ||
          typeof origin.senderTaskId !== "string" || origin.from !== origin.senderTaskId) return { reason: "native_peer_mismatch" };
      if (!matchesPeerOpener(message.content, prompt, origin.from)) return { reason: "native_opener_mismatch" };
      const token = reportToken(origin.body);
      const cap = token ? this.registry.byToken(token) : undefined;
      if (!cap || cap.source !== "Agent" || !this.registry.eligible(cap) || cap.taskId !== origin.senderTaskId ||
          cap.consumed || cap.quarantined) return { reason: "native_report_unproved" };
      claims.push({ cap, key: anchor.uuid, completion: false, live: () => this.registry.eligible(cap) }); maps.push(cap.basis);
      sources.push({ taskId: cap.taskId!, runId: cap.runId! });
    } else if (origin.kind === "task-notification") {
      if (message.content !== prompt) return { reason: "native_opener_mismatch" };
      if (row.turnOrigin !== "task_notification" || (origin.producer !== undefined && origin.producer !== "session-task")) return { reason: "native_task_origin_mismatch" };
      const blocks = parseContinuationBlocks(prompt);
      if (!blocks) return { reason: "native_notification_malformed" };
      for (const [position, block] of blocks.entries()) {
        const run = this.registry.source(block.taskId);
        if (!run || run.uncertain || !run.source) return { reason: "native_source_unknown" };
        if (block.agentMetadata && run.source !== "Agent") return { reason: "native_completion_source_mismatch" };
        if (block.workflowMetadata && run.source !== "Workflow") return { reason: "native_completion_source_mismatch" };
        const cap = run.source === "Agent" ? this.#agentCompletion(block) : this.registry.byTask(block.taskId);
        sources.push({ taskId: run.taskId, runId: run.runId });
        const terminal = run.terminal;
        const completed = block.status !== undefined;
        const completionKey = JSON.stringify([block.taskId, run.runId, run.callId]);
        if (completed && run.source !== "Agent") {
          if (!terminal || !run.background || run.explicitStop || run.stops.size ||
              !run.callId || block.toolUseId !== run.callId || terminal.tool_use_id !== run.callId ||
              block.status !== terminal.status || typeof terminal.output_file !== "string" || !terminal.output_file ||
              block.outputFile !== terminal.output_file ||
              !nativeSummaryShown(String(terminal.summary), block.summary) || this.#completions.has(completionKey)) return { reason: "native_completion_unproved" };
        }
        if (run.source === "Agent") {
          if (!cap || !completed) return { reason: "native_agent_completion_unproved" };
          if (origin.producer !== "session-task" || origin.runId !== cap.runId ||
              (origin.taskId !== undefined && origin.taskId !== cap.taskId) ||
              (origin.toolUseId !== undefined && origin.toolUseId !== cap.callId)) return { reason: "native_agent_origin_mismatch" };
          maps.push(cap.basis);
        } else if (run.source === "Monitor") {
          if (!cap || !this.registry.eligible(cap) || cap.source !== "Monitor") return { reason: "native_monitor_unproved" };
          const description = escapeNativeScalar(String(cap.effective.description));
          if (!completed && (block.toolUseId !== undefined || block.outputFile !== undefined || block.result !== undefined ||
              block.summary !== `Monitor event: "${description}"` || block.event === undefined)) return { reason: "native_monitor_description_mismatch" };
          // Completion's tuple and native summary are authoritative even without a marker.
          if (completed && block.result !== undefined) return { reason: "native_monitor_completion_mismatch" };
          // A shortened block no longer holds the whole description, so the SDK's summary, which the block was proved against, is read instead.
          const reported = String(terminal?.summary);
          if (completed && reported.includes(MARKER_PREFIX) && !reported.includes(`"${String(cap.effective.description)}"`)) return { reason: "native_monitor_description_mismatch" };
          maps.push(cap.basis);
        } else {
          if (!completed || (run.source !== "Bash" && run.source !== "Workflow") ||
              block.event !== undefined || (run.source === "Bash" && block.result !== undefined)) return { reason: "native_completion_source_mismatch" };
          maps.push(openerBasis);
        }
        claims.push({ cap, key: completed ? completionKey : `${anchor.uuid}:${position}`, completion: completed,
          live: () => this.registry.source(block.taskId) === run && !run.uncertain && !run.explicitStop && run.stops.size === 0 });
      }
      if (origin.runId !== undefined && !blocks.some(b => this.registry.source(b.taskId)?.runId === origin.runId)) return { reason: "native_terminal_run_mismatch" };
    } else return { reason: "native_origin_unknown" };
    if (new Set(claims.map(c => c.key)).size !== claims.length) return { reason: "native_duplicate_claim" };
    const selected = maps[0]!;
    if (!maps.every(map => this.basis.sameDetached(selected, map))) return { reason: "batch-basis-conflict" };
    let committed = false;
    return { proof: { basis: selected, origin: structuredClone(origin), sources, commit: () => {
      if (committed) return true;
      if (claims.some(c => !c.live() || (c.cap && (!this.registry.eligible(c.cap) ||
          (c.cap.source === "Agent" && (c.cap.consumed || c.cap.quarantined)))) ||
          (c.completion && this.#completions.has(c.key)))) return false;
      for (const claim of claims) {
        if (claim.cap?.source === "Agent") claim.cap.consumed = claim.key;
        if (claim.completion) this.#completions.add(claim.key);
      }
      committed = true; return true;
    } } };
  }
}
