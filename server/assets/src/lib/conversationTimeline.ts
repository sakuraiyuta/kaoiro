// 実機検収 3 (2026-07-23 マスター指示): 右ペインを per-agent 最終応答
// 一覧から「全 agent の会話ログを時系列マージ」に切り替えるための
// 純関数モジュール。 latestReply.ts と対の位置付け。
//
// 含める envelope:
//   - log kind=assistant  → agent の応答
//   - result              → agent の最終応答
//   - log kind=user       → operator が送った prompt (agent へ echoed)
// 除外:
//   - log kind=tool_use / tool_result → tool running (マスター明示)
//   - state_change / permission_request / session_boundary → 会話行では
//     ないので UI で扱わない
//   - inter_agent_message → agent 間の bubble は既に per-agent 詳細に
//     表示されており、右ペインの主目的は「operator ↔ agent の一次
//     会話」なので当面除外 (マスターの含む/除外 リストにも明記なし)
//
// 純関数のまま提供 (vitest で決定的に pin できるように)。 UI 側の
// 描画は ResponseTimeline.svelte が担当。

import type { Envelope } from "./protocol";

/** 1 行のプレビュー最大文字数。 latestReply.ts と同じ 80 で揃える。 */
export const SUMMARY_MAX_CHARS = 80;

export type EntryKind = "user" | "agent";

export interface ConversationEntry {
  /** 対応 agent。 persona 画像の解決 + 行クリック時の詳細遷移先。
   *  user 発の prompt でも、prompt が echoed された agent の
   *  transcript 内に log kind=user として現れるので、その agent の
   *  persona を左に置くのが自然 (「誰との会話か」を判別)。 */
  agentId: string;
  envelope: Envelope;
  /** user prompt か agent 発話かの区別。 UI は軽い styling で発信元
    が分かれば十分 (badge / opacity 等) — 描画側の判断。 */
  kind: EntryKind;
  /** 1 行に丸めた plain-text preview。 空文字なら UI 側で
   *  placeholder ("(空応答)" 等) を出す判断。 */
  text: string;
}

function toSummary(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= SUMMARY_MAX_CHARS) return collapsed;
  return collapsed.slice(0, SUMMARY_MAX_CHARS - 1) + "…";
}

function compareTs(a: Envelope, b: Envelope): number {
  const byTime = a.ts.localeCompare(b.ts);
  if (byTime !== 0) return byTime;
  return (a.seq ?? 0) - (b.seq ?? 0);
}

function classify(agentId: string, env: Envelope): ConversationEntry | null {
  if (env.type === "result") {
    const text = (env.payload as { text?: unknown } | undefined)?.text;
    return {
      agentId,
      envelope: env,
      kind: "agent",
      text: toSummary(typeof text === "string" ? text : ""),
    };
  }
  if (env.type === "log") {
    const payload = env.payload as
      | { kind?: unknown; text?: unknown }
      | undefined;
    const text = typeof payload?.text === "string" ? payload.text : "";
    if (payload?.kind === "assistant") {
      return {
        agentId,
        envelope: env,
        kind: "agent",
        text: toSummary(text),
      };
    }
    if (payload?.kind === "user") {
      return { agentId, envelope: env, kind: "user", text: toSummary(text) };
    }
    // tool_use / tool_result などは exclude。
    return null;
  }
  return null;
}

/** 全 agent の transcript を横断して assistant / user / result を取り出し、
 *  新しい順 (newest first) にマージした配列を返す。 マスター指示の
 *  「新しい順」は既存 latestReplies と揃った選択で、上部に最新の
 *  やり取りが積み上がる読み方になる。 */
export function conversationEntries(
  logs: Record<string, Envelope[]>,
): ConversationEntry[] {
  const out: ConversationEntry[] = [];
  for (const [agentId, transcript] of Object.entries(logs)) {
    for (const envelope of transcript) {
      const entry = classify(agentId, envelope);
      if (entry) out.push(entry);
    }
  }
  out.sort((a, b) => compareTs(b.envelope, a.envelope));
  return out;
}
