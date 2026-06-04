# CLAUDE.md

## Project

kaoiro — 複数の CLI AI エージェントの状態をキャラクターとして可視化するシステム。

## Stack

- ラッパー: TypeScript + Claude Agent SDK(`@anthropic-ai/claude-agent-sdk`)
- サーバ: Elixir / OTP + Phoenix
- クライアント: Web(TypeScript)

## Documentation

- 入口: [docs/specs/overview.md](docs/specs/overview.md)
- [docs/specs/](docs/specs/) — 機能仕様(トピック別)
- [docs/plans/](docs/plans/) — フェーズ別の実装計画
- [docs/open-questions/](docs/open-questions/) — 未決の論点
- [docs/adr/](docs/adr/) — アーキテクチャ決定記録

## Commands

- 実装未着手。build/test/lint コマンドは Phase 1 で確定する。

## Workflow rules

- コミットメッセージは日本語。git 操作はユーザ承認のもとで行う。
