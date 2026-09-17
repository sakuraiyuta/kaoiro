import {
  clipText, isFormattedInterAgentMessage, logEntryToPayload, makeLog,
  type Envelope, type LogPayload, type WrapperConfig,
} from "@kaoiro/agent-common";
import { appServerItemLogs } from "./app_server_projection.js";
import { AppServerRpcError, rpcObject, type RpcObject } from "./app_server_rpc.js";
import { MAX_HISTORY } from "./history.js";

export interface AppServerHistory {
  logs: Envelope[];
  coverage: "full" | "tail" | "incomplete";
  reason?: "rpc_rejected" | "invalid_response" | "cursor_stalled" | "page_limit";
}

type HistoryRequest = (method: "thread/read" | "thread/items/list", params: RpcObject) => Promise<unknown>;
type Entry = { turnId: string; item: RpcObject & { id: string } };
// A changing cursor can still loop forever; this bounds work independently of
// the display-row cap when pages contain only non-display items.
const MAX_HISTORY_PAGES = 100;

function entry(value: unknown): Entry | null {
  if (!rpcObject(value) || typeof value.turnId !== "string" || !rpcObject(value.item)
    || typeof value.item.id !== "string" || typeof value.item.type !== "string") return null;
  return { turnId: value.turnId, item: { ...value.item, id: value.item.id } };
}

function payloads(item: Entry["item"], names: Map<string, string>): LogPayload[] {
  if (item.type === "userMessage") {
    const text = Array.isArray(item.content) ? item.content.flatMap(block =>
      rpcObject(block) && block.type === "text" && typeof block.text === "string" ? [block.text] : []).join("\n") : "";
    if (!text.trim() || isFormattedInterAgentMessage(text)) return [];
    const clipped = clipText(text);
    return [{ kind: "user", text: clipped.text, ...(clipped.truncated ? { truncated: true } : {}) }];
  }
  const logs = appServerItemLogs(item, false);
  if (item.status !== "inProgress") logs.push(...appServerItemLogs(item, true));
  return logs.map(log => logEntryToPayload(log, names));
}

/** Only persisted display items enter replay. No synthetic turn terminal,
 * approval, acknowledgement, or compaction event is constructed here. */
export async function readAppServerHistory(
  request: HistoryRequest, threadId: string, config: WrapperConfig, now: () => string,
): Promise<AppServerHistory> {
  let entries: Entry[] = [];
  let descending = false;
  const seen = new Set<string>();
  const unique = (values: Entry[]): Entry[] => values.filter(value => {
    const key = JSON.stringify([threadId, value.turnId, value.item.id]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const finish = (coverage: AppServerHistory["coverage"], reason?: AppServerHistory["reason"]): AppServerHistory => {
    const names = new Map<string, Map<string, string>>();
    const logs: Envelope[] = [];
    for (const value of descending ? [...entries].reverse() : entries) {
      let turnNames = names.get(value.turnId);
      if (!turnNames) names.set(value.turnId, turnNames = new Map());
      for (const payload of payloads(value.item, turnNames)) {
        const envelope = makeLog(config, "idle", now(), payload);
        envelope.session_id = threadId;
        logs.push(envelope);
      }
    }
    return { logs: logs.slice(-MAX_HISTORY),
      coverage: coverage === "full" && logs.length > MAX_HISTORY ? "tail" : coverage,
      ...(reason === undefined ? {} : { reason }) };
  };
  const thread = (response: unknown): RpcObject | null =>
    rpcObject(response) && rpcObject(response.thread) && response.thread.id === threadId ? response.thread : null;
  try {
    const metadata = thread(await request("thread/read", { threadId, includeTurns: false }));
    if (!metadata || (metadata.historyMode !== undefined && metadata.historyMode !== "legacy" && metadata.historyMode !== "paginated")) {
      return finish("incomplete", "invalid_response");
    }
    if (metadata.historyMode !== "paginated") {
      const full = thread(await request("thread/read", { threadId, includeTurns: true }));
      if (!full || !Array.isArray(full.turns) || (full.historyMode !== undefined && full.historyMode !== "legacy" && full.historyMode !== "paginated")) {
        return finish("incomplete", "invalid_response");
      }
      let complete = full.historyMode !== "paginated";
      const snapshot: Entry[] = [];
      for (const turn of full.turns) {
        if (!rpcObject(turn) || typeof turn.id !== "string" || !Array.isArray(turn.items)
          || (turn.itemsView !== undefined && turn.itemsView !== "full" && turn.itemsView !== "summary" && turn.itemsView !== "notLoaded")) {
          return finish("incomplete", "invalid_response");
        }
        if (turn.itemsView !== undefined && turn.itemsView !== "full") complete = false;
        for (const item of turn.items) {
          const value = entry({ turnId: turn.id, item });
          if (!value) return finish("incomplete", "invalid_response");
          snapshot.push(value);
        }
      }
      if (complete) {
        entries = unique(snapshot);
        return finish("full");
      }
      // Never splice a summary or an earlier full-read snapshot into pages.
    }
    descending = true;
    let cursor: string | undefined;
    const cursors = new Set<string>();
    let rows = 0;
    for (let page = 0; page < MAX_HISTORY_PAGES; page += 1) {
      const response = await request("thread/items/list", {
        threadId, sortDirection: "desc", limit: MAX_HISTORY, ...(cursor === undefined ? {} : { cursor }),
      });
      if (!rpcObject(response) || !Array.isArray(response.data)
        || (response.nextCursor != null && (typeof response.nextCursor !== "string" || response.nextCursor === ""))) {
        return finish("incomplete", "invalid_response");
      }
      const values = response.data.map(entry);
      if (values.some(value => value === null)) return finish("incomplete", "invalid_response");
      const added = unique(values as Entry[]);
      entries.push(...added);
      for (const value of added) rows += payloads(value.item, new Map()).length;
      if (response.nextCursor == null) return finish("full");
      if (added.length === 0 || cursors.has(response.nextCursor as string)) return finish("incomplete", "cursor_stalled");
      if (rows >= MAX_HISTORY) return finish("tail");
      cursor = response.nextCursor as string;
      cursors.add(cursor);
    }
    return finish("incomplete", "page_limit");
  } catch (error) {
    if (!(error instanceof AppServerRpcError)) throw error;
    return finish("incomplete", "rpc_rejected");
  }
}
