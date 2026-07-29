---
title: 協調指針の具体文面と長さ
description: 共通フッターへ追記する協調行動指針の文面と分量を決める。フッター肥大 (全エージェントの常時 context 消費) との折り合いが論点。
status: open
urgency: medium
blocks: []
opened: 2026-07-28
decided: null
---

## 背景

[ADR-0044](../adr/0044-coordination-injection-hitl.md) F1 は協調指針
を [ADR-0029](../adr/0029-persona-server-sot-and-pack-distribution.md)
の server SoT 共通フッターへ追記すると決めたが、具体の文面と長さは
未定。フッターは全エージェントの system prompt に常時載るため、
肥大はそのまま context 消費になる (ADR-0026/0029 は人格記述に
200-1000 字の SHOULD 目安を置いた)。

## 選択肢

| 案 | 内容 | メリット | デメリット |
|----|------|----------|-----------|
| A | フッターに短い行動原則のみ (観察 → 判断 → 分担の原則と director 規約を数行で) | context 消費最小。engine 非依存を保つ | 具体的な手順 (kind の使い分け、報告形式) は agent の解釈に依存 |
| B | フッター + 詳細は別配布 (原則はフッター、手順詳細は tool description や参照文書へ逃がす) | 原則と詳細の両立 | 配布層が増え SoT 管理が複雑化 (ADR-0044 が併用案を rejected した趣旨との整合に注意) |

## 影響

ADR-0044 の実装 (kaoiro issue #87 派生) のうち、フッター文面の確定
がブロックされる。注入機構自体の実装は文面と独立に進められる。

## 判断材料

- 行動原則を何行で表現できるかの試作
- [coordination-report-routing](coordination-report-routing.md) の
  決定内容 (文面に含めるべき規約の量が変わる)
- ADR-0044 F2 (director 媒介) の再決裁結果 — director 規約を文面に
  含めるか否かが決まる

## 暫定方針

なし (未決)。案 A から始めて不足分を計測するのが自然だが、確定は
文面試作後。

## 解決時のアクション

- [ ] 文面を確定し server SoT フッターへ反映する
- [ ] persona-personality-injection spec に文面の位置付けを追記する
- [ ] 本 open-question を close (削除)
