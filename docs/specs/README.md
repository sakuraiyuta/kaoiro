# Specs

機能仕様(トピック別)。各ファイルは `status` と `related` の frontmatter を持つ。

## Files

| Slug | Status | 説明 |
|------|--------|------|
| [overview](overview.md) | accepted | kaoiro の目的・2ゴール・対象 |
| [architecture](architecture.md) | accepted | 3層構成とデータフロー |
| [plugin-model](plugin-model.md) | accepted | アダプタ/フィルタ2拡張点と共通境界 |
| [protocol](protocol.md) | accepted | 共通イベント・エンベロープ/状態機械/ペルソナ/双方向・認証 |
| [protocol-inter-agent](protocol-inter-agent.md) | provisional | エージェント間メッセージング envelope schema・9 種 kind・ハード制限 |
| [protocol-external-human](protocol-external-human.md) | provisional | 外部人間メッセージング(Discord)・一方向 authority・discord-wrapper・Tier A/B |
| [agent-sdk-events](agent-sdk-events.md) | accepted | Agent SDK の確定イベント仕様と状態導出 |
| [subagent-tasks](subagent-tasks.md) | provisional | subagent/workflow タスクの検知と専用 envelope 通知 |
| [file-upload](file-upload.md) | provisional | ダッシュボードからの添付(画像/テキスト/PDF/Office)を wrapper で SDK へ render |
| [personas](personas.md) | accepted | ペルソナ立ち絵のデザイン方針・画像規格・生成ワークフロー |
| [persona-personality-injection](persona-personality-injection.md) | provisional | 口調・一人称等の人格プロンプトを Claude Agent SDK に注入する仕組み |
| [threat-model](threat-model.md) | accepted | 双方向ルーティングの脅威と緩和策 |
| [auth-and-authz](auth-and-authz.md) | accepted | 各ノードの認証・認可境界の現状マップ。OSS 公開前監査 (#91) の起点 |
| [setup-wizards](setup-wizards.md) | provisional | 設定 / env 生成ウィザード(wrapper config・server .env) |
| [non-goals](non-goals.md) | accepted | 非スコープ |
| [glossary](glossary.md) | accepted | 用語集 |

## Status legend

- **accepted** — 確定、実装はこれに従う
- **provisional** — 暫定、`../open-questions/` に未決あり
- **deferred** — 後フェーズへ先送り

## Conventions

- slug 名は小文字ハイフン、1トピック1ファイル、≤200 行
- 図は Mermaid(ASCII アート不可)、相互参照は相対パス
