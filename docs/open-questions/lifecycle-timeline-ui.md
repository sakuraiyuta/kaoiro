---
title: 遷移時系列の dashboard UI
description: session_lifecycle 時系列を dashboard でどう可視化するか (AgentDetail タイムライン vs #175 統合ビュー)
status: open
urgency: medium
blocks: []
opened: 2026-08-31
decided: null
---

# 遷移時系列の dashboard UI

## 背景

[ADR-0055](../adr/0055-compaction-resume-and-lifecycle-log.md) は
first cut を operator 向け pull query までとし、UI を分離した。
issue #175 (進行中 compaction の peer / operator への可視化) は
この記録層の消費者として再定義できる。

## 選択肢

- A: AgentDetail にタイムライン表示を追加する
- B: issue #175 と統合した専用ビューを作る

## 影響

phase-33 Stage C (pull query) までは query 結果の生データ参照のみで、
UI での俯瞰はできない。

## 判断材料

issue #175 側の要求 (リアルタイム性・peer への開示範囲) と、時系列
俯瞰 (事後デバッグ) の要求がどこまで同じ画面で満たせるか。

## 暫定方針

別 issue として起票し、#175 をこの土台の消費者として再定義する
(スコープは着手時に決定)。
