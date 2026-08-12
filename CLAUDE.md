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

issue #223 で導入。エージェントの permission gate が `main` 宛の git 操作を
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

## Workflow rules

- コミットメッセージは日本語。git 操作はユーザ承認のもとで行う
  (`develop` 以下は上記 Branch strategy の範囲で自動可)。
- docs/plans/ のタスク表・進捗を更新するときは、frontmatter の
  `status` / `last_updated` も同時に更新する(status drift の予防。
  2026-07-03 に不整合 3 例を検出した再発防止)。

## Multi-agent workflow

複数のエージェントが同一 work tree で並行作業する前提の運用則。

### 実装を受けた側

- 判断を要すると告げられた点、および実装中に見つけた「タスクの実スコープを
  変える食い違い」は独断で決めず、dispatch 元へ query を送る。往復は**実装の
  前**に行う。完了報告と同時に出すと、相手に判断の余地が残らない。
- 自分の変更が入れた不具合は in-scope。判定は「自分の diff を revert したら
  この不具合も消えるか」。消えるなら直して報告する(query は往復が増える
  だけで、director に決めることが残っていない)。消えないなら query 先行。
  ただし修正が割り当てサブディレクトリの外へ出る場合は、下記のサブ
  ディレクトリ則を優先して query する。
- 割り当てられたサブディレクトリの外は触らない。見つけた問題は報告に留める。
- 他ペルソナの未 commit 変更を revert / stage しない。自分のスコープ外の
  予期しない diff は進行中の作業とみなし、存在だけを報告する。
- git: push 済み commit を amend しない。`git add -A` を使わず自分の変更
  ファイルだけを明示 add する。peer の git 操作が pending の間は同一 branch
  へ commit を差し込まない。
- 会話は双方が `done=true` を送って初めて終わる。相手が先に送っていても
  自分からも返す。
- flaky test は再実行の前に出力を保存する。テスト名・stack trace・seed は
  再実行が green になった瞬間に失われる(ExUnit は失敗時に
  `mix test --seed <N>` の再現行を出力する)。
- 合意した修正が「どの成果物に入ったか」を成果物ごとに確認する。1 件の合意に
  対し反映先が複数(コード / ADR / issue 本文 / 起案文面)あるとき、1 つで
  確認して残りを推定しない。

### dispatch する側 (director)

- peer の engine で利用できない仕組みを完了条件に課さない。Claude Code の
  custom skill と hook pipeline(`/my-code-review-cycle` 等)は
  `engine: claude-code` の peer にしか無い。代わりに具体的な検査を dispatch
  文面へ列挙する — diff の自己レビュー、該当範囲の typecheck / test、
  bugfix なら mutation または negative control による修正の実効性の証明、
  外部レビュー。
- 自セッションの rate limit 使用率は自分では見えない(`whoami` は context の
  み)。`list_agents` の peer envelope に載る `rate_limits` を読む。他 peer の
  値を自分の代用にできるのは quota pool の共有が確認できている場合だけで、
  engine 名が同じことは共有の証拠にならない。フィールドの読み方(absent は
  unknown、snapshot は peer の最終 turn 時点、`resets_at` 通過後は stale)は
  `list_agents` の tool description が正本。
