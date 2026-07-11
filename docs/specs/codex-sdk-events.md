---
title: Codex アダプタ — Codex SDK イベント仕様
description: TypeScript 版 @openai/codex-sdk の実イベント/コールバック仕様と、kaoiro 状態への導出マッピング。agent-sdk-events (Claude 版) と対をなす。
status: accepted
related: [protocol, plugin-model, architecture, agent-sdk-events]
---
<!-- markdownlint-disable MD033 -->

# Codex アダプタ — Codex SDK イベント仕様

## Purpose

Codex アダプタ ([plugin-model](plugin-model.md)) が依拠する TypeScript 版 Codex SDK (`@openai/codex-sdk` 0.144.1) の**実イベント/コールバック仕様**を確定し、kaoiro の状態 ([protocol](protocol.md)) への導出を定義する。[agent-sdk-events](agent-sdk-events.md) の Claude 版と対をなす spec で、共通 `AdapterEvent` に変換される。

**Status: accepted** — 型定義・SDK 実装・同梱バイナリ・upstream `rust-v0.144.1` ソースの検証 (2026-07-10) に加え、2026-07-11 に ChatGPT-plan 認証で dashboard から実ターンを通し確認して accepted に昇格。実機検証で確定した 3 点を下記「実機検証メモ」に記録する。

## Definition

### メイン API と process モデル

```typescript
import { Codex } from "@openai/codex-sdk";

const codex = new Codex({ config: { developer_instructions: "..." } });
const thread = codex.startThread({ sandboxMode: "workspace-write" });
const { events } = await thread.runStreamed(prompt);
for await (const ev of events) {
  // ev.type: thread.started | turn.started | item.started | item.updated
  //        | item.completed | turn.completed | turn.failed | error
}
```

- **process モデル (重要)**: SDK は常駐 session を持たない。`thread.run()` / `thread.runStreamed()` の**呼び出しごとに `codex exec --experimental-json` サブプロセスを新規 spawn** し、2 ターン目以降は `codex exec resume <thread_id>` で再開する。stdin は prompt 書き込み直後に close される — **実行中に caller から入力を返す経路は存在しない** (承認・追加入力とも不可)。ターン中断は `TurnOptions.signal` (AbortSignal) で process kill。
- **`Codex(options)`** — `codexPathOverride` / `baseUrl` / `apiKey` (env `CODEX_API_KEY` として注入) / `config` (任意の `--config key=value` override、毎 run 付与) / `env`。
- **`codex.startThread(threadOptions)`** — `model` / `sandboxMode` / `workingDirectory` / `skipGitRepoCheck` / `modelReasoningEffort` / `networkAccessEnabled` / `webSearchMode` / `approvalPolicy` (exec では無効、後述) / `additionalDirectories`。
- **`codex.resumeThread(id, threadOptions)`** — 既存 thread の再開。`session_id` opaque 値 ([ADR-0014](../adr/0014-session-resume-and-restore.md)) として wrapper が保管した UUID を渡す。
- **`thread.id`** — 初回 `thread.started` 後に populate される UUIDv7 文字列 (例 `019f4bdb-d821-7631-aee1-ec7982060311`)。

### ThreadEvent の変種 (0.144.1 実型)

| type | 意味 | 主なフィールド |
|---|---|---|
| `thread.started` | thread 起動通知 | `thread_id` のみ (model / sandbox / cwd は**載らない**) |
| `turn.started` | turn 開始 | (なし) |
| `item.started` | 1 item の開始 | `item` (ThreadItem、初期状態 in_progress) |
| `item.updated` | item の更新 | `item` |
| `item.completed` | item の完了 | `item` |
| `turn.completed` | turn 完了 | `usage` (input/cached_input/output/reasoning_output tokens。**USD コストは無い**) |
| `turn.failed` | turn 失敗 | `error.message` |
| `error` | stream 上の致命エラー | `message` |

ThreadItem の派生型 (`item.type`):

- `agent_message` — text (model の発話)
- `reasoning` — text (要約された思考)
- `command_execution` — command / aggregated_output / exit_code / status
- `file_change` — changes[] (path, kind=add|delete|update) / status
- `mcp_tool_call` — server / tool / arguments / result? / error? / status
- `web_search` — query
- `todo_list` — items[] (text, completed)
- `error` — message (非致命 item)

**注記**: 起草時に想定した `dynamic_tool_call` item は存在しない。kaoiro の tool 呼び出しはすべて `mcp_tool_call` (server="kaoiro") として観測される ([ADR-0032](../adr/0032-codex-adapter.md) F5 の MCP bridge 経由)。

### 状態導出

Codex ThreadEvent → kaoiro 状態 ([protocol](protocol.md)) への導出は共通の `AdapterEvent` を経由する ([plugin-model](plugin-model.md)):

| ThreadEvent | kaoiro 状態 | 補足 |
|---|---|---|
| `thread.started` | `session_init` — envelope の `session_id` を `thread_id` で更新 | model / cwd は event に載らないため spawn 時の値を wrapper が自前で `ext` に stamp する |
| `turn.started` | `thinking` | Claude の user message 送信直後相当 |
| `item.started` (agent_message / reasoning) | `thinking` | 出力開始 |
| `item.completed` (agent_message) | `log` (kind=assistant, text) を送出 | protocol の log envelope |
| `item.started` (command_execution) | `tool_running` | sandbox 内実行 (承認は発生しない、[ADR-0033](../adr/0033-permission-model-dual-axis.md) F3) |
| `item.completed` (command_execution) | `log` (kind=tool_result, tool_name=shell, output=aggregated_output) | |
| `item.started` (file_change) | `tool_running` | patch 適用 |
| `item.completed` (file_change) | `log` (kind=tool_result, tool_name=edit) | |
| `item.started` (mcp_tool_call, server=kaoiro, tool=ask_user_question) | `waiting_question` — `question_request` envelope ([ADR-0027](../adr/0027-askuserquestion-envelope.md)) は bridge → wrapper handler 側で発行 | MCP 応答までターンがブロックするため成立 |
| `item.started` (mcp_tool_call, server=kaoiro, tool=send_to_agent 等) | `tool_running` | inter-agent tool、共通 Tool 記述層経由 |
| `item.started` (mcp_tool_call, 他 server) / (web_search) | `tool_running` | |
| `item.completed` (todo_list / reasoning) | 状態影響なし | log 化は任意 (MVP では見送り) |
| `item.completed` (error item) | 状態影響なし・`log` 相当で記録 | 非致命 |
| `turn.completed` | `idle` — envelope の `type=result` を発行。usage (tokens) を `ext` に反映 — USD が無いため `ext.cost` は Codex では**載せない** | Claude の SDKResultMessage(success) 相当 |
| `turn.failed` / `error` | `error` — `state_change(error)` を発行 | Claude の SDKResultMessage(error_*) 相当 |

### 権限 (承認フローは存在しない)

`codex exec` は harness override で `approval_policy=never` を強制し (`-c approval_policy=...` も無効)、JSON event stream に承認要求 event は存在しない。したがって:

- Codex agent の権限は **spawn 時の二軸で固定** ([ADR-0033](../adr/0033-permission-model-dual-axis.md) F3): `ext.permission = { sandbox: <spawn 時選択>, approval: "never" }` を wrapper が stamp する。
- `waiting_permission` 状態・`pending_permission` ext・`permission_decision` envelope は Codex では発生しない。
- sandbox 外への escalation が必要なコマンドは自動拒否され、失敗として model に返る (model は sandbox 内で代替手段を試みる)。
- upstream の exec 承認対応 (feature flag `exec_permission_approvals`、開発中) は [open-questions/codex-exec-approval-upstream](../open-questions/codex-exec-approval-upstream.md) で追跡。

### session / thread の resume と列挙

- 保管: 初回 `thread.started` で得た `thread_id` (UUIDv7) を kaoiro の `session_id` として保持し、`AgentStates` / `SessionPointers` ([ADR-0014](../adr/0014-session-resume-and-restore.md)) に書き込む。
- 復帰: 復元指示時に `codex.resumeThread(thread_id)` で再開。
- 列挙: `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl` を走査し、先頭行 `session_meta` の `cwd` フィールドで照合する (実ファイルで確認済み)。`~/.codex/state_5.sqlite` の index は internal のため依存しない。

### 実機検証メモ (2026-07-11、ChatGPT-plan 認証)

dashboard から Codex agent (kuroe / ao) を実起動して判明し、実装に反映した 3 点:

- **model カタログはアカウント既定のみ**: ChatGPT-plan 認証では明示 `model`
  指定が全て 400/404 で拒否され (bundled catalog は API キー向け)、許容 model
  はアカウント依存で SDK からは列挙不能。kaoiro は Codex の model カタログを
  空にし、`model` を送らずアカウント既定を使う ([ADR-0032](../adr/0032-codex-adapter.md) F4bc)。
- **MCP tool は自動承認が必要**: `codex exec` の approval_policy=never 下で MCP
  tool 呼び出しは既定で「user cancelled MCP tool call」になる。
  `mcp_servers.kaoiro.default_tools_approval_mode: "approve"` で kaoiro ツール
  のみ自動承認する ([ADR-0032](../adr/0032-codex-adapter.md) F5)。
- **waiting_question の envelope 順序**: Codex adapter は `setPendingQuestion`
  で同期的に `state_change(waiting_question)` を emit するため、`QuestionBroker`
  は `question_request` 通知を `onPendingChange` より**先**に送る。そうしないと
  ext 無しの `question_request` が dashboard の描画状態を上書きし、質問ダイアログ
  が出ず engine バッジも消える (Claude は `setPendingQuestion` がスタンプのみで
  state_change は別途出すため無影響)。
- **persona 注入の実効性**: kuroe (「マスター」呼び・秘書口調) と ao
  (一人称「わたし」・常体・簡潔) が明確に差別化され、`developer_instructions`
  注入がペルソナ別に忠実に効くことを確認 (旧 Q1 close)。built-in `personality`
  config との干渉は観測されず `none` 指定は不要だった。

### tool 定義 (MCP bridge)

`wrapper/agent-common` の共通 Tool 記述層 (JSON Schema + handler) を Codex 側では `@kaoiro/codex` 同梱の stdio MCP bridge で提供する ([ADR-0032](../adr/0032-codex-adapter.md) F5):

```typescript
const codex = new Codex({
  config: {
    developer_instructions: personalityPrompt,
    mcp_servers: {
      kaoiro: {
        command: process.execPath,
        args: [bridgeScriptPath],
        env: { KAOIRO_BRIDGE_SOCKET: socketPath },
      },
    },
  },
});
```

- bridge は codex がターンごとに spawn する stdio MCP server。env の unix socket 経由で親 wrapper に接続し、tool 呼び出し (`ask_user_question` / `mcp__kaoiro__send_to_agent` / `list_agents` / `whoami`) を wrapper 側の共通 handler へ転送する。
- Claude adapter は同じ (name, description, inputSchema, handler) を Zod schema + `createSdkMcpServer` に写像する。SSOT は wrapper/agent-common の共通 Tool 記述層。

### system prompt 相当 (persona personality 注入)

config key `developer_instructions` を使う ([ADR-0032](../adr/0032-codex-adapter.md) F3、2026-07-10 実証):

- developer role メッセージとして base instructions に **append** される (rollout ファイルで確認)。
- `instructions` / `model_instructions_file` は base instructions を**置換**するため使わない (upstream も strongly discouraged)。
- AGENTS.md (cwd / `$CODEX_HOME`) も append 系だが、ユーザの作業リポジトリを汚すため kaoiro では使わない。
- built-in `personality` config (none/friendly/pragmatic、exec 既定 pragmatic) との干渉は 2026-07-11 実機検証で観測されず (上記「実機検証メモ」)。

[personas](personas.md) の `personality.md` はそのまま両 engine で共有 ([ADR-0032](../adr/0032-codex-adapter.md) F3)。

## Constraints

- **MUST**: `session_id` は Codex thread ID (UUIDv7) をそのまま使い、独自 prefix を付けない ([ADR-0032](../adr/0032-codex-adapter.md) F8)。
- **MUST**: `ext.permission = {sandbox, approval}` を spawn 時に stamp し、approval は `never` 固定 ([ADR-0033](../adr/0033-permission-model-dual-axis.md))。
- **MUST NOT**: `CODEX_API_KEY` / ChatGPT login 情報を config JSON / envelope / log に書き出さない ([ADR-0032](../adr/0032-codex-adapter.md) F7)。
- **MUST NOT**: base instructions を置換する `instructions` / `model_instructions_file` を使わない。
- **SHOULD**: cwd 追跡は best-effort ([codex-cwd-extraction](../open-questions/codex-cwd-extraction.md))、MVP は起動 cwd 固定表示で可。

## See Also

- Related specs: [protocol](protocol.md)、[plugin-model](plugin-model.md)、[architecture](architecture.md)、[agent-sdk-events](agent-sdk-events.md) (Claude 版と対)
- ADR: [ADR-0032](../adr/0032-codex-adapter.md) (Codex アダプタ導入)、[ADR-0033](../adr/0033-permission-model-dual-axis.md) (権限二軸)
- Open questions: [codex-cwd-extraction](../open-questions/codex-cwd-extraction.md)、[codex-exec-approval-upstream](../open-questions/codex-exec-approval-upstream.md)
- Plan: [phase-14-codex-adapter](../plans/phase-14-codex-adapter.md)
