import type { ThreadItem } from "@openai/codex-sdk";
import {
  boundErrorDetail, clipText, logEntryToPayload, normalizeTasklist,
  type AdapterEvent, type LogEntry, type LogPayload, type ResultPayload,
  type TasklistSnapshot, type TasklistSourceItem,
} from "@kaoiro/agent-common";
import { threadEventToEvents, threadEventToLogs } from "./adapter.js";
import { AppServerConnectionError, rpcObject, type RpcObject } from "./app_server_rpc.js";
import type { AppServerTurn, AppServerTurnIdentity } from "./app_server_transport.js";
import { appServerUsage, type AppServerUsage } from "./app_server_telemetry.js";

export type AppServerProjection =
  | { kind: "usage"; snapshot: AppServerUsage }
  | { kind: "compaction"; phase: "started" | "completed"; itemId: string }
  | { kind: "adapter"; event: AdapterEvent }
  | { kind: "log"; payload: LogPayload }
  | { kind: "tasklist"; snapshot: TasklistSnapshot }
  | { kind: "result"; status: "completed" | "failed" | "interrupted"; payload: ResultPayload };

export interface AppServerProjectedTurn {
  identity: AppServerTurnIdentity;
  events: AsyncIterableIterator<AppServerProjection>;
  readonly usage: AppServerUsage | null;
}

function status(value: unknown): "in_progress" | "completed" | "failed" | null {
  switch (value) {
    case "inProgress": return "in_progress";
    case "completed": return "completed";
    case "failed": case "declined": return "failed";
    default: return null;
  }
}

function changes(value: unknown): Extract<ThreadItem, { type: "file_change" }>["changes"] | null {
  if (!Array.isArray(value)) return null;
  const result: Extract<ThreadItem, { type: "file_change" }>["changes"] = [];
  for (const change of value) {
    if (!rpcObject(change) || typeof change.path !== "string" || !rpcObject(change.kind)) return null;
    const kind = change.kind.type;
    if (kind !== "add" && kind !== "delete" && kind !== "update") return null;
    result.push({ path: change.path, kind });
  }
  return result;
}

/** Only the stable schema's known display fields cross into the exec adapter.
 * Unknown item kinds do not become guessed tools or successful completions. */
function sdkItem(item: RpcObject & { id: string }): ThreadItem | null {
  const id = item.id;
  switch (item.type) {
    case "agentMessage":
      return typeof item.text === "string" ? { id, type: "agent_message", text: item.text } : null;
    case "reasoning": return { id, type: "reasoning", text: "" };
    case "webSearch":
      return typeof item.query === "string" ? { id, type: "web_search", query: item.query } : null;
    case "commandExecution": {
      const s = status(item.status);
      if (s === null || typeof item.command !== "string") return null;
      return { id, type: "command_execution", command: item.command, status: s,
        aggregated_output: typeof item.aggregatedOutput === "string" ? item.aggregatedOutput : "",
        ...(typeof item.exitCode === "number" ? { exit_code: item.exitCode } : {}) };
    }
    case "fileChange": {
      const s = status(item.status), c = changes(item.changes);
      if (s === null || s === "in_progress" || c === null) return null;
      return { id, type: "file_change", status: s, changes: c };
    }
    case "mcpToolCall": {
      const s = status(item.status);
      if (s === null || typeof item.server !== "string" || typeof item.tool !== "string") return null;
      const result = rpcObject(item.result) && Array.isArray(item.result.content) ? item.result : null;
      // The existing log adapter consumes text only; opaque MCP content never
      // needs a cast to the SDK's narrower ContentBlock union.
      const content = result ? (result.content as unknown[]).flatMap(block =>
        rpcObject(block) && block.type === "text" && typeof block.text === "string"
          ? [{ type: "text" as const, text: block.text }] : []) : [];
      return { id, type: "mcp_tool_call", server: item.server, tool: item.tool,
        arguments: item.arguments, status: s,
        ...(result ? { result: { content, structured_content: result.structuredContent } } : {}),
        ...(rpcObject(item.error) && typeof item.error.message === "string"
          ? { error: { message: item.error.message } } : {}) };
    }
    default: return null;
  }
}

/** Shared display-only conversion; history must not replay live lifecycle events. */
export function appServerItemLogs(item: RpcObject & { id: string }, isComplete: boolean): LogEntry[] {
  const converted = sdkItem(item);
  if (converted) return threadEventToLogs({ type: isComplete ? "item.completed" : "item.started", item: converted });
  if (!isComplete && item.type === "fileChange" && item.status === "inProgress") {
    const c = changes(item.changes);
    return c === null ? [] : [{ kind: "tool_use", tool_use_id: item.id, tool_name: "edit", input: { changes: c } }];
  }
  if (isComplete && item.type === "functionCallOutput") {
    const output = typeof item.output === "string" ? item.output : Array.isArray(item.output)
      ? item.output.flatMap(block => rpcObject(block) && block.type === "input_text" && typeof block.text === "string" ? [block.text] : []).join("\n") : null;
    return output === null ? [] : [{ kind: "tool_result", tool_use_id: item.id, output }];
  }
  return [];
}

function plan(value: unknown): TasklistSourceItem[] | null {
  if (!Array.isArray(value)) return null;
  const result: TasklistSourceItem[] = [];
  for (const entry of value) {
    if (!rpcObject(entry) || typeof entry.step !== "string") return null;
    const s = entry.status;
    if (s !== "pending" && s !== "inProgress" && s !== "completed") return null;
    result.push({ text: entry.step, status: s === "inProgress" ? "in_progress" : s });
  }
  return result;
}

/** One generator owns the raw stream and all per-turn display state. A terminal
 * summary is deliberately never used to replace completed-item history. */
export function projectAppServerTurn(turn: AppServerTurn): AppServerProjectedTurn {
  const state: { usage: AppServerUsage | null } = { usage: null };
  return { identity: turn.identity, events: project(turn, state),
    get usage() { return structuredClone(state.usage); } };
}

async function* project(turn: AppServerTurn, state: { usage: AppServerUsage | null }): AsyncGenerator<AppServerProjection> {
  const started = new Set<string>(), completed = new Set<string>();
  const compactions = new Set<string>(), compacted = new Set<string>();
  const toolNames = new Map<string, string>();
  let turnStarted = false;
  let finalText: string | undefined, fallbackText: string | undefined;
  const log = (entry: LogEntry): AppServerProjection => ({ kind: "log", payload: logEntryToPayload(entry, toolNames) });
  for await (const notification of turn.events) {
    const p = notification.params;
    const nested = rpcObject(p.turn) ? p.turn : null;
    const turnId = p.turnId ?? nested?.id;
    if (p.threadId !== turn.identity.threadId || turnId !== turn.identity.turnId) continue;
    switch (notification.method) {
      case "thread/tokenUsage/updated": {
        const usage = appServerUsage(p.tokenUsage);
        if (usage !== null) {
          state.usage = usage;
          yield { kind: "usage", snapshot: structuredClone(usage) };
        }
        break;
      }
      case "thread/compacted":
        // Pinned 0.153.4 capture emitted only the contextCompaction item pair.
        // A legacy companion must not create a second completion or substitute
        // for an unobserved item completion; the turn terminal confirms success.
        break;
      case "turn/started":
        if (!turnStarted) {
          turnStarted = true;
          yield { kind: "adapter", event: { kind: "assistant", blocks: ["thinking"] } };
        }
        break;
      case "turn/plan/updated": {
        const items = plan(p.plan);
        if (items !== null) yield { kind: "tasklist", snapshot: normalizeTasklist(items) };
        break;
      }
      case "item/agentMessage/delta":
      case "item/reasoning/textDelta":
      case "item/reasoning/summaryTextDelta":
        if (typeof p.itemId === "string" && typeof p.delta === "string" && !completed.has(p.itemId)) {
          yield { kind: "adapter", event: { kind: "assistant", blocks: [
            notification.method === "item/agentMessage/delta" ? "text" : "thinking",
          ] } };
        }
        break;
      case "item/commandExecution/outputDelta":
      case "item/fileChange/outputDelta":
      case "item/mcpToolCall/progress": {
        const text = notification.method === "item/mcpToolCall/progress" ? p.message : p.delta;
        if (typeof p.itemId === "string" && typeof text === "string" && !completed.has(p.itemId)) {
          yield { kind: "adapter", event: { kind: "assistant", blocks: ["tool_use"], toolUseIds: [p.itemId] } };
        }
        break;
      }
      case "item/started":
      case "item/completed": {
        if (!rpcObject(p.item) || typeof p.item.id !== "string") break;
        const item: RpcObject & { id: string } = { ...p.item, id: p.item.id };
        const isComplete = notification.method === "item/completed";
        if (completed.has(item.id) || (!isComplete && started.has(item.id))) break;
        (isComplete ? completed : started).add(item.id);
        if (item.type === "contextCompaction") {
          if (isComplete) compacted.add(item.id);
          else {
            compactions.add(item.id);
            yield { kind: "compaction", phase: "started", itemId: item.id };
          }
          break;
        }
        if (isComplete && item.type === "agentMessage" && typeof item.text === "string") {
          if (item.phase === "final_answer") finalText = item.text;
          else if (item.phase == null) fallbackText = item.text;
        }
        const converted = sdkItem(item);
        if (converted) {
          const event = { type: isComplete ? "item.completed" as const : "item.started" as const, item: converted };
          for (const e of threadEventToEvents(event)) yield { kind: "adapter", event: e };
        } else if (!isComplete && item.type === "fileChange" && item.status === "inProgress") {
          // Exec exposes file changes only after application; app-server also
          // reports their start. Do not invent an SDK completed status for it.
          const c = changes(item.changes);
          if (c !== null) {
            yield { kind: "adapter", event: { kind: "assistant", blocks: ["tool_use"], toolUseIds: [item.id] } };
          }
        }
        for (const entry of appServerItemLogs(item, isComplete)) yield log(entry);
        break;
      }
      case "turn/completed": {
        const s = nested?.status;
        if (s !== "completed" && s !== "failed" && s !== "interrupted") {
          throw new AppServerConnectionError("Invalid app-server terminal status");
        }
        if (s === "completed") {
          for (const itemId of compactions) {
            if (compacted.has(itemId)) yield { kind: "compaction", phase: "completed", itemId };
          }
        }
        const error = nested && rpcObject(nested.error) ? nested.error : null;
        const text = finalText ?? fallbackText;
        const payload: ResultPayload = {
          ...(text === undefined ? {} : { text: clipText(text).text }),
          is_error: s !== "completed",
          ...(s === "completed" ? {} : {
            error_subtype: s === "interrupted" ? "interrupted" : "error_during_execution",
            // Same boundary as makeResult; the future host still constructs
            // its envelope through makeResult before relay.
            error_detail: boundErrorDetail(typeof error?.message === "string" ? error.message
              : s === "interrupted" ? "App-server turn interrupted" : "App-server turn failed"),
          }),
        };
        yield { kind: "adapter", event: { kind: "result", subtype: s === "completed" ? "success" : "error_during_execution" } };
        yield { kind: "result", status: s, payload };
        return;
      }
    }
  }
  throw new AppServerConnectionError("App-server stream ended without a terminal turn");
}
