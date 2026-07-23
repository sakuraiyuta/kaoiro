// 実機検収 3 (2026-07-23 マスター指示): 右ペインを per-agent 最終応答
// 一覧から「全 agent の会話ログを時系列マージ」に切り替えるための
// 純関数モジュール。 latestReply.ts と対の位置付け。
//
// 含める envelope:
//   - log kind=assistant  → agent の応答
//   - log kind=user       → operator が送った prompt (agent へ echoed)
// 除外:
//   - result              → turn boundary のみ表示する既存慣例に揃える
//     (AgentDetail #29 前例、ふじ 検収 2 fix-round must-fix M4、2026-07-23)。
//     wrapper は同一 turn の final text を assistant と result の両方に
//     emit するので、両方を会話行にすると通常 turn が [user, assistant,
//     result] → 3 行 (agent 発話が 2 重) になってしまう。 result は
//     boundary 扱いで除外し、実 envelope 列 [user, assistant(X), result(X)]
//     は [user, assistant(X)] の 2 会話行に折り畳む。
//   - log kind=tool_use / tool_result → tool running (マスター明示)
//   - state_change / permission_request / session_boundary → 会話行では
//     ないので UI で扱わない
//   - inter_agent_message → 送信元 persona で一行だけ表示する。server の
//     per-pane projection は sender/receiver に同じ envelope を複製するが、
//     timeline は identity で重複を落とす (#25)。
//
// 純関数のまま提供 (vitest で決定的に pin できるように)。 UI 側の
// 描画は ResponseTimeline.svelte が担当。

import type { Envelope } from "./protocol";

/** 1 行のプレビュー最大文字数。 latestReply.ts と同じ 80 で揃える。 */
export const SUMMARY_MAX_CHARS = 80;

export type EntryKind = "user" | "agent" | "inter_agent";

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
  /** inter_agent の軽い方向表示用。 */
  recipientId?: string;
  /** 1 行に丸めた plain-text preview。 空文字なら UI 側で
   *  placeholder ("(空応答)" 等) を出す判断。 */
  text: string;
}

// ふじ 検収 2 fix-round A3 (2026-07-23): 丸めは code point 単位で
// 行う (UTF-16 code unit 単位の `.slice` は絵文字などの surrogate
// pair を割って壊れた文字を生む)。 `Array.from(str)` が code point
// でイテレートしてくれるので、それを長さ判定と切り出しに使う。
// Grapheme cluster (Intl.Segmenter) までは行かない — 現段階は
// surrogate pair 割れの防止で十分。
function toSummary(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  const codePoints = Array.from(collapsed);
  if (codePoints.length <= SUMMARY_MAX_CHARS) return collapsed;
  return codePoints.slice(0, SUMMARY_MAX_CHARS - 1).join("") + "…";
}

function compareTs(a: Envelope, b: Envelope): number {
  const byTime = a.ts.localeCompare(b.ts);
  if (byTime !== 0) return byTime;
  return (a.seq ?? 0) - (b.seq ?? 0);
}

function classify(agentId: string, env: Envelope): ConversationEntry | null {
  // ふじ 検収 2 fix-round M4 (2026-07-23): result は turn boundary
  // 扱いで除外。 assistant と result の text は同一なので、両方採用
  // すると通常 turn が 2 行重複表示になる (AgentDetail の #29 前例と
  // 揃える)。 assistant を送らず result のみ発火する稀な wrapper 実装
  // 経路では会話行が拾えなくなるが、その場合の agent 発話は timeline
  // に載らないだけで per-agent 詳細には残る。
  if (env.type === "result") return null;
  if (env.type === "inter_agent_message") {
    const payload = env.payload as { to?: unknown; body?: unknown } | undefined;
    const recipientId = typeof payload?.to === "string" ? payload.to : undefined;
    return {
      // `agentId` is the pane key for ordinary logs, but IA is displayed
      // from its true sender so a receiver-pane duplicate cannot change its
      // portrait or click target.
      agentId: env.agent_id,
      envelope: env,
      kind: "inter_agent",
      ...(recipientId ? { recipientId } : {}),
      text: toSummary(typeof payload?.body === "string" ? payload.body : ""),
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

/** 全 agent の transcript を横断して assistant / user を取り出し、
 *  新しい順 (newest first) にマージした配列を返す。 マスター指示の
 *  「新しい順」は既存 latestReplies と揃った選択で、上部に最新の
 *  やり取りが積み上がる読み方になる。 */
export function conversationEntries(
  logs: Record<string, Envelope[]>,
): ConversationEntry[] {
  const out: ConversationEntry[] = [];
  const seenInterAgent = new Set<string>();
  for (const [agentId, transcript] of Object.entries(logs)) {
    for (const envelope of transcript) {
      const entry = classify(agentId, envelope);
      if (entry) {
        if (entry.kind === "inter_agent") {
          const key = [
            envelope.agent_id,
            envelope.session_id ?? "",
            envelope.ts,
            envelope.seq ?? 0,
            envelope.type,
          ].join("|");
          if (seenInterAgent.has(key)) continue;
          seenInterAgent.add(key);
        }
        out.push(entry);
      }
    }
  }
  out.sort((a, b) => compareTs(b.envelope, a.envelope));
  return out;
}
