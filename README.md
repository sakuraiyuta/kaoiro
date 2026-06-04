# kaoiro(顔色)

複数の CLI AI エージェント(Claude Code など)の**状態と進捗を監視し、
キャラクターとして可視化する**システム。

文字ベースの CLI エージェントは、いま何をしているか・誰が手待ちなのかを
把握しづらく、親しみも湧きにくい。kaoiro はエージェントを「顔色」で見せ、
複数同時運用時の状況把握と愛着の両方を狙う。

## ステータス

企画・設計フェーズ(Phase 0)。本リポジトリはまずドキュメントを先行させ、
そこから実装へ繋ぐ。

## 全体像

3層構成:

- **ラッパー(Wrapper)** — エージェントを起動し、入出力を仲介。Claude Code は
  公式の **Claude Agent SDK** をホストして観測・制御・権限ルーティングを行い、
  エージェント固有の出力を共通イベント形式へ翻訳する。プラグインで拡張する。
- **サーバ(Server)** — 複数のラッパーを集約し、状態を保持してクライアントへ
  realtime 配信。指示を該当エージェントへルーティングする。
- **クライアント(Client)** — 各エージェントの状態をキャラ絵・表情で可視化する
  Web フロント。

## 技術スタック

- **ラッパー: TypeScript + Claude Agent SDK**(`@anthropic-ai/claude-agent-sdk`)
  - 各エージェントと同居してローカル動作。観測+制御+権限承認を SDK 1経路で。
- **サーバ: Elixir / OTP + Phoenix**
  - WebSocket(Phoenix Channels)で各ラッパーを集約
  - 1 接続(エージェント)= 1 GenServer で最新状態を保持、Supervisor 配下で監視
  - PubSub で fan-out、クライアントへ realtime 配信
- **クライアント: Web フロント(TypeScript)**(描画は静的差分 — `docs/adr/0004-client-rendering-staged.md`)

## 当面の対象

Claude Code を最初の対象とする。他エージェント(Codex 等)は将来、
**アダプタ・プラグイン**として追加する(`docs/specs/plugin-model.md`)。

## ドキュメント

構造化ドキュメントは [docs/](docs/) を参照。

| 入口 | 内容 |
|---|---|
| [docs/specs/overview.md](docs/specs/overview.md) | kaoiro とは(目的・2ゴール・対象) |
| [docs/specs/architecture.md](docs/specs/architecture.md) | 3層構成・データフロー |
| [docs/specs/protocol.md](docs/specs/protocol.md) | 共通イベント・エンベロープ/状態機械 |
| [docs/plans/](docs/plans/) | フェーズ別計画とステータス |
| [docs/open-questions/](docs/open-questions/) | 未決事項 |
| [docs/adr/](docs/adr/) | 決定記録(ADR) |

## 現在のゴール

Phase 1: **ラッパー1個 + 状態機械のみ**。Agent SDK のメッセージ列から状態を
確実に導出できるかの検証を最優先とする
([docs/plans/phase-1-wrapper-state-machine.md](docs/plans/phase-1-wrapper-state-machine.md))。
