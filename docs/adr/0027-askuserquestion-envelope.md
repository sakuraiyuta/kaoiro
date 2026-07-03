---
title: AskUserQuestion 用に専用 envelope(question_request / question_response)と状態 waiting_question を新設
status: accepted
date: 2026-07-03
opened: 2026-07-03
supersedes: []
superseded_by: null
related_specs: [protocol, protocol-inter-agent, agent-sdk-events, threat-model]
related_adrs: [10, 11, 12, 21, 22]
---

# ADR-0027 — AskUserQuestion 用の専用 envelope と状態 `waiting_question`

## Status

Accepted

## Context

Claude Agent SDK(v0.3.187)の `AskUserQuestion` ツールは、tool permission と
同じ **`canUseTool` 経路**で wrapper に届く(公式 docs `agent-sdk/user-input`、
`node_modules/@anthropic-ai/claude-agent-sdk/sdk-tools.d.ts:724` の
`AskUserQuestionInput`)。しかし現状 wrapper は `host.ts:731 #canUseTool` で
すべてを allow/deny に潰しているため、構造化情報(question / options / header /
multiSelect)が dashboard に届かず、選択回答も返せない(issue #78)。

技術調査で回答返却経路は確定した:

- 入力 `AskUserQuestionInput`: `questions[1-4]` 各
  `{ question, header, options[2-4]{ label, description, preview? }, multiSelect }`。
- 回答は `canUseTool` から
  `{ behavior: "allow", updatedInput: { ...questions, answers: { [質問文]: 選択 label }, annotations? } }`
  を返す(`AskUserQuestionOutput` `sdk-tools.d.ts:2991`)。
  却下/キャンセルは `{ behavior: "deny", message }`。

wire プロトコル(wrapper ↔ server ↔ dashboard)をどう設計するかで 3 案を検討した
([open-question askuserquestion-envelope-shape](../open-questions/askuserquestion-envelope-shape.md))。

| 案 | 概要 | 採否 |
|---|---|---|
| A | 既存 `permission_request` / `permission_decision` を拡張し質問・回答を相乗り | 却下: allow/deny と構造化回答は意味論的に別物。1 種別に相乗りさせると dashboard が描画をフィールド sniff で分岐し、permission の意味が濁って drift 温床になる |
| B | 専用 envelope `question_request` / `question_response` と専用状態 `waiting_question` を新設 | **採用**: 既存 protocol が `waiting_permission`(許可待ち)と `waiting_input`(指示待ち)を*待ちの種類*で別状態にしている設計思想と一貫する。kaoiro の「状態=キャラクター」の核とも噛み合い、inter-agent の escalate-to-user でも再利用できる |
| C | wire は専用種別だが state は `waiting_permission` 流用 | 部分採用: state 流用は既存の状態分離(permission/input を別建て)と不整合。ただし「broker の配管を流用する」部分(下記 F5)は本 ADR に取り込む |

## Decision

設計は [ADR-0022](0022-pending-permission-authoritative-source.md)(pending の
真実を `state_change.ext` に置くパターン)を **question 側にも同型適用**する。

### F1: 新状態 `waiting_question`

`canUseTool` が `toolName === "AskUserQuestion"` で発火し Promise 保留中の状態。
導出元・遷移とも `waiting_permission` と対等(`canUseTool` は tool_use の後に
呼ばれるため `tool_running → waiting_question → tool_running`)。protocol の
状態表・mermaid、`wrapper/src/state.ts` に追加する。表情の方向性は
「選択を差し出して待つ」(permission の『こちらを見て待つ』とは別表現の余地)。

### F2: `ext.pending_question` を authoritative source とする

pending 中の質問の真実は `state_change.ext.pending_question` に乗る。
`null` / 未設定なら pending 無し。形状は
`{ request_id, questions, ts }`(`question_request` envelope の payload と同等)。

```json
{
  "type": "state_change",
  "state": "waiting_question",
  "payload": {},
  "ext": {
    "pending_question": {
      "request_id": "q-abc-123",
      "questions": [
        {
          "question": "どの方式を採用しますか?",
          "header": "方式",
          "multiSelect": false,
          "options": [
            { "label": "REST", "description": "素直だが冗長" },
            { "label": "gRPC", "description": "高速だが導入コスト" }
          ]
        }
      ],
      "ts": "2026-07-03T09:41:00Z"
    }
  }
}
```

### F3: `question_request` envelope は初出通知

protocol 互換の一貫性(permission_request と同型)と「新規 pending あり」
イベント通知の目的で `question_request`(envelope `type`)を送る。状態の真実は
`ext.pending_question` 側。両者は wrapper で同期保証する(同一の
`request_id` / `questions` / `ts`)。dashboard は ext を読むのが正解。

### F4: 回答は `question_response` チャネルイベント

client → server → wrapper のチャネルイベント(envelope `type` ではなく、
`permission_decision` と同じ方向別メッセージ)。形状:

- client → server: `{ agent_id, request_id, answers, cancelled? }`(operator のみ)
- server → wrapper: `{ request_id, answers, cancelled? }`(relay)

`answers` は `{ [質問文]: string }`。**質問文をキー**にし、値は選択 option の
`label`。multiSelect は client が `", "` で join した 1 文字列。"Other"(自由記述)は
その文字列がそのまま値。`cancelled: true` は却下(deny 相当)。

### F5: wrapper は `#canUseTool` を分岐、broker 配管を流用

- `host.ts #canUseTool` で `toolName === "AskUserQuestion"` を分岐し、question
  フローへ落とす。`AskUserQuestionInput` から `questions` を取り出し
  `QuestionBroker` に渡す。
- `QuestionBroker` は `PermissionBroker` と **pending-map / timeout / close-deny の
  機構を共有**する(共通コアを抽出、または sibling 実装で流用)。これらの要件は
  permission と同一で、protocol/UX から不可視なため配管は再利用する(C の利点)。
- 回答受信で `{ behavior: "allow", updatedInput: { ...input, answers } }` を返す。
  `cancelled` / timeout / close 時は `{ behavior: "deny", message }`。
- host は `#pendingQuestion` を持ち、`waiting_question` 中の `state_change.ext` に
  `pending_question` を持続付与する(ADR-0022 F3 と同型)。

### F6: viewer 配信は ADR-0021 の allow-list に追従

`question_request` は operator 限定配信とし、viewer へは完全除去して grid 整合の
ため合成 `state_change(waiting_question)`(`payload={}` / `ext` なし)へ置換する
(`permission_request` と同じ扱い)。`ext.pending_question` は ext に乗るため
「viewer は全 type で ext 除去」で自動的に守られる(追加ガード不要)。
server の operator-only allow-list に `question_request` / `question_response` を
追加する。

### F7: snapshot 復元

`question_request` は state_change に相乗りしないが、真実の
`ext.pending_question` が最新 state_change envelope に乗るため、新規 join
クライアントの snapshot でそのまま復元される(ADR-0022 F5 と同型)。DETS 永続化は
不要。

## Consequences

### Positive

- dashboard が構造化選択肢(label / description / preview / multiSelect / Other)を
  専用ダイアログで描画でき、回答を SDK へ正しく返せる(#78 根治)。
- permission の意味に相乗りせず、protocol の状態分離思想と一貫する。
- リロード・再接続時に `ext.pending_question` の snapshot で pending が復元される。
- viewer 漏洩は ADR-0021 の allow-list / ext 除去で自動的に守られる。
- inter-agent の `escalate-to-user`([protocol-inter-agent](../specs/protocol-inter-agent.md))が
  同じ構造化ダイアログを再利用できる(当該 spec の「既存 AskUserQuestion 系 UI 流用」の
  実体になる)。

### Negative

- 状態 `waiting_question` の新設が protocol 状態表 / mermaid・`state.ts`・
  client の状態→表現マッピングへ波及する。「選択待ち」のキャラ表現素材は
  当面既存流用で成立させ、専用素材は後追いとする。
- broker timeout 無制限(ADR-0022 F6)を question にも適用するため、operator が
  無応答だと当該ターンが進まない(permission と同じ挙動、close() で強制 deny)。

### Neutral

- `answers` は multiSelect を client が join した 1 文字列に正規化する(SDK の
  `answers: Record<string,string>` に 1:1 対応)。structured 保持が必要になれば
  後方互換な追補(`version` 据え置き)で拡張可能。
- `annotations`(per-question notes/preview)は当面 passthrough せず、必要時に追補。

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
| A: permission_request/decision を拡張 | allow/deny と構造化回答の意味相乗り。dashboard の描画分岐がフィールド sniff になり、permission 意味が濁って drift 温床 |
| C: wire は専用種別だが state は waiting_permission 流用 | 既存の状態分離(permission/input を別建て)と不整合。ただし broker 配管流用は本 ADR F5 に取り込み済 |
| onUserDialog 経路で受ける | 誤り。`onUserDialog` は refusal_fallback_prompt / side_question 等の別 dialog_kind 用で、AskUserQuestion は canUseTool 経路(公式 docs で確認) |

## Related

- specs: [protocol](../specs/protocol.md)(`question_request` type・
  `ext.pending_question`・`question_response` 方向別メッセージ・状態
  `waiting_question` を追補)、[protocol-inter-agent](../specs/protocol-inter-agent.md)
  (escalate-to-user の「既存 AskUserQuestion 系 UI 流用」が本 ADR の実体を指す)、
  [agent-sdk-events](../specs/agent-sdk-events.md)(canUseTool 経路の
  AskUserQuestion 分岐と回答返却)、[threat-model](../specs/threat-model.md)
  (viewer 漏洩は ADR-0021 経由で自動カバー)。
- ADR: [0021](0021-role-information-disclosure-policy.md)(operator 限定配信の
  allow-list 基盤)、[0022](0022-pending-permission-authoritative-source.md)
  (ext = pending の真実、という同型パターンの原型)。
- 由来: [issue #78](https://gitea.example.invalid/sakurai.yuta/kaoiro/issues/78)。
