# CLAUDE.md

## Project

kaoiro — 複数の CLI AI エージェントの状態をキャラクターとして可視化するシステム。

## Stack

- ラッパー: TypeScript。engine ごとにパッケージを分け、Claude Code は
  Claude Agent SDK(`@anthropic-ai/claude-agent-sdk`)、Codex は Codex SDK を
  ホストする(`core` / `agent-common` / `claude-code` / `codex` の 4
  パッケージ — ADR-0017 / ADR-0032)
- サーバ: Elixir / OTP + Phoenix
- クライアント: Web(TypeScript)。同梱ダッシュボードは Svelte 5 + Vite
  (`dashboard/`、pnpm workspace の非メンバで独立ルート・独立 lockfile)
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
  `pnpm build`(4 パッケージへの fan-out shim)
- runner (TypeScript): `cd runner && pnpm test` / `pnpm typecheck` /
  `pnpm build`
- dashboard (Svelte): `cd dashboard && pnpm test` / `pnpm check` /
  `pnpm build`(workspace 非メンバなので個別に `pnpm install`)
- server (Elixir/Phoenix): `cd server && mix test` / `mix format` /
  `mix phx.server`
- 全層まとめて開発起動: `./scripts/dev.sh`

## Branch strategy

issue #213 で導入。エージェントの permission gate が `main` 宛の git 操作を
ブロックするため、統合ブランチ `develop` を挟む。

| ブランチ | 役割 | 更新できる主体 |
|---|---|---|
| `main` | リリース / 安定ブランチ。default branch | **オペレータのみ** |
| `develop` | 統合ブランチ。CI はここでも走る | エージェント可 |
| `issue-NNN-*` | feature branch | エージェント可 |

- feature branch は `develop` から派生し、`develop` へ **fast-forward
  マージ**して戻す。ここまではエージェントが自動で行える
- `develop` → `main` は区切りごとに**オペレータが手動**で行う
- worktree の base は `develop`

### Remotes

正本は GitHub (`origin`)。公開以前の self-hosted Gitea リポジトリは
読み取り専用アーカイブとして現状のまま温存する (オペレータ決定
2026-09-01)。clone に `gitea` remote が残っていても削除・push しない。
旧系譜の branch は現履歴と互換がないため、fetch 先を混在させないこと。

## Workflow rules

- コミットメッセージは英語 (OSS 公開後は英語で読まれるため。件名は
  `type(scope): summary` の形、本文も英語)。git 操作はユーザ承認のもとで
  行う (`develop` 以下は上記 Branch strategy の範囲で自動可)。
- docs/plans/ のタスク表・進捗を更新するときは、frontmatter の
  `status` / `last_updated` も同時に更新する(status drift の予防。
  2026-07-03 に不整合 3 例を検出した再発防止)。

## Multi-agent workflow

複数のエージェントが同一 work tree で並行作業する前提の運用則は
[docs/specs/agent-operations.md](docs/specs/agent-operations.md) が正本
(実装を受けた側 / dispatch する側)。engine を問わず適用する。Codex 系
エージェント向けの入口は [AGENTS.md](AGENTS.md)。
