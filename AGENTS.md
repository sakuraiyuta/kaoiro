# AGENTS.md

kaoiro リポジトリで作業するエージェント向けの入口。

**作業を始める前に
[docs/specs/agent-operations.md](docs/specs/agent-operations.md) を読むこと。**
複数のエージェントが同一 work tree で並行作業する前提の運用則(実装を受けた
側 / dispatch する側)の正本で、engine を問わず適用する。

プロジェクトの構成・コマンド・ブランチ運用は [CLAUDE.md](CLAUDE.md) にある。
ファイル名は Claude Code 由来だが、内容は engine 非依存なので同じものを読む。

正本を開く前でも、次の 6 点だけは先に頭へ置いておくこと。

1. タスクの実スコープを変える食い違いを見つけたら、**実装の前に** dispatch
   元へ query を送る。完了報告と同時ではない。
2. 割り当てられたサブディレクトリの外は触らない。見つけた問題は報告に留める。
3. 他エージェントの未 commit 変更を revert / stage しない。`git add -A` を
   使わず、自分の変更ファイルだけを明示 add する。
4. push 済み commit を amend しない。修正は常に新規 commit。
5. inter-agent の会話は双方が `done=true` を送って初めて終わる。
6. リポジトリに残るものは英語で書く: コミットメッセージ (件名は
   `type(scope): summary`)、issue / PR の題名・本文・コメント、docs、コード
   コメント。会話とエージェント間メッセージはセッションの言語のまま。
   詳細は CLAUDE.md の Language。
