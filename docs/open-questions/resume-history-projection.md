---
title: resume 時の過去履歴取得とサーバ表示履歴への投影
description: resume 後にサーバ表示履歴を SDK JSONL から再構築する手段(SDK 再 stream か runner 直接パースか)が未確定。
status: open
urgency: high
blocks: []
opened: 2026-06-16
decided: null
---

## 背景

[ADR-0014](../adr/0014-session-resume-and-restore.md) は会話履歴の正本を
wrapper ホストの SDK JSONL とし、サーバの表示用リングバッファ
([ADR-0012](../adr/0012-response-display-and-dashboard-scope.md) F7)を
そこから再構築可能な投影と位置づけた。resume(復帰・召喚)時に、サーバの
表示履歴を JSONL の内容で再構築・上書きしたいが、過去会話履歴を **どう取得
してサーバへ供給するか** の手段が未確定。

## 選択肢

| 案 | 内容 |
|----|------|
| A | SDK の `resume` が過去メッセージを再 stream する想定で、wrapper がそれを拾って履歴 envelope として転送する |
| B | runner / wrapper が JSONL を直接読んでパースし、履歴 envelope として再送する |

加えて、resume 後に kaoiro の streaming 入力モード
(`AsyncIterable<SDKUserMessage>`)で **以降の指示・承認を継続投入できるか**
が SDK 挙動として未確認(旧 `existing-agent-summon` の論点を継承)。

## 影響

未確定の間も復帰機能の中核(session_id 指定 resume)は成立するが、復帰後の
ダッシュボード表示が過去ログを欠く(ADR-0014 phase-2 がブロックされる)。
streaming 入力継続が不可なら復帰機能自体(phase-1)が成り立たないため、
こちらは phase-0 / phase-1 の関門。

## 判断材料

- SDK は `resume` / `continue` / `forkSession` を持つ
  (`@anthropic-ai/claude-agent-sdk` 型定義)。
- 履歴は `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`(JSONL)。
- サーバは履歴を保持せず最新 envelope + リングバッファのみ
  (`server/lib/kaoiro_server/agent_states.ex`)。

## 暫定方針

ADR-0014 phase-0 で SDK の resume 挙動(過去履歴の供給形・streaming 入力継続の
可否)を実検証して A/B を確定する。streaming 継続が不可と判明した場合は
phase-1 設計に立ち戻る。

## 解決時のアクション

- [ ] phase-0 で SDK resume 挙動を実検証(履歴供給形・streaming 継続)
- [ ] A/B を確定し ADR-0014 phase-2 の実装方針へ反映
- [ ] このファイルを ADR へ昇格(または ADR-0014 追補で解決)
