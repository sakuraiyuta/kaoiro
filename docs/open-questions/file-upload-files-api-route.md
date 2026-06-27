---
title: ファイルアップロード — Files API 経路(>32 MB を扱うか)
description: SDK 実効上限 32 MB を超える大ファイル(image >10 MB / PDF >32 MB / 合計 >32 MB)を Claude Files API 経由(file_id 参照)で送る経路を採用するかの未決論点。
status: open
urgency: low
blocks: []
opened: 2026-06-27
decided: null
---

## 背景

Phase 7 Stage A の spike(IN2)で、 Claude API の content block 実効上限が
判明した: image 10 MB(base64 後)/ PDF 32 MB / **リクエスト合計 32 MB が
ハード上限**。 kaoiro spec の個別 128 MB 上限は wrapper-local の受信上限で
あって、 SDK 受理上限とは別物。 MVP では fit-to-SDK が downsize /
page-extract で 32 MB 以内に縮めるが、 縮められない場合(超高解像度画像 /
600 ページ超 PDF 等)は reject される。

Files API(`file_id` 経由)を使えば 1 file 500 MB まで上げられる(beta
header `files-api-2025-04-14` 必須)。 ただし Agent SDK 経由で beta header
を通す経路があるかは spike で未確認。

## 選択肢

| 案 | 内容 | メリット | デメリット |
|--|--|--|--|
| A | base64 inline 経路のみ(MVP)、 32 MB 超は fit-to-SDK or reject | 実装最小、 protocol surface 不変、 spike 不要 | 超大ファイルは事実上 reject |
| B | Files API(`file_id` 参照)経路を併設 | 500 MB まで実用、 同一ファイル多ターン再利用が efficient | Files API beta header の有効化方法を spike、 wrapper の Files API 連携実装、 ライフサイクル管理(file 削除タイミング)が増える |

## 影響

A の場合は protocol 不変、 wrapper の fit-to-SDK と reject で UX を完結。
B 採用時は wrapper に Files API client 連携を追加、 instruction 中の
content block を `{type: "image", source: {type: "file", file_id: "..."}}`
形式へ生成する経路を増やす(protocol 上は wrapper-internal の話で
client/server は不変)。

## 判断材料

- 32 MB 超のファイル(超高解像度画像 / 大物 PDF / RAW 等)を実運用で扱う
  頻度
- Agent SDK 経由での Files API beta header 有効化の実現可能性(要 spike)
- Files API のライフサイクル(同一 organization 内で 500 GB まで蓄積、
  明示削除が必要)を wrapper が担えるか
- Bedrock / Vertex AI 利用想定の有無(Files API 非対応)

## 暫定方針

A — MVP は base64 inline 経路のみ。 32 MB 超の運用要求が出たら spike →
B 採用を検討。

## 解決時のアクション

- [ ] Agent SDK 経由での Files API beta header 有効化を spike
- [ ] wrapper に Files API client 連携を実装(`@anthropic-ai/sdk` を直接利用)
- [ ] file ライフサイクル管理(upload → 参照 → 削除)を spec 化
- [ ] ADR 昇格、 本ファイル削除
