---
title: Codex exec の承認フロー upstream 対応の追跡
description: codex exec は approval_policy を never に強制し caller へ承認要求を返せない。upstream feature flag exec_permission_approvals (開発中) の stable 化を追跡し、対応時に kaoiro の Codex 承認 UX を再設計する。
status: open
urgency: low
blocks: []
opened: 2026-07-10
decided: null
---

## 背景

[ADR-0033](../adr/0033-permission-model-dual-axis.md) の実 SDK 検証 (2026-07-10) で、`codex exec` (= `@openai/codex-sdk` の実行路) は harness override で `approval_policy=never` を強制し、JSON event stream にも承認要求 event が無いことが確定した。このため Codex agent の権限は spawn 時固定二軸とし、`waiting_permission` は Codex では発生しない設計を採った。

upstream には feature flag `exec_permission_approvals` (0.144.1 時点で under development) が存在し、将来 exec モードでも承認フローが提供される可能性がある。また experimental の `codex app-server` (JSON-RPC over stdio) には既に承認要求プロトコルが存在する。

## 選択肢

| 案 | 内容 | メリット | デメリット |
|----|------|----------|-----------|
| A | `exec_permission_approvals` が stable 化した時点で SDK/exec 経由の承認を配線し、Codex でも `waiting_permission` を成立させる | published な経路のまま Claude と対等の承認 UX | 時期不明 |
| B | `codex app-server` へ乗り換えて先行対応 | 今すぐ可能 | experimental protocol 依存、実装コスト大 (ADR-0033 で rejected) |
| C | 恒久的に起動時固定二軸のまま | 実装ゼロ | 承認 UX の engine 非対称が恒久化 |

## 影響

なし (現行設計は固定二軸で完結)。upstream 対応時に Codex の権限 UX が改善できる、という機会の追跡。

## 判断材料

- upstream `openai/codex` の `exec_permission_approvals` feature flag の状態 (`codex features list` で確認可)
- `@openai/codex-sdk` への承認 callback API の追加有無 (release notes)
- `codex app-server` の安定化状況

## 暫定方針

案 A を待つ。Codex SDK のバージョン更新時に `codex features list` と SDK changelog を確認し、承認経路が公開されたら本 open-question を ADR に昇格して再設計する。

## 解決時のアクション

- [ ] [ADR-0033](../adr/0033-permission-model-dual-axis.md) F3 (approval never 固定) を改訂する ADR を起こす
- [ ] wrapper/codex に承認 callback を配線し、`waiting_permission` / `pending_permission` を Codex でも成立させる
- [ ] dashboard の Codex 権限 UI (sandbox のみ) に approval セレクトを追加
- [ ] 本 open-question を close (削除)
