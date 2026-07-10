---
title: 権限二軸 UI の operator 向け語彙と preset ショートカット
description: LaunchDialog / AgentDetail の sandbox / approval セレクト ラベル、初期値 preset (default / dev-friendly / yolo 等) の命名。dashboard 実装をブロック。
status: open
urgency: medium
blocks: [phase-14-codex-adapter]
opened: 2026-07-10
decided: null
---

## 背景

[ADR-0033](../adr/0033-permission-model-dual-axis.md) F4 で LaunchDialog / AgentDetail の権限 UI を二軸表示に更新することが決まった。二軸 (sandbox × approval) はそのまま UI に出すと選択肢が多くなり operator 認知負荷が上がるため、代表的な組合せを preset ショートカット (「default / dev-friendly / yolo」など) として用意し、二軸個別の指定は「詳細」で開く形が現実的。preset の命名と包含する組合せをここで決める。

背景の詳細は [ADR-0033](../adr/0033-permission-model-dual-axis.md) F4、[personas](../specs/personas.md) の spawn UX。

## 選択肢

### preset ショートカットの命名

| 案 | preset 例 | メリット | デメリット |
|----|-----------|----------|-----------|
| A | `default` / `edit-friendly` / `yolo` / `plan-only` (機能名) | 意図が字面から読める | preset 数増で picker が長くなる |
| B | `safe` / `medium` / `bold` / `plan` (相対度合い) | operator 直感的 | 「safe」の意味が engine 差で変わる (Claude の default と Codex の default は違う) |
| C | Claude 4 mode の名前をそのまま流用 (`default` / `acceptEdits` / `bypassPermissions` / `plan`) | 既存 dashboard 実装との連続性 | Codex 使い視点で唐突、二軸表現の意味を隠す |

### 二軸個別セレクトのラベル

| 案 | sandbox ラベル | approval ラベル | メリット | デメリット |
|----|---------------|----------------|----------|-----------|
| L-A | 「書き込み範囲」/「承認頻度」 | 日本語で意味直訳 | 母語話者に自明 | Codex CLI 使いが「sandbox_mode」で覚えている用語との断絶 |
| L-B | 「sandbox」/「approval」 (英語 semi-transliteration) | Codex CLI 用語と 1:1、engine 語彙の学習コスト再利用 | 日本語 UX の断絶 |
| L-C | 両方併記 (「書き込み範囲 (sandbox)」等) | 学習・自明性の両立 | ラベル冗長 |

## 影響

phase-14 の dashboard 実装 (LaunchDialog / AgentDetail) をブロックする。envelope schema (Q2) が確定してから決めれば良いので順序は Q2 → Q3。

## 判断材料

- 想定 operator の Codex CLI 経験 (「sandbox_mode」という語彙に馴染みがあるか)
- 現状 dashboard の日本語 UX の一貫性 (母語話者向けに寄せているか、英語混在許容か)
- kaoiro の I18n 方針 ([ADR-0006](../adr/0006-doc-language-i18n.md): 日本語、ベータ前に全英訳)

## 暫定方針

phase-14 dashboard 実装時に案 A (機能名 preset) + L-C (両方併記ラベル) を仮採用。preset の初期セットは `default` (workspace-write × on-request) / `edit-friendly` (workspace-write × edit のみ granular) / `yolo` (danger-full-access × never) / `plan-only` (read-only × on-request) の 4 種で開始し、実運用フィードバックで調整。

## 解決時のアクション

- [ ] 決定内容を [ADR-0033](../adr/0033-permission-model-dual-axis.md) F4 に追記 (preset 一覧と個別ラベル)
- [ ] dashboard 実装の Svelte コンポーネント名・i18n キーに反映
- [ ] 本 open-question を close (削除)
