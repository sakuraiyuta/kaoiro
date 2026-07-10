---
title: Codex アダプタ追加と wrapper マルチパッケージ構造の materialise
status: accepted
date: 2026-07-10
opened: 2026-06-26
supersedes: []
superseded_by: null
related_specs: [plugin-model, protocol, architecture, personas, codex-sdk-events, agent-sdk-events]
related_adrs: [17, 22, 23, 33]
---

# ADR-0032 — Codex アダプタ追加と wrapper マルチパッケージ構造の materialise

## Status

Accepted (実装は [phase-13-wrapper-multipackage-restructure](../plans/phase-13-wrapper-multipackage-restructure.md) → [phase-14-codex-adapter](../plans/phase-14-codex-adapter.md) の 2 段階)。

## Context

wrapper は現在 `@kaoiro/wrapper` 単一パッケージで `@anthropic-ai/claude-agent-sdk` を直接 import する Claude 専用の実装 (`wrapper/src/host.ts:7`)。ここに OpenAI の Codex CLI (`@openai/codex-sdk` 0.144.1、Node ≥ 18) を第二エンジンとして追加したい。

エンジン追加の受け皿は既に 3 つ揃っていた:

- [ADR-0017](0017-wrapper-multientity-packages.md) が `wrapper/core` + AI エージェント共通層 + 具体アダプタの 3 層 pnpm ワークスペース化を Accepted で planning 済 (「主要機能が出揃ってから」と着手延期)。
- [ADR-0023](0023-host-runner-architecture.md) D3 が「`@kaoiro/wrapper` のリネームは codex 版追加時まで先送り」と明記。
- open-questions/spawn-engine-selection (2026-06-26 opened、本 ADR に完全マージし削除) が `SpawnRequest`/`SpawnMessage` に `engine` 追加、runner launcher の engine → wrapper 解決、LaunchDialog の engine セレクト、model/effort/persona の engine 依存、の配線チェックリストを既に整備していた。本 ADR はその決定を実行に移す。

一方 phase-12 まで進み ADR-0017 の延期条件「主要機能が出揃ってから」は満たされた (dashboard / persona pack / permission broker / subagent タスク / runner 全て稼働)。Codex 追加が発生した本タイミングが 3 層再編・リネーム・engine セレクト配線を一括で行う自然な窓。

Codex SDK の Claude Agent SDK との対応 (2026-07 時点、`@openai/codex-sdk` 0.144.1 / `@anthropic-ai/claude-agent-sdk` 0.3.162):

| 概念 | Claude Agent SDK | Codex SDK |
|---|---|---|
| メイン API | `query()` async generator (常駐 session) | `Codex().startThread()` → `thread.run()` / `thread.runStreamed()` (**毎ターン `codex exec` を新規 spawn**、2 ターン目以降は `exec resume <id>`) |
| Resume | `resume: sessionId` | `codex.resumeThread(id)` |
| 権限 | `permissionMode` 単軸 (default/acceptEdits/bypassPermissions/plan/dontAsk/auto) | `sandbox_mode` × `approval_policy` 二軸。ただし exec 経由は approval_policy が `never` に強制され、**caller へ承認要求を返す経路なし** ([ADR-0033](0033-permission-model-dual-axis.md) Context) |
| Model | `claude-*` | `gpt-5.6-sol` (既定) / `terra` / `luna` / `gpt-5.5` / `gpt-5.4(-mini)` 等 (カタログは server 側で更新、列挙 API なし) |
| 認証 | `ANTHROPIC_API_KEY` / Claude subscription | `CODEX_API_KEY` env / ChatGPT login (`~/.codex/auth.json`)。`OPENAI_API_KEY` は 0.144 では実行時認証に使われない (login への pipe 専用) |
| System prompt 相当 | `systemPrompt.append` | config `developer_instructions` (developer role メッセージとして append、実証済み) / AGENTS.md (append) |
| ツール | `tool()` + Zod, in-process MCP | **TS SDK に dynamicTools は無い**。外部 MCP server を config override (`mcp_servers.*`) で per-run 登録可 |
| Streaming | `SDKMessage` (system/assistant/result/stream_event) | `ThreadEvent` (thread.*/turn.*/item.*)、詳細は [codex-sdk-events](../specs/codex-sdk-events.md) |
| Hooks | PreToolUse / CwdChanged 等 | v0.116 で hooks 導入 (exec/SDK 面には未露出) |

(2026-07-10 追記: 上表は `@openai/codex-sdk` 0.144.1 の型定義・実装・同梱バイナリ、および upstream `rust-v0.144.1` ソースで検証済み。起草時の想定から dynamicTools 不在・承認フロー不可の 2 点が覆り、F5/F6 を改訂した。)

## Decision

### F1 — wrapper を 4 パッケージに分割 (ADR-0017 materialise)

wrapper ディレクトリを pnpm ワークスペース化し、次の 4 パッケージに分ける:

- **`wrapper/core` (`@kaoiro/wrapper-core`)** — エンティティ非依存。transport / エンベロープ外枠+version / 同一性・persona / 接続・状態報告ライフサイクル / config / CLI 枠 (`cli.ts` のエンジン非依存部分)。
- **`wrapper/agent-common` (`@kaoiro/agent-common`)** — AI エージェント共通層。状態機械 (`state.ts`)、`EngineAdapter` interface、共通 Tool 記述層 (F5)、permission broker、instruction 変換、共通イベント型。Claude / Codex が共有。
- **`wrapper/claude-code` (`@kaoiro/claude-code`)** — Claude Code CLI 具体アダプタ。既存の `wrapper/src/host.ts` / `wrapper/src/adapter.ts` を移植・改名。Claude 独自機能 (fast mode / CwdChanged hook / native AskUserQuestion / permission 単軸 → 二軸写像 table) はここに閉じる。
- **`wrapper/codex` (`@kaoiro/codex`)** — Codex 具体アダプタ (新設)。

現 `@kaoiro/wrapper` の名称は `@kaoiro/claude-code` にリネームする ([ADR-0023](0023-host-runner-architecture.md) D3 の宣言実行)。既存の `wrapper/src/adapter.ts` が事実上のエンジン境界を先取りしているため、これを `wrapper/agent-common` の `EngineAdapter` interface として昇格させ、Claude 実装は Claude アダプタパッケージに移す。

### F2 — 権限モデル共通抽象を二軸へ拡張

[ADR-0033](0033-permission-model-dual-axis.md) で確定。`state_change.ext.pending_permission` に `sandbox` (read-only/workspace-write/danger-full-access) と `approval` (untrusted/on-request/granular/never) の 2 フィールドを追加。UI (LaunchDialog / AgentDetail) も二軸表示。Claude 4 mode → 二軸への写像 table は `wrapper/claude-code` アダプタが保持。詳細は ADR-0033。

### F3 — persona は engine 非依存で共有

`personality.md` と 立ち絵 (7 状態表情) を両 engine で共有する。Claude では従来通り SDK `systemPrompt.append` に注入 ([ADR-0026](0026-persona-personality-injection.md) 経由 [ADR-0029](0029-persona-server-sot-and-pack-distribution.md))、Codex では config key **`developer_instructions`** に渡す (2026-07-10 確定: developer role メッセージとして base instructions に append される実挙動を rollout ファイルで実証。base instructions を**置換**してしまう `instructions` / `model_instructions_file` は使わない)。engine 別 persona pack (`kuroe-claude` / `kuroe-codex` 等) や `personality.md` 内の engine 別セクションは初回では持たない。

なお Codex には built-in の `personality` config (none/friendly/pragmatic、exec 既定 pragmatic) があり persona 口調と干渉し得る。Q1 検証時に `none` 指定の要否を確認する。

Codex 側 injection の実効性 (口調・態度の再現度) は未検証のため [open-questions/codex-personality-injection-efficacy](../open-questions/codex-personality-injection-efficacy.md) で追跡する。

### F4a — capabilities フィールド値

runner の register payload、`SpawnRequest.engine`、`SpawnMessage.engine`、LaunchDialog の engine セレクトで使う値集合を確定する:

- `claude-code` — Claude Code CLI アダプタ
- `codex` — Codex CLI アダプタ

現状 register payload に載っている `capabilities: ["claude"]` は `claude-code` にリネームする (実消費 UI がまだ無いため低コスト)。互換窓 (2026-07-10 確定、旧 Q6 close): 旧値 `claude` は **1 リリース窓**の間 server 側 register handler で `claude-code` にサイレント正規化し deprecation warn を出す。次リリースで正規化 case を撤去し厳格 reject に切り替える ([ADR-0031](0031-runner-persona-trust-mode.md) の persona legacy 窓と同じ流儀)。

### F4bc — EngineCapability interface

`wrapper/agent-common` に次の interface を置く:

```ts
interface EngineCapability {
  // engine 一意識別子。capabilities フィールドと同値
  id: "claude-code" | "codex";
  // 起動可能なモデル一覧 (dashboard の三段選択用)
  supportedModels(): ModelInfo[];
  // effort オプション (fast mode / reasoning_effort 等の engine 固有 tuning)
  effortOptions?(): EffortInfo[];
}
```

envelope の `ext.model` / `ext.effort` は engine 語彙のまま (mapping しない)。LaunchDialog は「engine → model → optional effort」の三段選択で構成する。

Codex 側の初期実装 (2026-07-10 確定、旧 Q5 close):

- **`supportedModels()` は curated 静的リスト** — Codex に model 列挙 API が無い
  (0.144 で hardcoded preset は撤去され server 更新の catalog に移行、公開
  endpoint なし) ため。初期カタログは bundled catalog 準拠で `gpt-5.6-sol`
  (既定) / `gpt-5.6-terra` / `gpt-5.6-luna` / `gpt-5.5` / `gpt-5.4-mini`。
  改廃は wrapper 更新で追従する。
- **effort は Claude 側と同じ `ext.models` の `effort_levels` に統合** (E-B)。
  値は per-model: 5.6 系 = `low/medium/high/xhigh/max` (+ sol/terra は
  `ultra`)、5.5/5.4 系 = `low/medium/high/xhigh`。未指定 = model 既定。
  意味論差 (Claude fast mode vs Codex reasoning_effort) は「engine 内での
  相対深度」として共通型で吸収し、UI ラベルは engine adapter が返す。

### F5 — 共通 Tool 記述層は MCP bridge で Codex へ届ける (2026-07-10 改訂)

`wrapper/agent-common` に「JSON Schema (definition) + handler 関数」の pair を SSOT として置く点は不変。輸送路を改訂する:

- **Claude アダプタ** — Zod 変換 + `createSdkMcpServer` で in-process 登録 (従来どおり)。
- **Codex アダプタ** — 起草時に想定した `dynamicTools` は **TS SDK に存在しない**ことが判明したため、`@kaoiro/codex` に小さな **stdio MCP bridge** 実行体を同梱する。wrapper は spawn 毎に config override (`mcp_servers.kaoiro.command` + `env`、実バイナリで受理検証済み) で bridge を登録し、bridge は env で渡された unix socket 経由で親 wrapper プロセスへ接続、tool 呼び出しを wrapper 側の共通 handler に転送する。`codex exec` はターンごとの process なので bridge もターンごとに codex が spawn し、都度 socket へ再接続する。

現在 Claude SDK 内で提供している inter-agent tools (`mcp__kaoiro__send_to_agent` / `list_agents` / `whoami`、`wrapper/src/inter_agent.ts`) は本共通層に移植し、両 engine に単一の実装で提供する。

初稿で rejected とした「Codex は別 process MCP server 経由」は、その前提 (dynamicTools が SDK にある) が崩れたため bridge 形態で採用する。ただし初稿が忌避した「tool 実装の二重化」は発生しない — bridge は転送のみで、handler 本体は agent-common の SSOT のままである。将来 SDK に dynamicTools が入れば bridge を外して直結できる (handler SSOT は流用)。

### F6 — AskUserQuestion 相当

Claude は SDK native tool を継続利用 (現行 `wrapper/src/host.ts:762-765` の特別分岐は `wrapper/claude-code` 側に維持)。Codex は F5 の MCP bridge 経由で `ask_user_question` を提供する。MCP tool 呼び出しは応答までターンをブロックするため、Codex でも `waiting_question` 状態が成立する ([ADR-0033](0033-permission-model-dual-axis.md) で承認フローが落ちた分、operator との対話チャネルとして重要)。両者の tool 呼び出しを wrapper が共通 `question_request` envelope へ正規化する ([ADR-0027](0027-askuserquestion-envelope.md) と整合、schema 変更なし)。

### F7 — 認証は現行踏襲

Codex の認証は wrapper プロセスが親環境から読む (2026-07-10 実挙動確認で経路を修正):

- ChatGPT login セッション — `codex login` が `~/.codex/auth.json` にキャッシュ、親 home 継承で自然に見える。本プロジェクトの一次経路。
- `CODEX_API_KEY` — operator が親 shell に export (env が auth.json より優先)。なお `OPENAI_API_KEY` は 0.144 では実行時認証に**使われない** (`codex login --with-api-key` への pipe 入力にのみ使う慣習名)。

runner の RunnerConfig、runner が spawn 時に書く config JSON (`/tmp/kaoiro-runner-*/`)、いずれにも一切埋めない。既存 Claude 側と同じ扱いで、SIGKILL 時の temp file leak リスクを回避する。

### F8 — resume の engine 分離

session_id は engine-opaque な文字列として server 側の `SessionPointers` は保持のみを続ける ([ADR-0014](0014-session-resume-and-restore.md) スキーマ不変)。engine adapter が自分の session_id を解釈し resume する:

- Claude adapter — 既存 SDK `resume: sessionId`
- Codex adapter — `codex.resumeThread(id)`

runner の cwd 配下 session 列挙 ([ADR-0014](0014-session-resume-and-restore.md) F6) も engine 別実装:

- Claude adapter — 既存 `~/.claude/projects/` JSONL 列挙
- Codex adapter — `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl` を走査し、先頭行 `session_meta` の `cwd` で照合する (2026-07-10 確定: レイアウトと `session_meta.cwd` の存在を実ファイルで確認。`state_5.sqlite` の index は internal 扱いのため依存しない)。

### F9 — cwd 通知契約

`wrapper/agent-common` の `EngineAdapter` interface に `onCwdChanged(newCwd)` 相当の hook 契約を持たせる。実装は engine 側都合:

- Claude adapter — 既存 CwdChanged hook 継続 ([issue #95](https://gitea.example.invalid/sakurai.yuta/kaoiro/issues/95) の SDK バグ待ちで実動不安定)。
- Codex adapter — MVP では未実装、暫定的に起動 cwd 固定表示。抽出方式候補は [open-questions/codex-cwd-extraction](../open-questions/codex-cwd-extraction.md) で追跡。

### F10 — 2 phase 分割

実装は次の 2 phase に分ける:

- **[phase-13-wrapper-multipackage-restructure](../plans/phase-13-wrapper-multipackage-restructure.md)** — 本 ADR F1 のみを materialise。既存 Claude 動作を完全維持 (Codex 実装ゼロ、境界のみ整備)。
- **[phase-14-codex-adapter](../plans/phase-14-codex-adapter.md)** — F2-F9 全実装。[ADR-0033](0033-permission-model-dual-axis.md) の schema 変更、共通 Tool 記述層構築、Codex アダプタ実装、runner launcher の engine 解決、dashboard の engine セレクト有効化と model/effort 三段選択、capabilities リネーム。open-questions Q1-Q5 の解決を伴う。

## Consequences

### Positive

- ADR-0017 の 3 層構造が物理境界として実現。`wrapper/core` は AI 概念を持たず、将来の非 AI エンティティ ([plugin-model](../specs/plugin-model.md)) 追加時のパッケージ受け皿ができる。
- engine 追加時のインパクトが adapter パッケージ内に閉じ、共通層と core を再手術しなくて済む。
- Codex adapter が既存の状態抽象 / envelope schema / server / dashboard の変更なしにプラグイン (二軸 permission 拡張は独立の [ADR-0033](0033-permission-model-dual-axis.md) で扱う)。
- capabilities フィールドが実消費される (LaunchDialog の engine セレクト、runner launcher の解決)。

### Negative

- パッケージ再編 (phase-13) は既存挙動不変で PR 単位は大きくなる (import 経路と package 名の全面移動)。
- Codex adapter の実装項目が広い (F2-F9)。phase-14 の acceptance は代表 persona × 主要機能の実挙動確認まで含める。
- Codex 側 persona injection の実効性が未検証 (Q1)。phase-14 完了判定に Q1 解決が含まれる。

### Neutral

- 現状の `wrapper/src/adapter.ts` が事実上の adapter interface を先取りしていたため、EngineAdapter interface への昇格コストは小さい。
- 配布 ([ADR-0018](0018-runner-distribution.md)) は複数 wrapper バンドル方式を issue #70 で扱う既存論点で、本 ADR で新規論点は増えない。

## Alternatives Considered

### F1 (エンジン抽象の粒度)

| Option | Why rejected |
|--------|--------------|
| 現 wrapper 内に AgentAdapter interface のみ切り、パッケージ分割は延期 | AI 共通層 (permission broker / state machine / instruction) の Claude 依存が実質そのまま残り、Codex の権限二軸などが `state.ts` に染み込みやすい。後で 3 層に剥がす時に再手術。ADR-0017 の延期条件は既に満たされている |
| 別 PoC リポで codex 単体先行 | 本流の抽象を回避、取り込み時に二重実装コスト |

### F2 (権限モデル抽象)

| Option | Why rejected |
|--------|--------------|
| 行為プリセット共通抽象 (`default/accept-edits/auto-shell/plan-only/yolo` 等) | Codex 二軸の表現力を単軸に潰し、意味論マッピング table が結局 open-question の巣になる |
| engine 別語彙をそのまま UI に露出 | dashboard の permission 表示が engine ごとに違う集合になり、envelope schema / server validation が engine 分岐だらけ |

### F3 (persona 共有)

| Option | Why rejected |
|--------|--------------|
| `personality.md` に `## for-claude` / `## for-codex` セクション | 早期合意コスト大、pack 作成者運用複雑化 |
| engine 別 pack (`kuroe-claude` / `kuroe-codex`) | pack zip 数が engine 分だけ倍増、maintenance 破綻 |

### F4a (capabilities 命名)

| Option | Why rejected |
|--------|--------------|
| `anthropic-claude-code` / `openai-codex` の vendor prefix | 冗長、operator 目視性低下、同一 vendor 内複数 engine は当面ない |
| 現状値 `claude` 据え置き | claude は Anthropic LLM モデル族とも読めるため意味軸重 |

### F4bc (model / effort 抽象)

| Option | Why rejected |
|--------|--------------|
| tuning 抽象 (`speed / balanced / deep-reasoning`) | fast mode と reasoning_effort の写像不能、テーブルが open-question の巣 |
| engine 別推奨プリセット | プリセット定義 maintenance コスト + SDK 追従負担 |

### F5 (MCP 提供)

| Option | Why rejected |
|--------|--------------|
| Codex SDK の dynamicTools に直接渡す (初稿の採用案) | **前提が崩れた** — TS SDK 0.144.1 に dynamicTools は存在しない (2026-07-10 型定義・実装で確認)。SDK 追加を待つ選択も時期不明で、bridge 資産は直結化後も handler SSOT ごと流用できるため待つ利益が薄い |
| engine 別 tool 実装並置 | tool 追加時に必ず二箇所触る、divergence 発生確定 |
| Codex はツール無しで MVP | Codex agent が質問も inter-agent 対話もできず engine 非対称。承認フローが落ちた分 ask_user_question が対話の生命線であり許容不能 |

### F6 (AskUserQuestion)

| Option | Why rejected |
|--------|--------------|
| 両 engine とも自前提供 (Claude native も捨てる) | Claude SDK 更新恩恵喪失 |
| Codex は AskUserQuestion 未対応 | operator への質問不可で Codex agent の改訂能力低下 |

### F7 (認証)

| Option | Why rejected |
|--------|--------------|
| runner が engine 別 credentials 保管 | runner config が secret 保管庫化、複数ホスト運用複雑化 |
| config JSON 埋め込み | SIGKILL 時 rmSync 前 leak リスク |

### F8 (resume 分離)

| Option | Why rejected |
|--------|--------------|
| session_id に engine prefix | 既存 session_id migration が全 client に必要、prefix 意味論を全経路に浸透 |
| Codex は resume 未対応 | ADR-0014 復旧体験が engine 非対称 |

### F9 (cwd hook)

| Option | Why rejected |
|--------|--------------|
| cwd を Claude 独自機能として wrapper/claude-code に封入 | UI 分岐増 |
| cwd 追跡機能を仕様から削除 | Claude 側動作凍結の合理性なし |

### F10 (phase 分割)

| Option | Why rejected |
|--------|--------------|
| 1 phase 一括 | 単一 PR 肥大化、再編と codex 実装の regression が同時進行してリスク集中 |
| 3+ phase 細分割 | F2-F9 の phase 境界が曖昧化、レビュー回数増 |

## Related

- 由来: open-questions/spawn-engine-selection (2026-06-26 opened、本 ADR に完全マージし削除、「解決時のアクション」チェックリストは [phase-14-codex-adapter](../plans/phase-14-codex-adapter.md) の acceptance criteria に転記)。
- 実装: [phase-13-wrapper-multipackage-restructure](../plans/phase-13-wrapper-multipackage-restructure.md)、[phase-14-codex-adapter](../plans/phase-14-codex-adapter.md)。
- 関連 ADR: [0017](0017-wrapper-multientity-packages.md) (本 ADR で materialise)、[0022](0022-pending-permission-authoritative-source.md) / [0033](0033-permission-model-dual-axis.md) (権限二軸)、[0023](0023-host-runner-architecture.md) D3 (リネーム実行)、[0001](0001-agent-sdk-integration.md) (Claude SDK 採用)、[0027](0027-askuserquestion-envelope.md) (question envelope)、[0014](0014-session-resume-and-restore.md) (resume)。
- 関連 specs: [plugin-model](../specs/plugin-model.md)、[protocol](../specs/protocol.md)、[architecture](../specs/architecture.md)、[personas](../specs/personas.md)、[agent-sdk-events](../specs/agent-sdk-events.md) (Claude 版)、[codex-sdk-events](../specs/codex-sdk-events.md) (Codex 版、新設)。
- Open questions (phase-14 期): [Q1 codex-personality-injection-efficacy](../open-questions/codex-personality-injection-efficacy.md)、[Q4 codex-cwd-extraction](../open-questions/codex-cwd-extraction.md)、[codex-exec-approval-upstream](../open-questions/codex-exec-approval-upstream.md) (2026-07-10 新設)。旧 Q2 (envelope schema) / Q3 (UI 語彙) / Q5 (model カタログ) / Q6 (互換窓) は 2026-07-10 の実 SDK 検証 + spec-elicitation で解決し close (決定内容は本 ADR と [ADR-0033](0033-permission-model-dual-axis.md) に追補済み)。
