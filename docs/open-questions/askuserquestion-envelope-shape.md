---
title: AskUserQuestion の wire envelope 形状(permission 拡張 vs 専用種別)
description: canUseTool 経路で届く AskUserQuestion の構造化質問/回答を、既存 permission_request を拡張して運ぶか、専用 envelope 種別を新設するかを決める。#78 の実装前提。
status: decided
urgency: medium
blocks: []
opened: 2026-07-03
decided: 2026-07-03
---

> **決定(2026-07-03)**: **B**(専用 envelope `question_request` /
> `question_response` + 専用状態 `waiting_question`、broker 配管のみ流用)を採用。
> 決定の正本は [ADR-0027](../adr/0027-askuserquestion-envelope.md)。以下は
> 決定に至った検討の記録。

## 背景

Claude Agent SDK(v0.3.187)の `AskUserQuestion` は、tool permission と
同じ **`canUseTool` 経路**で wrapper に届く(公式 docs
`agent-sdk/user-input`、`sdk-tools.d.ts:724`)。現状 wrapper は
`host.ts:731 #canUseTool` で全てを allow/deny に潰しているため、
構造化情報(question / options / header / multiSelect)が dashboard に
届かず、回答も返せない(#78)。

技術的な回答返却経路は spike で確定済み:

- 入力 `AskUserQuestionInput`: `questions[1-4]` 各
  `{ question, header, options[2-4]{ label, description, preview? },
  multiSelect }`。
- 回答は `canUseTool` から
  `{ behavior: "allow", updatedInput: { ...questions,
  answers: { [質問文]: 選択 label }, annotations? } }` を返す。
  却下/キャンセルは `{ behavior: "deny", message }`。

したがって wrapper は `#canUseTool` 内で
`toolName === "AskUserQuestion"` を分岐し、専用フローに落とす必要がある。
残る決定は **wire(wrapper ↔ server ↔ dashboard)の envelope をどう
モデル化するか**。既存 `permission_request` / `permission_decision`
([ADR-0011](../adr/0011-permission-flow.md) 系)は
`{ tool_name, input }` → `{ allow: boolean, message? }` の
allow/deny 形状で、構造化回答(answers dict)を運べない。

## 選択肢

| 案 | 内容 | メリット | デメリット |
|----|------|----------|-----------|
| A | 既存 `permission_request` / `permission_decision` を拡張(質問 payload を optional 追加、decision に `answers` payload を追加)。state は `waiting_permission` 流用 | 追加種別ゼロ。broker/state をほぼ流用。実装最小 | allow/deny と回答の 2 意味を 1 種別に相乗り。dashboard がフィールド sniff で描画分岐。protocol の意味的濁り(drift 温床) |
| B | 専用 envelope 対 `question_request` / `question_response` を新設。回答 payload(answers/annotations)を first-class に。新 state `waiting_question` も検討 | 意味分離が明快。dashboard の専用ダイアログが素直。回答形状が型として立つ | wrapper/server/dashboard 3 層に新規配線。state 追加ならキャラ表現・遷移表も更新 |
| C(hybrid) | wire は専用種別(B)だが、実装は `PermissionBroker` の pending-map / timeout / close-deny 機構を流用(sibling broker or 共通化)。state は当面 `waiting_permission` 流用、専用 state は将来判断 | 意味分離(B の利点)と実装流用(A の利点)を両取り。段階導入しやすい | broker 共通化の設計が要る。「wire は別・内部は同じ」の対応表を保守する必要 |

## 影響

- **protocol.md / protocol envelope 表**: A は既存行の拡張注記、B/C は
  新種別 2 行 + シーケンス図追記。
- **state 機械**: 新 state を採るなら `waiting_question` を
  `wrapper/src/state.ts` と protocol.md の状態表・mermaid に追加
  (キャラの待機表現も 1 種増える)。流用なら変更なし。
- **inter-agent spec の drift 解消**: `protocol-inter-agent.md:132`
  「既存 AskUserQuestion 系 UI 流用」は本 open-question の決定に依存。
  決定後、当該記述を実体へリンクし直す。
- **dashboard**: いずれの案でも構造化ダイアログ実装は必須(#78 の主眼)。
  差は「描画分岐の判定を種別で行うかフィールドで行うか」。
- **preview**: web 表示なら query options に
  `toolConfig.askUserQuestion.previewFormat: 'html'` を設定(別途)。

## 判断材料

- kaoiro は状態をキャラクターとして可視化する製品([overview](../specs/overview.md))。
  「許可待ち」と「選択回答待ち」を別の状態/表現として見せる価値があるか
  (B/C 寄り)、当面同じ「operator 待ち」で足りるか(A 寄り)。
- 将来 inter-agent の `escalate-to-user` も同じ構造化ダイアログを再利用
  する見込み(`protocol-inter-agent.md`)。再利用性を重視するなら
  回答 payload を first-class 化する B/C が効く。
- 実装/レビューコスト。dogfooding 段階では最小の A が速いが、
  permission 意味の相乗りが後で drift を生むリスク。

## 暫定方針

**C(hybrid)** を推奨。理由: (1) 回答は allow/deny と本質的に別物なので
wire では分離した方が dashboard の描画分岐が素直で drift を生みにくい。
(2) 一方で pending 管理・timeout・close-deny は permission と同じ要件
なので broker 実装は流用できる。(3) 新 state は本当に必要になるまで
持たず、まず `waiting_permission` 流用で段階導入する(キャラ表現の
追加判断を後回しにできる)。A は実装最速だが permission への意味相乗りが
後日の drift 温床になり、kaoiro の「状態=キャラ」設計とも噛み合いにくい。

## 解決時のアクション

- [ ] Decision recorded in `adr/NNNN-askuserquestion-envelope.md`
- [ ] protocol.md に envelope 種別(と必要なら `waiting_question` state)を反映
- [ ] `protocol-inter-agent.md:132` の「既存 AskUserQuestion 系 UI 流用」を実体へリンク
- [ ] #78 のチェックリスト項目 1・4・5(経路設計 / envelope 区別 / 回答返却)へ反映
