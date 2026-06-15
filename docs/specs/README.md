# Specs

機能仕様(トピック別)。各ファイルは `status` と `related` の frontmatter を持つ。

## Files

| Slug | Status | 説明 |
|------|--------|------|
| [overview](overview.md) | accepted | kaoiro の目的・2ゴール・対象 |
| [architecture](architecture.md) | accepted | 3層構成とデータフロー |
| [plugin-model](plugin-model.md) | accepted | アダプタ/フィルタ2拡張点と共通境界 |
| [protocol](protocol.md) | accepted | 共通イベント・エンベロープ/状態機械/ペルソナ/双方向・認証 |
| [agent-sdk-events](agent-sdk-events.md) | accepted | Agent SDK の確定イベント仕様と状態導出 |
| [personas](personas.md) | accepted | ペルソナ立ち絵のデザイン方針・画像規格・生成ワークフロー |
| [threat-model](threat-model.md) | accepted | 双方向ルーティングの脅威と緩和策 |
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
