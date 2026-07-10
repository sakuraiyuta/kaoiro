---
title: Codex adapter の cwd 変化抽出方式
description: Codex event stream の item.command_execution からの cd 抽出 / wrapper 側 pre-run env で固定 / Codex hooks (PreShellCall 相当) 使用、のどれか。best-effort、MVP は起動 cwd 固定で許容。
status: open
urgency: low
blocks: []
opened: 2026-07-10
decided: null
---

## 背景

[ADR-0032](../adr/0032-codex-adapter.md) F9 で `EngineAdapter` interface に cwd 通知契約 (`onCwdChanged` 相当) を持たせ、Codex adapter は MVP 未実装 (起動 cwd 固定表示) と決定。動的追跡は本 open-question で候補を追跡し、必要になったフェーズで実装する。

背景の詳細は Claude 側の [issue #95](https://gitea.example.invalid/sakurai.yuta/kaoiro/issues/95) (SDK が Bash の cd を永続化せず CwdChanged が発火しない、上流バグ待ち) と、[protocol](../specs/protocol.md) の `ext.cwd`。Claude 側でも実動不安定という状況で、Codex 側の抽出は同じ level の low urgency。

## 選択肢

| 案 | 内容 | メリット | デメリット |
|----|------|----------|-----------|
| A | Codex event stream の `item.command_execution` から `cd` を含むコマンドをパース抽出 | 追加インフラ不要、event 経路のみで完結 | パース fragile (`cd $(pwd)/x` など複雑ケース多数)、shell の cd と process の cwd の乖離 |
| B | wrapper 側で pre-run env に `PWD` を注入し、shell hooks で prompt に埋めるなど | 精度は高い | 実装複雑、Codex CLI の shell 起動方式に依存 |
| C | Codex hooks system (v0.116+ の PreShellCall / PostShellCall 相当) を使う | Codex ネイティブ経路で clean | Codex hooks 実装状況の追随が要 |
| D | 動的追跡を諦め、起動 cwd 固定表示に留める (MVP 相当) | 実装ゼロ | UX 劣化 (`ext.cwd` が動的情報として意味を失う) |

## 影響

なし (best-effort、phase-14 完了判定に含まれない)。cwd 表示が起動 cwd で固定される dashboard 表示になるが、これは Claude 側 SDK バグ状況と同 level。

## 判断材料

- Claude 側 [issue #95](https://gitea.example.invalid/sakurai.yuta/kaoiro/issues/95) の上流解決状況 (SDK 側で解決したら kaoiro 側の需要も変わる)
- Codex SDK 0.144.1 の hooks system 対応範囲 (v0.116 で導入されたが具体機能を要確認)
- Codex event stream `item.command_execution` の情報粒度

## 暫定方針

MVP は案 D (起動 cwd 固定表示) で phase-14 完了。動的追跡は Claude 側 [#95](https://gitea.example.invalid/sakurai.yuta/kaoiro/issues/95) の解決を待って kaoiro 側方針を再検討し、そのタイミングで案 A / B / C から選択。

## 解決時のアクション

- [ ] Claude 側 [#95](https://gitea.example.invalid/sakurai.yuta/kaoiro/issues/95) 解決時に kaoiro 側追跡方針も再検討
- [ ] 実装方式を [ADR-0032](../adr/0032-codex-adapter.md) F9 の追補として本 open-question 解決時に本文に取り込むか、独立の ADR に昇格
- [ ] 本 open-question を close (削除)
