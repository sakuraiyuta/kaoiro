---
title: kaoiro 概要
description: CLI AI エージェントの状態をキャラクターとして可視化するシステムの目的・ゴール・対象。
status: accepted
related: [architecture, non-goals, glossary]
---

# kaoiro 概要

## Purpose

Claude Code や Codex のような CLI ベースの AI エージェントは、状態・進捗が
分かりにくく、複数運用では誰が何をしているか追いづらく、親しみも湧きにくい。
kaoiro はエージェントを「顔色(キャラ + 表情)」で可視化し、状況把握と愛着の
両方を狙うラッパー/可視化システムである。

## Definition

### 解決する2つのゴール(信号源を分離する)

| ゴール | 何で解決するか | 一次信号 |
|---|---|---|
| (A) 進捗・状態の把握(実用) | 状態機械 | 構造化イベント(実行中/入力待ち/エラー/完了/権限待ち) |
| (B) 親しみ(情緒) | キャラクター + 表情 | 状態 +(任意で)感情 NLP |

- 「進捗が確認しづらい」を解くのは (A)。応答テキストは事務的で感情信号が薄く、
  sentiment から状態を推すと外す。
- 表情の一次ソースは意味の確かな状態(例: 権限待ち → こちらを見て待つ)。
- 感情 NLP は "味付け"。落ちても可視化の実用性は崩れない。

### 対象利用者

主に自分(および研究室)。複数 AI エージェントを日常的に並行運用する開発・
研究ワークフローを前提とする。

### スコープ(やること・初期)

- エージェント 1 個の状態を engine SDK のメッセージ列から取得し、状態機械
  として表現([architecture](architecture.md))。Claude Code を最初の対象と
  し、Codex は phase-14 で同じ `EngineAdapter` 境界の裏に追加した
  ([ADR-0032](../adr/0032-codex-adapter.md))。
- 複数エージェントの状態をサーバへ集約し、クライアントで可視化。
- 特定エージェントへ指示を送る(双方向)。
- 権限承認(ツール実行の許可待ち)をクライアント UI へ回す。
- エージェントごとのペルソナを永続化
  ([ADR-0003](../adr/0003-persona-identity-persistence.md))。

非スコープは [non-goals](non-goals.md) を参照。

## Constraints

- SHOULD: ラッパーは TypeScript + engine SDK、サーバは Elixir/Phoenix、
  クライアントは Web(TS)。詳細は [architecture](architecture.md)。

## Open Questions

なし(本 spec は accepted)。

## See Also

- 関連 specs: [architecture](architecture.md), [non-goals](non-goals.md),
  [glossary](glossary.md)
- ADRs: [0001](../adr/0001-agent-sdk-integration.md)
