# CLAUDE.md

## Project

kaoiro — 複数の CLI AI エージェントの状態をキャラクターとして可視化するシステム。

## Stack

- ラッパー: TypeScript + Claude Agent SDK(`@anthropic-ai/claude-agent-sdk`)
- サーバ: Elixir / OTP + Phoenix
- クライアント: Web(TypeScript)
- ランナー: TypeScript / Node(`@kaoiro/runner`、ホスト常駐の監督層 —
  ADR-0023)。TS 側は pnpm workspace(共有型は `@kaoiro/protocol`)

## Documentation

- 入口: [docs/specs/overview.md](docs/specs/overview.md)
- [docs/specs/](docs/specs/) — 機能仕様(トピック別)
- [docs/plans/](docs/plans/) — フェーズ別の実装計画
- [docs/open-questions/](docs/open-questions/) — 未決の論点
- [docs/adr/](docs/adr/) — アーキテクチャ決定記録
- [docs/specs/agent-sdk-events.md](docs/specs/agent-sdk-events.md) 「検証メモ」 — broker 経路の手動 verify で使えるコマンドの境界

## Commands

- wrapper (TypeScript): `cd wrapper && pnpm test` / `pnpm typecheck` /
  `pnpm build`
- server (Elixir/Phoenix): `cd server && mix test` / `mix format` /
  `mix phx.server`

## Workflow rules

- コミットメッセージは日本語。git 操作はユーザ承認のもとで行う。
- docs/plans/ のタスク表・進捗を更新するときは、frontmatter の
  `status` / `last_updated` も同時に更新する(status drift の予防。
  2026-07-03 に不整合 3 例を検出した再発防止)。
