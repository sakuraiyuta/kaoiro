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
| `thread.started` | `session_init` — envelope の `session_id` を `thread_id` で更新 | model / cwd は event に載らない。明示 model は spawn 時の値、アカウント既定は各 turn の rollout `turn_context.payload.model` から解決して wrapper が `ext` に stamp する（既定値を次 turn の明示指定には昇格させない） |
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

アカウント既定 model の rollout 解決は、前 turn の `turn_context` を今回値と
誤認しうる `turn.started` では確定せず、`turn.completed` 後に background
refresh する。
terminal state と次 turn 受付は filesystem retry でブロックしない。未解決の turn
では前 turn の account-default model を保持せず `model` / `model_source` を省略し、
dashboard の「確認待ち」と `whoami` の field omit を同じ unknown 状態として扱う。
後段 retry が解決した場合は generation guard で新しい turn を上書きしないことを
確認してから、現在 state を再 stamp する。解決値は表示 metadata であり、次 turn
の `ThreadOptions.model` へ pin しない。

### 権限 (承認フローは存在しない)

`codex exec` は harness override で `approval_policy=never` を強制し (`-c approval_policy=...` も無効)、JSON event stream に承認要求 event は存在しない。したがって:

- Codex agent の権限は **spawn 時の二軸で固定** ([ADR-0033](../adr/0033-permission-model-dual-axis.md) F3): `ext.permission = { sandbox: <spawn 時選択>, approval: "never" }` を wrapper が stamp する。
- `waiting_permission` 状態・`pending_permission` ext・`permission_decision` envelope は Codex では発生しない。
- sandbox 外への escalation が必要なコマンドは自動拒否され、失敗として model に返る (model は sandbox 内で代替手段を試みる)。
- upstream の exec 承認対応 (feature flag `exec_permission_approvals`、開発中) は [open-questions/codex-exec-approval-upstream](../open-questions/codex-exec-approval-upstream.md) で追跡。

### session / thread の resume と列挙

- 保管: 初回 `thread.started` で得た `thread_id` (UUIDv7) を kaoiro の `session_id` として保持し、`AgentStates` / `SessionPointers` ([ADR-0014](../adr/0014-session-resume-and-restore.md)) に書き込む。
- 復帰: 復元指示時に `codex.resumeThread(thread_id)` で再開。
- 列挙: `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl` を固定深度の日付 tree として新しい順に async 走査し、先頭行 `session_meta` の `cwd` フィールドで照合する (実ファイルで確認済み)。存在確認は一致時点で早期 return し、spawn / resume / `switch_session` の hot path で runner event loop を block しない (#100)。`~/.codex/state_5.sqlite` の index は internal のため依存しない。

### 実機検証メモ (2026-07-11、ChatGPT-plan 認証)

dashboard から Codex agent (kuroe / ao) を実起動して判明し、実装に反映した 3 点:

- **model カタログはアカウント既定のみ (旧、phase-16 で更新)**:
  ChatGPT-plan 認証では明示 `model` 指定が全て 400/404 で拒否され
  (bundled catalog は API キー向け)、許容 model はアカウント依存で SDK
  からは列挙不能。kaoiro は Codex の model カタログを空にし、`model` を
  送らずアカウント既定を使う ([ADR-0032](../adr/0032-codex-adapter.md) F4bc)。 →
  **phase-16 update (2026-07-13、[ADR-0035](../adr/0035-codex-model-catalog-and-mid-session-switch.md))**:
  operator が `runner.config.json` に `codex.chatgpt_plan` を申告する経路で
  catalog を復活し、Plus 以上では Sol / Terra / Luna を LaunchDialog に
  出し、session 途中の switch も受け付ける (mid-session switch の envelope
  契約は [protocol](protocol.md) の `ext.pending_model` / `ext.effective` /
  `ext.switch_error` 参照、Codex 側の catalog 詳細は
  [codex-model-catalog](codex-model-catalog.md))。
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

### session_capabilities の advertise タイミング (2026-07-11、[ADR-0034](../adr/0034-session-capabilities-advertisement.md) F1、phase-15)

`ext.session_capabilities` は **`thread.started` を待たず、spawn 直後の初回
state_change から stamp する** (ADR-0034 F1)。理由は本仕様の process モデル
に起因する:

- `codex exec` は毎ターン新規 spawn する process モデルのため、`thread.started`
  は **初ターン発生まで到達しない**。CodexHost の run loop は queue が空の間
  `#wake` を待って idle 状態でスリープしており、この間 `thread.started` は絶対
  に発火しない。
- 未 stamp 時 UI は fail-closed で「機能なし」解釈 (attach ボタン disabled、
  質問 dialog 系「未対応」表示)。session_init 相当を待つと起動直後の Codex
  agent が「未対応」誤表示になる。
- 対策: adapter 構築時に capability (Codex は `supports_attachments: false` /
  `supports_user_input_dialog: true`) を組み立て、初回 state_change (idle
  announce、cli.ts で発行) の `ext` に stamp する。以降の state_change でも
  同 ext を維持し、変化しうる値は変化時に更新する (Claude 側と対称)。

phase-15 の 15-4b/4c の楽観 stamp 原則と同一 path。
`supports_model_switch` / `supports_effort_switch` は phase-16 で実装済
(2026-07-13 host verify)。`session_capabilities` の枠内で
adapter が catalog resolver 出力に応じて advertise を都度更新する
([ADR-0035](../adr/0035-codex-model-catalog-and-mid-session-switch.md) F4、
[plugin-model](plugin-model.md))。

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
