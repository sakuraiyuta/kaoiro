---
title: Codex 側 personality.md 注入の実効性検証
description: Codex SDK 経由でも Claude と同等の口調・態度を persona personality.md で再現できるかは未検証。fuji/kuroe/ao/momo の代表 4 persona で挙動比較が要る。
status: open
urgency: medium
blocks: [phase-14-codex-adapter]
opened: 2026-07-10
decided: null
---

## 背景

[ADR-0032](../adr/0032-codex-adapter.md) F3 で「persona (`personality.md` + 立ち絵) は engine 非依存で共有」を決定し、Codex adapter 側でも同一 `personality.md` を system prompt 相当に注入する。しかし Codex SDK/CLI の system prompt 相当 API (thread.run options の instructions / system_prompt 相当) が Claude Agent SDK の `systemPrompt.append` と同等の強度で効くか (口調・態度の再現度) は未検証。

背景の詳細は [personas](../specs/personas.md)「ホスト側の受け入れポリシー」節と [ADR-0026](../adr/0026-persona-personality-injection.md) (superseded by [ADR-0029](../adr/0029-persona-server-sot-and-pack-distribution.md))。

## 選択肢

| 案 | 内容 | メリット | デメリット |
|----|------|----------|-----------|
| A | 同一 `personality.md` をそのまま Codex 側にも注入 (現方針) | pack 資産共有、engine 追加コスト最小 | Codex 側再現度が Claude 未満の可能性 |
| B | Codex 側で prefix / suffix を軽く整形 (例: "You are a character described below:\\n\\n" prefix) | 軽量な engine 別調整 | 調整基準が主観的 |
| C | `personality.md` に engine 別セクション (`## for-claude` / `## for-codex`) を書ける拡張 | 精密なチューニング可能 | pack 作成者運用複雑化、[ADR-0032](../adr/0032-codex-adapter.md) F3 で rejected した option を復活 |

## 影響

phase-14 完了判定 (代表 persona 動作確認) をブロックする。Codex 側で kuroe が Claude と同等に「淡々として諫言を厭わない有能秘書」として振る舞わなければ、kaoiro のキャラクター可視化価値が engine ごとに揺らぐ。

## 判断材料

- Codex SDK の system prompt 相当 API の有無 (`thread.run` の options に instructions / system_prompt が渡せるか、CLI 側 `~/.codex/prompts/` との関係)
- fuji / kuroe / ao / momo の 4 persona で同一プロンプトを Codex に投げた実挙動 (7 状態別の応答口調・態度)
- Claude 側との比較のための評価軸 (一人称・語尾・態度・応答の詳細度)

## 暫定方針

phase-14 開始時に案 A で走らせ、実挙動を評価する。実効性が明らかに落ちるようなら案 B (軽量整形) を検討、それでも足りない場合のみ案 C の pack schema 拡張を別 ADR で扱う。

## 解決時のアクション

- [ ] 4 persona × Codex での挙動比較レポートを [personas](../specs/personas.md) に追記または本 open-question を ADR に昇格
- [ ] 案 A で十分なら本 open-question を close (deferred → 削除)、案 B / C を採るなら [ADR-0032](../adr/0032-codex-adapter.md) F3 の追補 ADR として昇格
- [ ] 決定を [phase-14-codex-adapter](../plans/phase-14-codex-adapter.md) 完了報告に含める
