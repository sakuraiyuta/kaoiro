---
title: Claude モデル catalog live 経路の SDK 実測一元化と launch bootstrap の default floor 縮小
status: accepted
date: 2026-07-14
opened: 2026-07-14
supersedes: []
superseded_by: null
related_specs: [plugin-model, protocol]
related_adrs: [32, 34, 35]
---

# ADR-0037 — Claude モデル catalog live 経路の SDK 実測一元化と launch bootstrap の default floor 縮小

## Status

Accepted (2026-07-14、マスター決裁)。実装は
[phase-18-claude-model-catalog-live](../plans/phase-18-claude-model-catalog-live.md)。

## Context

`wrapper/claude-code/src/catalog.ts` の `BOOTSTRAP` 定数は、
`@anthropic-ai/claude-agent-sdk` の `supportedModels()` を 2026-07-13 に
撮影した静的スナップショットである (SDK 0.3.187 相当、コメント記載)。
役割は次の 3 箇所で参照される Claude 側 catalog の initial 値:

- `runner/src/config.ts:288` — Register envelope の `engines[].models`。runner boot
  時に server (Elixir) へ engine 別 catalog を advertise する経路
- `wrapper/claude-code/src/host.ts:116` — presence 初期送信の `models` フィールド
- `wrapper/claude-code/src/host.ts:279` — `AgentHost.#models` の初期値。SDK init
  完了後、`#refreshSupportedModels()` (`host.ts:1231`) が SDK の実測結果で上書き

2026-07-14 現在、Anthropic は Claude Sonnet 5 (`claude-sonnet-5`) を含む
新モデル世代を出しているが、BOOTSTRAP snapshot は Sonnet 4.6 のままで追従して
いない。モデル追加のたびに BOOTSTRAP snapshot を手動更新する運用は現実的で
なくなった。

Phase 18-2 の実測 (SDK 0.3.208 での `query.supportedModels()` dump、2026-07-14)
で本 ADR の前提を追認した: (a) `value: "default"` の row は SDK 側で
`resolvedModel: "claude-opus-4-8[1m]"` (現時点の account 推奨モデル) に解決され、
「`default` alias は永久に腐らない」前提が成立、(b) 実測配列に `sonnet[1m]` と
`claude-opus-4-7` が既に存在せず、`sonnet` は `claude-sonnet-5` に解決 —
BOOTSTRAP snapshot の drift が実データで確認された。

一方で「BOOTSTRAP 完全廃止」には構造的な障害がある: BOOTSTRAP は次の 2 経路で
効いており、両者を一律に扱えない。

| 経路 | 対応する call site | SDK 実測可能か |
|---|---|---|
| **(i) register 経路** | `runner/src/config.ts:288` → `server/assets/src/lib/LaunchDialog.svelte` | **原理的に不可能** — host 接続時点で wrapper プロセスも SDK Query も存在しない。catalog を得るために spawn したいが、spawn の前に catalog が要る (鶏と卵) |
| **(ii) ext.models 経路** | `wrapper/claude-code/src/host.ts:116, 279` → `server/assets/src/lib/AgentDetail.svelte` | **可能** — init 後 `#refreshSupportedModels()` が実測に置換 |

(i) は wrapper プロセスがまだ生きていない状態のため、`supportedModels()` を
呼ぶ余地が構造的にない。この鶏と卵制約を受け入れつつ、保守負担を消す形を
決める必要がある。

同時に、codex 側 catalog (`wrapper/codex/src/catalog.ts`) は
[ADR-0035](0035-codex-model-catalog-and-mid-session-switch.md) F1 で
「catalog advertisement は runtime probe に依存しない」ことを確定判断済み。
`codex doctor --json` は auth mode までしか返さず、plan tier と entitled model
集合を返さないため、実測実装は技術的にも不可能。本 ADR の判断は Claude 側 catalog
に限定し、codex 側は退行させない。

## Decision

### F1 — BOOTSTRAP を `default` 1 エントリのみの最小 floor に縮小する

`wrapper/claude-code/src/catalog.ts` の `BOOTSTRAP` から `opus[1m]`、
`claude-fable-5[1m]`、`sonnet`、`sonnet[1m]`、`haiku`、`claude-opus-4-7` の全 6
エントリを削除し、`default` エントリのみを残す。腐るのは「全モデル列挙」部分で
あり、`default` alias は SDK 側の semantic として "account 推奨モデル" を指す
名前解決であるため永久に腐らない。

### F2 — Claude live 経路を SDK 実測に一元化する

`AgentHost.#models` の source of truth は SDK init 完了後の
`#refreshSupportedModels()` (`host.ts:1231-1249`) 結果を単一とする。init 前の
BOOTSTRAP は "loading 相当の floor" として扱い、init 完了後は必ず実測結果で
上書きされる契約とする。`state_change.ext.models` の advertise も同じ実測結果を
反映する。

### F3 — codex catalog は据え置き

[ADR-0035](0035-codex-model-catalog-and-mid-session-switch.md) F1 の確定判断
(operator plan 申告に基づく静的 catalog、runtime probe 非依存) を保持する。
`wrapper/codex/src/catalog.ts` および `resolveCodexCatalog` には手を入れない。
統一を理由に codex 側の実測実装を求めることはしない (技術的にも `codex doctor`
は entitled model を返さず不可能)。

### F4 — protocol schema は現状維持

`protocol/src/index.ts` の `EngineCatalogEntry.models` は現状通り
`EngineModelInfo[]` (配列・空可) のままとする。`models?` (optional) 化や
readiness フラグ追加は行わない。理由は次の 2 点:

1. codex 側の「意味ある空 catalog」 (unknown auth / no plan で `[]` を返す
   ADR-0035 F1) と、Claude 側の「未ロード」を混同させるフラグは fail-closed
   default を破壊する
2. `LaunchDialog.svelte:127` は既に空配列を許容している (`?? []`) ため、
   client 側の loading UI 追加も不要

### F5 — `default` エントリの `effort_levels` は FULL_EFFORT を仮出しする

縮小後の `default` エントリの `effort_levels` は現行同様
`["low", "medium", "high", "xhigh", "max"]` を仮出しする。init 前後で選択肢が
変わる UX ズレ (init 前 5 段階 → init 後は実測 default モデル次第で減る可能性)
は受容する trade-off とする。この判断は現行 fresh idle agent の effort switcher
供給源 (`AgentDetail.svelte:369` コメント) を壊さないための踏襲であり、恒久
最適解ではない。実装後の観察は
[claude-effort-levels-init-transition](../open-questions/claude-effort-levels-init-transition.md)
で追跡する。

### F6 — retry policy: 3 回自動 + toast 1 度 + silent + 手動ボタン常時

`#refreshSupportedModels()` の失敗時の回復設計を明示的に契約化する。現行は
silent fire-and-forget で `#modelsRequested = false` に戻すのみ (`host.ts:1247`)
のため、確実な再試行 trigger を欠く。次の 2 段構えとする:

1. **自動 bounded retry**: 次 turn 受信時に自動 retry を最大 **3 回**まで
   試行する。上限到達後は silent (バナー常時表示しない)
2. **手動 retry**: モデル switcher UI に「モデル一覧を再取得」ボタンを常時
   提供し、operator が明示的に trigger できる。ボタン trigger は上限を
   再カウントし直す
3. **通知**: 上限到達時に 1 度限り toast で失敗を通知 (dismissable)。以降の
   自動 retry 失敗では toast を出さない

具体的な UI 配置 (retry ボタンの位置、toast の見た目) は phase-18-3 の実装 PR で
確定する。

### F7 — SDK upgrade を先行 PR、以降に BOOTSTRAP 縮小 PR

`wrapper` package の `@anthropic-ai/claude-agent-sdk` は現在 0.3.162 が
インストールされている (`^0.3.162` 指定、lockfile 固定)。npm 最新は 0.3.208
相当。SDK upgrade PR を **先行** させ、`supportedModels()` の実測結果と
`model: "default"` の SDK 解決 semantic を検証する。この実測結果を根拠として
BOOTSTRAP 縮小 PR を後続で実施する。

同 PR での同時実施は避ける。理由は SDK upgrade に伴う挙動変化と BOOTSTRAP 縮小
の影響を切り分けるため。

### F8 — persist alias が SDK 実測に含まれない場合の fallback

session state / config 等に persist された `model` alias (例: `sonnet[1m]`)
が起動後の SDK 実測に含まれない場合、起動時検証で `default` に fallback し、
UI に通知 event を発行する。通知の粒度 (toast 1 度 / session log / 明示
ダイアログ) は phase-18-3 の実装 PR で確定する。

## Consequences

### Positive

- モデル追加 (Sonnet 5 等) のたびの BOOTSTRAP snapshot 手動更新が消える
- Claude live 経路の source of truth が SDK 実測に一元化され、account
  依存の解決 (plan / team / entitled model) が正確に反映される
- protocol schema / server / client / codex を触らない localized 改修に留まり、
  改修範囲が Claude wrapper 中心に閉じる
- `default` エントリという安全牌が保たれ、init 前後どちらでも "モデル選択が
  ゼロ" 状態にはならない

### Negative

- init 前に選んだ effort が init 後に選択肢から消える UX ズレを受容する
  (F5、[claude-effort-levels-init-transition](../open-questions/claude-effort-levels-init-transition.md))
- launch dialog では init 前は "Default" のみの提示となり、Sonnet 5 のような
  特定モデルを init 前に pre-select はできない。init 完了後の mid-session
  switch で選ぶ運用となる
- retry 実装の追加分だけ wrapper 側の複雑度が増す (F6)

### Neutral

- codex 側 catalog の挙動は変わらない (ADR-0035 F1 保持)
- protocol schema (`EngineCatalogEntry`) は不変で、後方互換は完全に保たれる
- BOOTSTRAP 縮小は SDK upgrade 前提 (F7)、Sonnet 5 対応は SDK 側の追従次第

## Alternatives Considered

| Option | Decision |
|--------|----------|
| BOOTSTRAP 完全廃止 + loading UI 全面導入 | Reject。(i) register 経路は SDK Query 未生成のため実測不能 (鶏と卵)、loading soft-lock リスク、`default` の effort_levels 供給源喪失、protocol / server / client / tests / docs の 7 レイヤ改修に発展 |
| 現状維持 (BOOTSTRAP snapshot を手動更新) | Reject。モデル追加のたびの手動更新が現実的でない (Sonnet 5 直後の破綻が実例) |
| `EngineCatalogEntry.models?` を optional 化 or readiness フラグ追加 | Reject。codex の「意味ある空」と Claude の「未ロード」を混同させ、fail-closed default を破壊する。`LaunchDialog.svelte:127` が既に空を許容しているため実質不要 |
| codex 側も含めて実測一元化 | Reject。ADR-0035 F1 の確定判断を退行させる。`codex doctor --json` は entitled model を返さず技術的にも不可能 |
| SDK upgrade と BOOTSTRAP 縮小を同 PR で実施 | Reject。挙動変化混在で影響切り分けが困難 |
| `default` エントリの effort_levels を空 (init 前 effort switcher 無効化) | Reject。init 前に効率設定できない不便、fresh idle agent の switcher 供給源が消える |
| `default` エントリの effort_levels を low/medium/high 3 段階固定 | Reject。init 前に xhigh/max を触れず、表現力の犠牲が大きい |
| retry 上限なし | Reject。SDK bug 発生時に無限呼び出しリスク |
| 失敗時バナー常時表示 | Reject。idle agent に過剰、誤解を招く |
| 失敗時完全 silent | Reject。user が壊れていることに気付かない |

## Implementation

[phase-18-claude-model-catalog-live](../plans/phase-18-claude-model-catalog-live.md)
で 3 phase (SDK upgrade + 実測検証 / wrapper 改修 / client UI 対応) に分けて
実装する。Phase 18-2 の実測 (2026-07-14) で `default` alias が
`claude-opus-4-8[1m]` に解決されることを確認済み (詳細は本 ADR の Context 節)。
