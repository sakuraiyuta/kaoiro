---
title: Codex アダプタ — Codex SDK イベント仕様
description: TypeScript 版 @openai/codex-sdk の実イベント/コールバック仕様と、kaoiro 状態への導出マッピング。agent-sdk-events (Claude 版) と対をなす。
status: provisional
related: [protocol, plugin-model, architecture, agent-sdk-events, codex-personality-injection-efficacy]
---
<!-- markdownlint-disable MD033 -->

# Codex アダプタ — Codex SDK イベント仕様

## Purpose

Codex アダプタ ([plugin-model](plugin-model.md)) が依拠する TypeScript 版 Codex SDK (`@openai/codex-sdk` 0.144.1) の**実イベント/コールバック仕様**を確定し、kaoiro の状態 ([protocol](protocol.md)) への導出を定義する。[agent-sdk-events](agent-sdk-events.md) の Claude 版と対をなす spec で、共通 `AdapterEvent` に変換される。

**Status: provisional** — 実装フェーズ ([phase-14-codex-adapter](../plans/phase-14-codex-adapter.md)) で具体挙動を確認しながら本 spec を accepted に昇格する。特に thread event の実データ構造、model / effort の SDK 側取得可否、system prompt 相当 API は phase-14 実装時に検証。

## Definition

### メイン API

```typescript
import { Codex } from "@openai/codex-sdk";

const codex = new Codex();
const thread = codex.startThread();          // or codex.resumeThread(id)
const { events } = await thread.runStreamed(prompt);
for await (const ev of events) {
  // ev.type: thread.started | turn.started | item.started
  //        | item.completed | turn.completed | turn.failed
}
```

- **`Codex().startThread()`** — 新規会話を開始。`thread.id` (例 `thr_xxx`) が返る。
- **`codex.resumeThread(id)`** — 既存 thread の再開。`session_id` opaque 値 ([ADR-0014](../adr/0014-session-resume-and-restore.md)) として wrapper が保管したものを渡す。
- **`thread.run(prompt)`** — 単発実行、`turn.finalResponse` / `turn.items` を返す。
- **`thread.runStreamed(prompt)`** — `AsyncIterable<ThreadEvent>` を返す streaming API。kaoiro は原則こちらを使う。

### ThreadEvent の変種

Codex SDK は次の `ThreadEvent` を stream で yield する:

| type | 意味 | 主なフィールド |
|---|---|---|
| `thread.started` | thread 起動通知 | thread_id, model, sandbox, approval, cwd |
| `turn.started` | ユーザ prompt から新しい turn 開始 | prompt |
| `item.started` | 1 item の開始 (assistant message / tool call / file change 等) | item_id, item_type |
| `item.completed` | 1 item の完了 | item_id, item_type, item (派生型別本体) |
| `turn.completed` | turn 完了 | usage (tokens 情報) |
| `turn.failed` | turn 失敗 | error_reason |

item の派生型:

- `assistant_message` — text
- `command_execution` — shell コマンド実行
- `file_change` — file 編集 (path, old, new)
- `mcp_tool_call` — 外部 MCP tool 呼び出し
- `dynamic_tool_call` — wrapper が提供した `dynamicTools` の呼び出し ([ADR-0032](../adr/0032-codex-adapter.md) F5 の共通 Tool 記述層経由)

**注記**: 上記フィールド名は Codex SDK ドキュメントに基づく初期スケッチであり、実データ構造は phase-14 実装時に確認する。差異が判明したら本 spec を更新する。

### 状態導出

Codex ThreadEvent → kaoiro 状態 ([protocol](protocol.md)) への導出は共通の `AdapterEvent` を経由する ([plugin-model](plugin-model.md)):

| ThreadEvent | kaoiro 状態 | 補足 |
|---|---|---|
| `thread.started` | `session_init` — envelope の `session_id` 更新、`ext.cwd` 起動値、`ext.model` 初期化 | Claude の SDKSystemMessage(init) 相当 |
| `turn.started` | `thinking` | Claude の user message 送信直後相当 |
| `item.started` (item_type=assistant_message) | `thinking` | 出力開始 |
| `item.completed` (item_type=assistant_message) | `log` (kind=assistant, text) を送出 | protocol の log envelope |
| `item.started` (item_type=command_execution) | `tool_running` | permission 二軸 ([ADR-0033](../adr/0033-permission-model-dual-axis.md)) で承認された shell |
| `item.completed` (item_type=command_execution) | `log` (kind=tool_result, tool_name=shell, output) | |
| `item.started` (item_type=file_change) | `tool_running` | edit tool |
| `item.completed` (item_type=file_change) | `log` (kind=tool_result, tool_name=edit) | |
| `item.started` (item_type=dynamic_tool_call) の `ask_user_question` | `waiting_question` — `question_request` envelope ([ADR-0027](../adr/0027-askuserquestion-envelope.md)) を発行 | Codex は native AskUserQuestion を持たないため wrapper 提供 tool 経由 ([ADR-0032](../adr/0032-codex-adapter.md) F6) |
| `item.started` (item_type=dynamic_tool_call) の `mcp__kaoiro__*` | `tool_running` | inter-agent tool、共通 Tool 記述層 ([ADR-0032](../adr/0032-codex-adapter.md) F5) 経由 |
| `turn.completed` | `idle` — envelope の `type=result` を発行 (usage を `ext.cost` に反映) | Claude の SDKResultMessage(subtype=success) 相当 |
| `turn.failed` | `error` — `state_change(error)` を発行 | Claude の SDKResultMessage(subtype=error_*) 相当 |

### 権限 (approval callback)

Codex SDK の approval flow は sandbox × approval 二軸 ([ADR-0033](../adr/0033-permission-model-dual-axis.md)) で表現される。permission 待ちの UI 表現と envelope 出力:

- `approval_policy = on-request` のとき、SDK は operator への approval コールバックを発行する。
- wrapper (Codex adapter) はこれを受け、`state_change(waiting_permission)` + `state_change.ext.pending_permission` (sandbox / approval / tool_name / input / request_id / ts) を server へ送る。
- operator の承認 / 拒否は `permission_decision` envelope として wrapper へ届き、Codex SDK の approval Promise を resolve / reject する。

**注記**: Codex SDK の approval コールバック名・型は phase-14 実装時に確認 (SDK ドキュメントの記述は概略のみ)。

### session / thread の resume

- 保管: 初回 `thread.started` で得た `thread_id` (`thr_xxx`) を kaoiro の `session_id` として保持し、`AgentStates` / `SessionPointers` ([ADR-0014](../adr/0014-session-resume-and-restore.md)) に書き込む。
- 復帰: 復元指示時 (client の restore、runner の enumerate-sessions) に `codex.resumeThread(thread_id)` で再開。
- 列挙: runner の cwd 配下 session 列挙は `~/.codex/threads/` 相当のローカルストア または Codex App Server の `thread/turns/list` 相当で行う (実装方式は phase-14 で確定)。

### tool 定義 (dynamicTools)

`wrapper/agent-common` の共通 Tool 記述層 (JSON Schema + handler) を Codex 側では `dynamicTools` として `thread.run()` / `runStreamed()` に渡す ([ADR-0032](../adr/0032-codex-adapter.md) F5):

```typescript
await thread.runStreamed(prompt, {
  dynamicTools: [
    {
      name: "mcp__kaoiro__send_to_agent",
      description: "...",
      inputSchema: { type: "object", properties: { ... } },
      handler: async (input) => { ... },
    },
    {
      name: "ask_user_question",
      description: "...",
      inputSchema: { type: "object", properties: { ... } },
      handler: async (input) => { ... },
    },
    ...
  ],
});
```

Claude adapter は同じ (name, description, inputSchema, handler) を Zod schema + `createSdkMcpServer` に写像する。SSOT は wrapper/agent-common の共通 Tool 記述層。

### system prompt 相当 (persona personality 注入)

Codex SDK が Claude Agent SDK の `systemPrompt.append` に相当する API を持つかは phase-14 実装時に確認する ([codex-personality-injection-efficacy](../open-questions/codex-personality-injection-efficacy.md))。候補:

- `thread.run(prompt, { instructions: "..." })` オプション
- Codex CLI の `~/.codex/prompts/` に置く
- prompt に prefix として毎回結合

[personas](personas.md) の `personality.md` はそのまま両 engine で共有 ([ADR-0032](../adr/0032-codex-adapter.md) F3)。

## Constraints

- **MUST**: `session_id` は Codex thread ID (`thr_xxx`) をそのまま使い、独自 prefix を付けない ([ADR-0032](../adr/0032-codex-adapter.md) F8)。
- **MUST**: `state_change.ext.pending_permission` に `sandbox` / `approval` を載せる ([ADR-0033](../adr/0033-permission-model-dual-axis.md))。
- **MUST NOT**: OPENAI_API_KEY / ChatGPT login 情報を config JSON / envelope / log に書き出さない ([ADR-0032](../adr/0032-codex-adapter.md) F7)。
- **SHOULD**: cwd 追跡は best-effort ([codex-cwd-extraction](../open-questions/codex-cwd-extraction.md))、MVP は起動 cwd 固定表示で可。

## See Also

- Related specs: [protocol](protocol.md)、[plugin-model](plugin-model.md)、[architecture](architecture.md)、[agent-sdk-events](agent-sdk-events.md) (Claude 版と対)
- ADR: [ADR-0032](../adr/0032-codex-adapter.md) (Codex アダプタ導入)、[ADR-0033](../adr/0033-permission-model-dual-axis.md) (権限二軸)
- Open questions: [codex-personality-injection-efficacy](../open-questions/codex-personality-injection-efficacy.md)、[codex-cwd-extraction](../open-questions/codex-cwd-extraction.md)、[codex-model-effort-catalog](../open-questions/codex-model-effort-catalog.md)
- Plan: [phase-14-codex-adapter](../plans/phase-14-codex-adapter.md)
