---
title: プラグインモデル
description: エージェント別アダプタと付加処理フィルタの2拡張点、および両者を差し込む共通イベント境界。
status: accepted
related: [architecture, protocol]
---
<!-- markdownlint-disable MD033 -->

# プラグインモデル

## Purpose

2種類の拡張点(アダプタ/フィルタ)と、両者を差し込む共通イベント境界を定義
する。全体構成は [architecture](architecture.md)。

## Definition

### 2種類の拡張点 — 分けて設計する

| 拡張点 | 役割 | 性質 |
|---|---|---|
| **アダプタ(エージェント別)** | 起動・制御、ネイティブ出力 → 共通イベント翻訳・状態導出、指示の逆変換 | プロセスのライフサイクルとプロトコル変換を持つ専用 IF。Claude Code 版は Agent SDK 実装([ADR-0001](../adr/0001-agent-sdk-integration.md)) |
| **フィルタ(付加処理)** | 正規化済み共通イベントに property を足す(感情・コスト・危険検知) | agent-agnostic、順序付きパイプライン |

- 「将来 Codex 等に対応」は**アダプタ**として差し込む
  → **2026-07-10 更新**: Codex アダプタは
  [ADR-0032](../adr/0032-codex-adapter.md) で実装対象化、
  [phase-14-codex-adapter](../plans/phase-14-codex-adapter.md) で実装。
- フィルタは共通イベントだけを相手にするので、どのエージェントでも同じフィルタ列を
  使い回せる。
- この分離が「コア=エージェント非依存」を成立させる肝。
- 付加プロパティの実例: `ext.cost`(累計コスト USD、#8、result に付与)と
  `ext.model` / `ext.context` / `ext.rate_limits`(Claude Code 固有メトリクス、
  #16、state_change に付与)。いずれもフィルタ列が未実装のため現状は Claude Code
  アダプタが直接付与する(SDK が公開した時のみの best-effort)。`model`/`context`/
  `rate_limits` は cc 固有のため、汎用フィルタではなくアダプタ側に置くのが妥当。
  汎用化できる `cost` 等はフィルタ機構の導入時に agent-agnostic なフィルタへ移す。
  - **`ext.context` の Codex 扱い** ([ADR-0040](../adr/0040-context-usage-capability.md)、phase-21): Codex adapter は `ext.context` を **stamp しない** (`turn.completed.usage.input_tokens` が per-turn 入力のみで context 使用率にならないため、estimated 投影も行わない)。代わりに `ext.session_capabilities.supports_context_usage=false` を明示 stamp し、UI は capability だけで「未対応」を判定する (engine 名分岐禁止、[ADR-0034](../adr/0034-session-capabilities-advertisement.md) F3)。Claude は同 field を `true` で stamp。

### 共通イベント境界

アダプタとフィルタを差し込む境界そのものが、共通イベント・エンベロープ
([protocol](protocol.md))。

```
[Agent native] --(Adapter: SDK→共通)--> [共通イベント v0]
  --(Filter chain)--> [Server(状態保持)] --> [Client]
```

### パッケージ構造とエンティティ拡張

アダプタ/コアの分離は、**pnpm ワークスペースの3層パッケージ**として物理境界化する
([ADR-0017](../adr/0017-wrapper-multientity-packages.md)、materialise は
[phase-13-wrapper-multipackage-restructure](../plans/phase-13-wrapper-multipackage-restructure.md)、
[ADR-0032](../adr/0032-codex-adapter.md) F1 で決定): エンティティ非依存コア
(`wrapper/core`)/ AI エージェント共通層 `wrapper/agent-common`
(状態機械・permission・instruction・`EngineAdapter` interface・
共通 Tool 記述層)/ 具体アダプタ(`wrapper/claude-code`・`wrapper/codex`・
将来 DB・ホストモニタ等)。状態機械・permission・instruction は
AI 固有でありコアに置かない。最終的には AI に限らず多様なエンティティの状態を
キャラクターとして可視化することを狙う(広い狙いは別途 vision で扱う)。

両 AI adapter の実効設定 projection は `agent-common` の
`EffectiveStatusSnapshot` を SoT とする。各 host は engine 固有 state から
`resolved: ResolvedSnapshotExt` と engine-neutral `permission` を一度だけ組み立て、
共通 helper が `state_change.ext` と read-only `whoami` の各 wire shape へ投影する。
adapter ごとに status field を二重実装して片方だけ欠落させないための境界であり、
未知 field は両経路とも omit する。

### EngineAdapter interface

AI エージェント共通層 `wrapper/agent-common` に置く `EngineAdapter` interface
([ADR-0032](../adr/0032-codex-adapter.md) F1, F4bc, F9)は、具体アダプタが
実装すべき契約を宣言する:

- 状態導出: engine 固有 event stream (Claude の `SDKMessage` /
  Codex の `ThreadEvent`) → 共通 `AdapterEvent` への変換
- 制御: `interrupt` / `setModel` / `applyFlagSettings` /
  `setPermissionMode` (Claude 側は SDK に委譲、Codex 側は relaunch 相当)
- 権限: `canUseTool` 相当のコールバックを permission broker へ橋渡し
- cwd 通知: `onCwdChanged(newCwd)` hook 契約 (実装は engine 都合)
- 能力申告: `supportedModels()` / `effortOptions?()` (`EngineCapability`)
- 共通 Tool 記述層 (JSON Schema + handler pair) の engine 別 API への変換
  (Claude: Zod + `createSdkMcpServer` in-process / Codex: `dynamicTools`)

### Session capability advertise (2026-07-11、[ADR-0034](../adr/0034-session-capabilities-advertisement.md))

engine 名では表現しきれない**session 単位の機能可用性** (auth mode / plan tier
/ wrapper 実装差) を UI に伝える経路。`EngineAdapter` interface には capability
取得 hook を**追加しない** — 各 adapter が state stamp 経路 (`#statusExt` 相当)
で直接 `ext.session_capabilities` を組み立て、envelope で advertise する
(ADR-0034 F4)。

- **理由**: capability は session-lifetime にわたる「静的な事実」ではなく、
  adapter 実装 + spawn 時選択 + auth mode の合成結果。adapter 内部で state と
  同期して組み立てる方が実態に近く、envelope が SoT ([ADR-0022](../adr/0022-pending-permission-authoritative-source.md) 原則)
  として一貫する。
- **stamp タイミング**: spawn 直後の**初回 state_change から** (session_init
  相当のイベントを待たない)。Codex は毎ターン `codex exec` を新規 spawn する
  process モデルで `thread.started` が初ターン発生まで遅延するため、session_init
  を待つと起動直後の Codex agent が fail-closed default で「機能なし」誤表示
  になる ([codex-sdk-events](codex-sdk-events.md))。Claude 側も対称に初回
  state_change から stamp。
- **UI 判定原則**: UI は engine 名 (`ext.engine`) では機能可用性を判定しない
  (レビュー禁則、[ADR-0034](../adr/0034-session-capabilities-advertisement.md)
  F3)。`ext.session_capabilities` の boolean / 条件配列のみを見る。
- **現在の advertise 値**:
  - `wrapper/claude-code`: `supports_attachments: true` / `supports_user_input_dialog: true` (無条件。`attachment_types` は省略 = 種類制限なし)
  - `wrapper/codex`: `supports_attachments: true` / `attachment_types: ["image"]` / `supports_user_input_dialog: true`。UI は picker / paste / drop を画像に限定する(phase-14 で添付対応を入れた際に、当初計画の `false` から改めた)
- **`supports_model_switch` / `supports_effort_switch`** (phase-16、2026-07-13 実装済、
  [ADR-0035](../adr/0035-codex-model-catalog-and-mid-session-switch.md) F4):
  session 途中で `set_model` / `set_effort` を受け付けるかを advertise。
  Claude は SDK 対応済で常に `true`、Codex は catalog resolver が
  `EngineModelInfo[]` を返し得るとき (auth mode 判別可 + plan 判定可) に `true`、
  未判別 / 空 catalog 時は `false`。engine 側は catalog / auth mode 変化時に
  capability の advertise を都度更新する。

### Claude モデル catalog live-refresh と bootstrap default floor ([ADR-0037](../adr/0037-claude-model-catalog-live-refresh.md)、Phase 18 で実装)

Claude 側 catalog は「(i) register 経路」と「(ii) `ext.models` 経路」の 2 経路
で advertise される。両者は SDK 実測の可否が構造的に異なるため、扱いを分ける。

| 経路 | call site | SDK 実測可能か | source of truth |
|---|---|---|---|
| (i) register | `runner/src/config.ts` → `LaunchDialog.svelte` | wrapper 内では不可 (SDK Query 未生成、鶏と卵)。runner 側の短命 probe で代替 ([ADR-0039](../adr/0039-engine-catalog-live-probe.md)) | 最後に成功した live probe の runner memory cache (TTL 超過後や以降の probe 失敗でも stale last-known-good として保持)。成功 cache が一度も無いときのみ `wrapper/claude-code/src/catalog.ts` の bootstrap default floor |
| (ii) `ext.models` | `wrapper/claude-code/src/host.ts` → `AgentDetail.svelte` | 可 (init 後 `#refreshSupportedModels()` が実測) | SDK `supportedModels()` の実測結果 |

(i) の bootstrap は `default` 1 エントリのみの最小 floor に縮小済み (Phase 18-3、
`display_name: "Default (recommended)"`、neutral description
`"Account-recommended model · resolved after session start"`、`effort_levels` は
FULL_EFFORT を仮出し)。`default` alias が SDK 側で "account 推奨モデル" を指す
名前解決であり永久に腐らない前提は Phase 18-2 の実測で追認済み
(`resolvedModel: "claude-opus-4-8[1m]"`、詳細は
[ADR-0037](../adr/0037-claude-model-catalog-live-refresh.md) Context 節)。
なお ADR-0037 時点では (i) の source of truth はこの bootstrap 定数のみ
だったが、[ADR-0039](../adr/0039-engine-catalog-live-probe.md) の短命 probe +
runner memory cache 導入後は「実測が第一、bootstrap は成功 cache を一度も
持たないときの floor」に変わっている。**last-known-good 契約**に注意:
register / spawn へ供給されるのは `ClaudeCatalogCache.getStale()` で、TTL を
無視して最後に成功した probe 結果を返す。TTL (既定 1h) が支配するのは
「再 probe するか」の判定 (`getIfFresh()`) だけで、供給値そのものではない。
probe 失敗時は cache の既存 entry を保持し `updateRegister` も呼ばないため、
register は直前の成功結果を載せたまま据え置かれる — bootstrap へは戻らない。

(ii) は SDK 実測を単一の source of truth とする (Phase 18-4/5/6)。
`#refreshSupportedModels()` は自動 bounded retry (init を trial 1 と数える
合計 3 回上限、`MAX_MODEL_REFRESH_RETRIES = 3`) を持ち、`result` message 受信
契機で turn 受信 driven に retry する。上限到達後は silent、cap 到達時のみ
`process.stderr.write` 1 行の診断 breadcrumb を出す。operator 手動 retry は
`refresh_models` control message (client → server → wrapper) で `retrySupportedModels()`
が起動、counter / succeeded flag を reset して再 fetch を kick する。cap 到達
状態は `EnvelopeExt.models_error?: boolean` を持続 state として derive-always で
emit し (`#modelsRetryCount >= MAX && !#modelsSucceeded`)、client 側は 2 面設計で
消費: 持続 class (`.cc-refresh-error` on ↻ button) と rising-edge tracker
(`sawModelsError` mirror of `sawEffortReset`) による transient `switchNotice` の
2 度目 fire (manual retry 後 再失敗した場合にも見える)。session state / config /
resume snapshot 由来の persist model identifier (alias / canonical のいずれも
ありうる。F9 追補以降は 2-pass で判定) が SDK 実測に含まれない場合は起動時検証
(`#validatePersistModelAgainstCatalog()`、Phase 18-7) で `default` に fallback +
`switch_error{reason: "persist_alias_unknown"}` を発火、client は info tone で
"保存されていた {req} は現在の catalog にないので default で開始しました" を
表示する。

client の retry button (↻) は `AgentDetail.svelte` の切替 button 隣に常時提供
(Phase 18-9)、`agentEngine === "claude-code"` gate で codex には出さない
(ADR-0035 で codex は catalog 静的、handler なし、dead button 防止)。`models_error`
derive にも同じ engine gate が適用され、codex adapter に bug で models_error が
emit された場合でも client 側は反応しない (defensive gate)。

init 前後で `effort_levels` の選択肢集合が変わる UX ズレ (init 前 5 段階 →
init 後は実測 default モデル次第で減る可能性) は受容する trade-off
(観察は
[claude-effort-levels-init-transition](../open-questions/claude-effort-levels-init-transition.md))。

codex 側 catalog は
[ADR-0035](../adr/0035-codex-model-catalog-and-mid-session-switch.md) F1 の
確定判断 (runtime probe 非依存の静的 catalog) を保持し据え置き。protocol schema
は `EngineCatalogEntry` の container 形 (`models: EngineModelInfo[]`、配列・空可)
を変更しない (ADR-0037 F4)。ADR-0037 の改修で `EnvelopeExt` に追加したのは
`models_error?: boolean` の 1 field のみ (`SwitchErrorExt.reason` は open string
ゆえ `"persist_alias_unknown"` は docstring 追記のみで型変更ゼロ)。その後
`EngineModelInfo` の row には `resolved_model?: string` が optional 追加されて
いる (F9 追補、後述)。F4 は container 形についての判断であり、row への optional
field 追加はこれに抵触しない。

### catalog row の canonical ID 透過と 2-pass 突合 ([ADR-0037](../adr/0037-claude-model-catalog-live-refresh.md) F9 追補、2026-07-31 実装)

upstream の `ModelInfo.resolvedModel` (alias が解決される具体 ID、例
`sonnet` → `claude-sonnet-5`) を `EngineModelInfo.resolved_model?: string`
として wire に透過する。read-only metadata であり **absent = unknown**。
空文字は absent に潰す (どの突合にも当たらない値を publish しないため)。

透過は次の 4 経路すべてで行う。1 つでも欠けると経路によって canonical が
見えたり見えなかったりする。

| 経路 | call site |
|---|---|
| probe CLI | `wrapper/claude-code/src/probe.ts` `projectModel()` |
| live SDK | `wrapper/claude-code/src/host.ts` `#refreshSupportedModels()` |
| probe fallback (手動 refresh) | 同 `#executeManualRefresh()` |
| client | `dashboard/src/lib/protocol.ts` `modelsFrom()` |

**突合規則 (2-pass、canonical 側は多重一致しうる)**: catalog row の検索は
「(1) `value` 完全一致 → (2) 無ければ `resolved_model` 一致」の順で行う。
1-pass の or 条件にしてはならない。canonical 一致が alias の明示選択を
shadow すると、誤った effort domain と誤った表示を招くため。

多重一致は例外ではなく既定で起きる。実 probe は `default` と `opus[1m]` を
同じ canonical (`claude-opus-5[1m]`) に解決する。したがって pass (2) は
**先頭で打ち切らず全一致行を返す**。先頭採用は決定論的ではあっても意味的
根拠がなく、pin された `opus[1m]` を浮動の `default` として見せてしまう —
下の「入力表現保存」で normalization を却下したのと同じ意味破壊になる。

一致結果の畳み方は用途ごとに異なる:

| 用途 | 規則 |
|---|---|
| membership / persist 有効性 | 一致が **1 件以上**なら valid |
| effort domain | 一致行の `effort_levels` の **intersection**。1 行でも `effort_levels` 欠落があれば **空** (fail-closed)。`value` 完全一致は常に単一行なのでその行の levels そのもの |
| `supports_effort_switch` | 上の intersection が空なら **`false`**。「行は見つかった」ことを根拠に `true` にしない |
| UI の active 表示 | 一致が **ちょうど 1 件のときだけ** alias を主・canonical を副に出す。多重一致時は alias を捏造せず **raw canonical を主表示**し、canonical 副表示は出さない (主と同一のため) |
| model menu の `aria-selected` | 多重一致時は **全行 `false`** (属性は各 option に付くが、どの行も選択済みにしない)。その canonical はどの alias にも一意に帰属していないので、1 つを選択済みに見せる方が嘘になる |
| 送信 / 保持 | 一致件数に関わらず入力表現保存 (下記)。多重一致は送信値に影響しない |

intersection による fail-closed は client の effort Tier 3 が既に採っている
畳み方と同じで、新規概念ではない。common case (全行が同じ `effort_levels`)
では intersection = その levels となり機能は落ちない。矛盾がある場合だけ
安全側に縮退する。union は不採用 — invalid な model/effort ペアの提示に
相当し、[ADR-0035](../adr/0035-codex-model-catalog-and-mid-session-switch.md)
の silent downgrade 禁止に反する。

**入力表現保存**: `setModel()` が SDK へ渡す文字列、起動時 `Options.model`、
状態の `#model` は、いずれも呼出元から受け取った文字列をそのまま保存する。
catalog 突合は effort domain の決定と未知モデル判定にのみ使い、送信値を
書き換える根拠にしない。alias → canonical / canonical → alias の**いずれの
方向にも正規化しない**。canonical → alias は非単射であり、正規化すると pin
された選択 (`opus`) が account 推奨に追随する浮動の選択 (`default`) に
化けるため。

実装は突合 (`#findCatalogEntries`) と effort 畳み込み
(`#effortLevelsForCatalogEntries`) を各 1 関数に閉じ、wrapper 4 箇所
(`setModel` の `invalidEffort` / `setEffort` / `supports_effort_switch` stamp /
`#validatePersistModelAgainstCatalog`) と client 側 (effort Tier 1 / model 行の
表示解決 / 選択中判定) が同じ規則を共有する。これにより 2 つの defect が
解消した:

- persist された canonical (`claude-sonnet-5`) が `value` 完全一致のみの検証で
  弾かれ、`switch_error{reason: "persist_alias_unknown"}` とともに `default`
  へ rollback していた
- `ext.model` が canonical になった場合 — init / status が canonical を報告して
  [agent-sdk-events](agent-sdk-events.md) の「値のみ上書き」契約で `#model` が
  置き換わる、あるいは operator が canonical を直接 `setModel` する —
  catalog 突合が全経路で miss し、`supports_effort_switch` が stamp されず
  client の effort 選択肢が消える。SDK の `system/init` が実際に alias と
  canonical のどちらを返すかは未観測 (後述) のため、これは「canonical が
  入りうる経路が存在する」ことに基づく条件付きの defect である

**表示 (wire と UI を分ける)**: `resolved_model` は register 経路の catalog row
にも透過される。経路ごとに row の形を変えると consumer が「absent = unknown」
以外の分岐を持たされるため、透過は止めない。そのうえで **UI 表示は
`AgentDetail` のみ**とし、一致がちょうど 1 件のときだけ alias を主・canonical
を副に出す (多重一致時の扱いは上表のとおり)。`LaunchDialog`
での表示は行わない (Gitea
[issue #176](https://gitea.example.invalid/sakurai.yuta/kaoiro/issues/176)
へ外部化)。register 経路の `resolved_model` は runner の last-known-good cache
が持つ「最後に成功した probe 時点」の解決結果で、TTL 超過後も据え置かれる
ため、init 後実測の `ext.models` とは精度が異なる。特に `default` 行は
account 推奨に追随するため、表示値と実際の起動結果がズレる。
精度の違う 2 つを同じ見た目で出すと誤誘導になるため、提示方法は独立した UX
判断として切り出す。

**未観測事項**: SDK の `system/init` が返す `model` の表現 (alias / canonical)
は未確定。観測に first user input (課金) が必要なため実測していない (実測の
範囲と生値は [agent-sdk-events](agent-sdk-events.md) の追実測メモ)。どちらを
返されても壊れないことは wrapper 側テストで pin してある。

codex 側 catalog は静的で canonical / alias の区別を持たないため無変更。
`resolved_model` が absent の row は field 追加前と同一挙動になる。

## Constraints

- MUST: フィルタは `payload` / `ext` だけを触り、外枠(`version`,`agent_id`,
  `ts`,`type`,`state`)に依存しすぎない。

## See Also

- 関連 specs: [architecture](architecture.md), [protocol](protocol.md)
- ADRs: [0001](../adr/0001-agent-sdk-integration.md), [0037](../adr/0037-claude-model-catalog-live-refresh.md)
