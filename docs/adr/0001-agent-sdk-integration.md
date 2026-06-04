---
title: Claude Agent SDK を統合方式に採用
status: accepted
date: 2026-06-04
opened: 2026-06-04
supersedes: []
superseded_by: null
related_specs: [architecture, plugin-model, protocol, agent-sdk-events]
related_adrs: [2]
---

# ADR-0001 — Claude Agent SDK を統合方式に採用

## Status

Accepted

## Context

CLI エージェント(Claude Code)を観測・制御する手段が問題だった。端末出力を
PTY スクレイプするのは TUI エスケープで脆い。CLI ヘッドレス
(`claude -p --output-format stream-json`)は観測はできるが one-shot で、実行中
セッションへの指示注入(穴1)と権限承認の外部ルーティングが弱い。観測・制御・
権限を1機構で扱える surface が必要だった。

## Decision

ラッパーは公式 **Claude Agent SDK**(TypeScript: `@anthropic-ai/
claude-agent-sdk`)をホストする。

- 観測: 型付きメッセージ列(`SystemMessage`/`AssistantMessage`/`ResultMessage`)
  から状態を導出。
- 制御(穴1): セッション resume / ストリーミング入力で多ターン制御。
- 権限: `PreToolUse` フック / `canUseTool` コールバックで承認を保留し、外部 UI へ
  回す。

## Consequences

### Positive

- 観測・制御・権限ルーティングが1つのインプロセス機構に統合、PTY 不要。
- 穴1(指示注入)が同一機構で解決。
- 型安全で、権限承認をクライアント UI へ回せる。

### Negative

- ラッパーは Python/TS に限定(Elixir 不可)。サーバ(Elixir)と2言語構成になる。
- SDK の細部(ストリーミング入力 / `Query.interrupt()` / `canUseTool` 戻り値)は
  **確定済み**([agent-sdk-events](../specs/agent-sdk-events.md)、2026-06 検証)。

### Neutral

- クライアントも TS のため、ラッパー+クライアントが同言語になる。

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
| CLI stream-json | one-shot。権限は MCP ツール経由のみで外部 UI 連携が弱い |
| PTY スクレイプ | TUI エスケープで脆く、パースが不安定 |
| Elixir で CLI を port 起動 | in-process の権限コールバック/多ターン注入が使えない |
