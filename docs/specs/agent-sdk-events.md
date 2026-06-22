---
title: Claude Code アダプタ — Agent SDK イベント仕様
description: TypeScript 版 Claude Agent SDK の実メッセージ/コールバック仕様と、kaoiro 状態への導出マッピング(検証済み)。
status: accepted
related: [protocol, plugin-model, architecture, subagent-tasks]
---
<!-- markdownlint-disable MD033 -->

# Claude Code アダプタ — Agent SDK イベント仕様

## Purpose

Claude Code アダプタ([plugin-model](plugin-model.md))が依拠する TypeScript 版
Claude Agent SDK(`@anthropic-ai/claude-agent-sdk`)の**実メッセージ/コール
バック仕様**を確定し、kaoiro の状態([protocol](protocol.md))への導出を定義
する。公式ドキュメント(code.claude.com / platform.claude.com)で検証済み
(2026-06)。

## Definition

### メッセージ列(query() / Query)

`query()` は `Query`(= `AsyncGenerator<SDKMessage, void>`)を返し、以下を逐次
yield する。

```typescript
type SDKMessage =
  | SDKAssistantMessage         // type: 'assistant'
  | SDKUserMessage              // type: 'user'(tool_result を含む)
  | SDKUserMessageReplay
  | SDKResultMessage            // type: 'result'
  | SDKSystemMessage            // type: 'system', subtype: 'init'
  | SDKPartialAssistantMessage  // type: 'stream_event'(部分更新)
  | SDKCompactBoundaryMessage;
```

| 変種 | type / subtype | 主なフィールド |
|---|---|---|
| SDKSystemMessage | system / init | session_id, model, tools[], cwd, permissionMode, mcp_servers, slash_commands |
| SDKAssistantMessage | assistant | message(APIAssistantMessage: content に text/thinking/tool_use), parent_tool_use_id, error? |
| SDKUserMessage | user | message(APIUserMessage: tool_result を含む), parent_tool_use_id |
| SDKPartialAssistantMessage | stream_event | event(RawMessageStreamEvent) — `includePartialMessages: true` のみ |
| SDKResultMessage | result | subtype, is_error, num_turns, total_cost_usd, usage, duration_ms, result(成功)/ errors(失敗) |

`SDKResultMessage.subtype`: `success` | `error_max_turns` |
`error_during_execution` | `error_max_budget_usd` |
`error_max_structured_output_retries`。

ツール結果は独立メッセージではなく **`SDKUserMessage`(content の tool_result
ブロック)** として返る。

### タスク(subagent/workflow)メッセージ

親セッションは Task ツールで起動した subagent / ローカル workflow のライフサイクルを
`type:"system"` の追加 subtype で yield する。kaoiro はこれを subagent/workflow 通知へ
導出する([subagent-tasks](subagent-tasks.md)、
[ADR-0019](../adr/0019-subagent-workflow-entity-and-task-envelope.md))。

| subtype | 主なフィールド |
|---|---|
| task_started | task_id, description, subagent_type, task_type, workflow_name, tool_use_id, skip_transcript |
| task_progress | subagent_type, usage{total_tokens,tool_uses,duration_ms}, last_tool_name, summary |
| task_notification | status(completed/failed/stopped), summary, usage |

これらは `KaoiroState` には**載らない**(親の状態を変えない)。専用 envelope へ別経路で
導出する。現状 `wrapper/src/adapter.ts` は未処理(破棄)。

### 権限コールバック(canUseTool)

```typescript
type CanUseTool = (
  toolName: string,
  input: ToolInput,
  options: { signal: AbortSignal; suggestions?: PermissionUpdate[] }
) => Promise<PermissionResult>;

type PermissionResult =
  | { behavior: 'allow'; updatedInput: ToolInput; updatedPermissions?: PermissionUpdate[] }
  | { behavior: 'deny';  message: string; interrupt?: boolean };
```

`permissionMode: 'default'` のとき、ルール/モードで決まらないツールについて
`canUseTool` が呼ばれる。kaoiro はここで Promise を保留し、クライアント UI の
許可/拒否を待って `behavior` を返す = `waiting_permission` の駆動点。

評価順: PreToolUse Hook → Deny → Allow → Ask → Permission Mode →
canUseTool → PostToolUse。

> **検証メモ(2026-06, SDK 0.3.162, ヘッドレス実走行)**: 当初の実測では
> 試した全構成で `canUseTool` が発火しなかったが、**追実験(2026-06-11、
> issue #1)で ask 経路の発火を確認**した。確定した挙動:
>
> - SDK は `canUseTool` 指定時、CLI へ常に `--permission-prompt-tool
>   stdio` を渡す(sdk.mjs 実測)。経路自体は壊れていない。
> - ツール呼び出しは ask に到達する**前に**、手前のゲートで自動解決
>   され得る: `allowedTools` 許可、安全コマンド classifier、sandbox 内
>   操作の auto-allow(実測: `allowedTools: ["Read"]` でも Bash の
>   `echo` は canUseTool を経ずに実行)、および各種 auto-deny(deny は
>   `system`/`permission_denied` メッセージに `decision_reason_type`
>   付きで表面化)。
> - **ask へ昇格する操作で `canUseTool` が発火する**。実測の最小再現:
>   `permissionMode: "default"` + `settingSources: []` で Bash に
>   サンドボックス外への書き込み(`touch ~/...`)をさせると発火し、
>   deny の message が tool_result に反映される。
>
> **含意**: (1) ツール限定の一次防衛は引き続き `allowedTools`(ローカル
> 天井、[threat-model](threat-model.md))。(2) `waiting_permission` が
> 実駆動されるのは「自動解決できない危険・サンドボックス外操作」のとき
> であり、人間の承認が要る場面でだけ承認 UI(Phase 3)が動く — 設計
> 意図と一致。旧実測の不発火は、試行した操作が全て手前のゲートで解決
> されていたため。

#### 手動 verify 用コマンド(canUseTool 発火境界)

ダッシュボード経由で broker → 許可ダイアログ → クライアント承認の経路を
実機検証する時、SDK 内蔵の safe Bash classifier に阻まれずに `canUseTool`
へ届かせるコマンドが必要。実測した境界(2026-06-22, #59 verify 時):

| 例 | 経路 |
|---|---|
| `hostname` / `echo X` / `[ -f X ] && echo Y` | classifier の safe 判定 → auto-approve |
| `mkdir -p /tmp/...` | sandbox 内扱い → auto-approve |
| `for f in ...; do ...; done` | 制御構文で静的解析できず → ask → `canUseTool` 発火 |
| `curl --version` | network 系コマンド名 → ask → `canUseTool` 発火 |

副作用ゼロで最も安定して発火させるなら **`curl --version`**(実通信なし、
出力サイズ小、毎回成功)。なお `settingSources` 既定値では SDK は
`~/.claude/settings.json` を読まないため、ユーザ側 settings の allow リスト
や PreToolUse hook(`approve-compound-bash.sh` 等)は wrapper 経由 SDK
セッションには適用されない — 上記の境界はあくまで SDK 内蔵 classifier
によるもの。

### 制御(穴1 の確定)

- 多ターン制御: `query()` の prompt に `AsyncIterable<SDKUserMessage>` を渡す
  **ストリーミング入力モード**で、実行中セッションへ追加メッセージを送れる。
- 割り込み: `Query.interrupt(): Promise<void>`。
- モード変更: `Query.setPermissionMode(mode)`。
- 観測(メッセージ列)と制御(入力 + interrupt + canUseTool)が**同一の Query で
  完結**する(別機構不要)。
  [ADR-0001](../adr/0001-agent-sdk-integration.md) の「細部は実装時に確定」を
  ここで確定。

`PermissionMode`: `default` | `acceptEdits` | `bypassPermissions` | `plan`
(環境により `dontAsk` / `auto` も)。

### 利用するフック(任意・補助)

`PreToolUse` / `PostToolUse` / `Notification` / `UserPromptSubmit` / `Stop` /
`SubagentStop` / `SessionStart` / `SessionEnd` / `PreCompact`。状態導出は主に
メッセージ列 + `canUseTool` で足り、フックは補助。

### 状態導出マッピング

| kaoiro 状態 | 導出トリガ(SDK) |
|---|---|
| `idle` | `SDKSystemMessage`(init)受信、次の入力待ち前 |
| `sending` | SDK 外。ラッパーが operator 指示を入力キューへ受理した時点(rest 状態のみ)。最初の `SDKAssistantMessage` で thinking/tool_running へ抜ける(#32) |
| `thinking` | `SDKAssistantMessage` の content が text/thinking のみ。細粒度は `stream_event`(`includePartialMessages`) |
| `tool_running` | `SDKAssistantMessage` に tool_use 出現 〜 対応する `SDKUserMessage`(tool_result)まで |
| `waiting_permission` | `canUseTool` 呼び出し中(Promise 保留) |
| `waiting_input` | `SDKResultMessage` 後、ストリーミング入力で次メッセージ待ち |
| `done` | `SDKResultMessage` subtype `success`(瞬間 → `waiting_input`) |
| `error` | `SDKResultMessage` subtype `error_*` / is_error、または `SDKAssistantMessage.error` |
| `disconnected` | SDK 外(ラッパー↔サーバ接続断、サーバ側導出) |

`system/task_*`(subagent/workflow)は `KaoiroState` に**マップしない** — 親状態を
変えず、専用 envelope へ別途導出する([subagent-tasks](subagent-tasks.md))。

## Constraints

- SHOULD: 細粒度の `thinking` 検出が要るとき `includePartialMessages: true`。
- MUST: `waiting_permission` は `canUseTool` の Promise 保留で表現し、UI 応答で
  解決する。

## Open Questions

なし。共通エンベロープの type/payload 設計は
[ADR-0010](../adr/0010-protocol-precisification.md) で確定済み。

## See Also

- 関連 specs: [protocol](protocol.md), [plugin-model](plugin-model.md),
  [architecture](architecture.md), [subagent-tasks](subagent-tasks.md)
- ADRs: [0001](../adr/0001-agent-sdk-integration.md),
  [0019](../adr/0019-subagent-workflow-entity-and-task-envelope.md)
- 出典: code.claude.com/docs/en/agent-sdk/typescript ほか(2026-06 検証)
