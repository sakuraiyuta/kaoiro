---
title: capabilities フィールド旧値 "claude" の互換窓
description: register payload の capabilities: ["claude"] を旧 runner が送ってきた場合の受け入れ期間と server 側 warning ロジック。ADR-0031 の persona legacy 窓 (1 リリース) と足並みを揃えるか。
status: open
urgency: low
blocks: []
opened: 2026-07-10
decided: null
---

## 背景

[ADR-0032](../adr/0032-codex-adapter.md) F4a で `capabilities` フィールドの値集合を `claude-code` / `codex` に確定し、現状値 `claude` は `claude-code` にリネームすることを決定。runner が更新されるまでの間、旧値 `claude` を送ってくる runner に対する server 側の受け入れポリシーを決める必要がある。

背景の詳細は [ADR-0032](../adr/0032-codex-adapter.md) F4a、[protocol](../specs/protocol.md) の runner 制御メッセージ、[ADR-0031](../adr/0031-runner-persona-trust-mode.md) Migration 節 (persona legacy フィールドの 1 リリース窓)。

## 選択肢

| 案 | 内容 | メリット | デメリット |
|----|------|----------|-----------|
| A | 1 リリース窓で並置 (旧値 `claude` を `claude-code` にサイレント正規化し deprecation warn) — ADR-0031 と同じパターン | 実績あるパターン、runner 更新遅延に耐性 | server 実装に写像コード追加 |
| B | 即座に厳格化 (旧値 `claude` は reject して runner 起動失敗) | 実装ワンショット | 旧 runner バイナリの互換破壊 (ADR-0018 配布方針との整合を要検証) |
| C | 無期限受け入れ (エイリアスとして永続) | 破壊性ゼロ | dead code 保守が発生 |

## 影響

なし (実装コスト小、決めれば即実装可)。旧 runner バイナリの再ビルド・再配布と一緒にリリースサイクルの中で片付く。

## 判断材料

- 現在稼働中の runner の分布 (`claude-runner` バイナリを配布済みか、開発者手元だけか)
- [ADR-0018](../adr/0018-runner-distribution.md) の配布方針との整合 (単一バイナリで OS 別配布、更新頻度)
- ADR-0031 で採った persona legacy 窓 (1 リリース) との足並み

## 暫定方針

案 A (1 リリース窓で並置 + deprecation warn)。ADR-0031 のパターンを踏襲。

## 解決時のアクション

- [ ] server 側 register handler に旧値 `claude` → `claude-code` の正規化と warn を実装
- [ ] 次期リリースで case を撤去 (`claude` を厳格 reject へ)
- [ ] 決定内容を [ADR-0032](../adr/0032-codex-adapter.md) F4a に追記 (互換窓の期間と削除タイミング)
- [ ] 本 open-question を close (削除)
