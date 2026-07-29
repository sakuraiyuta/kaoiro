---
title: send_to_agent auto-allow の範囲
description: 自律協調の前提となる send_to_agent の operator 承認緩和を、kind 別 / conversation 単位 whitelist / 全面のどの範囲で行うかを決める。
status: open
urgency: high
blocks: [protocol-inter-agent]
opened: 2026-07-28
decided: null
---

## 背景

[ADR-0044](../adr/0044-coordination-injection-hitl.md) F2 (director
媒介の自律協調、要再決裁) の前提として、`send_to_agent` の
`canUseTool` 承認
([protocol-inter-agent](../specs/protocol-inter-agent.md) の承認
フロー) を緩和する必要がある。同 spec は「自動承認の仕組み (per
conversation_id whitelist) は Phase 2 以降」と保留してきたが、これを
前倒しで決定する。運用上は返信のみ事前承認 (2026-07-21 マスター
決裁) が先行しており、発信を含む一般化が論点。

## 選択肢

| 案 | 内容 | メリット | デメリット |
|----|------|----------|-----------|
| A | kind 別 allow (query/inform/response 等は自動、request/propose の初回発信は承認) | 会話の性質で危険度を区別できる | kind の意味論に承認可否が結合し、運用の説明が複雑 |
| B | conversation 単位 whitelist (初回のみ承認、以降その会話は自動) | spec が想定済みの経路。初回 HITL で暴走の起点を抑制 | 会話が乱立すると承認回数が減らない |
| C | 全面 auto-allow (dashboard 観測のみ) | 自律性最大・実装最小 | 暴走対話の初動を operator が止められない |

## 影響

ADR-0044 の実装 (kaoiro issue #87 派生) がブロックされる。

## 判断材料

- #87 の「終わり方設計」(timeout / max_turns / escalate) の整備状況
  — ガードが強いほど広い auto-allow を許容できる
- director 媒介の検証 (director 経由の会話だけ自動、等の折衷案) の
  実装コスト

## 暫定方針

なし (未決)。

## 解決時のアクション

- [ ] 決定を ADR に昇格し、protocol-inter-agent の承認フロー節を
      改訂する
- [ ] 本 open-question を close (削除)
