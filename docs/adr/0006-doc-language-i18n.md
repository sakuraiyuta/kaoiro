---
title: ドキュメント・UI は日本語、ベータ前に全英訳
status: accepted
date: 2026-06-04
opened: 2026-06-04
supersedes: []
superseded_by: null
related_specs: []
related_adrs: [26]
---

# ADR-0006 — ドキュメント・UI は日本語、ベータ前に全英訳

## Status

Accepted

## Context

ドキュメント・UI の言語をどうするかが問題だった。当面の開発者は日本語話者で、
初期は日本語の方が速い。一方、外部公開を見据えると英語化が要る。

## Decision

- プロトタイプ期はドキュメント・UI とも**日本語**。
- **ベータリリース前に全英訳工程**を独立マイルストーン
  ([plans/phase-5-i18n](../plans/phase-5-i18n.md))として実施し、以降の主言語を
  その時点で判断する。

## Consequences

### Positive

- 初期の開発速度を確保。

### Negative

- ベータ前に一括翻訳のコストが発生する。

### Neutral

- 主言語の最終方針は Phase 5 で決める。

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
| 最初から英語 | 初期の開発速度が落ちる |
| 二言語を常時並行維持 | 維持コストが高い |
