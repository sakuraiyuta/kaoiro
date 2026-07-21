---
title: operator permission latency と dashboard 表示条件の measurement schema
status: proposed
date: 2026-07-21
opened: 2026-07-21
supersedes: []
superseded_by: null
related_specs: [protocol, architecture, threat-model]
related_adrs: [12, 20, 21, 22, 33]
---

# ADR-0041 — operator permission latency と dashboard 表示条件の measurement schema

## Status

Proposed。kaoiro 論文プロジェクトの測定定義との突合は完了しているが、
実装と protocol schema の変更にはまだ着手しない。

## Context

kaoiro は `permission_request` と `permission_decision` を `request_id` で相関し、
`waiting_permission` を dashboard に提示できる。しかし現状記録される時刻は、
wrapper の `PermissionBroker.decide()` が要求生成時に付ける ISO 8601 `ts` だけで
ある。この値は次の二箇所に同じ値として載る。

- `permission_request` envelope の外枠 `ts`
- `state_change.ext.pending_permission.ts` ([ADR-0022](0022-pending-permission-authoritative-source.md) の authoritative source)

これは要求生成時刻であり、browser が permission dialog を operator に実際に
提示した時刻ではない。現行の dashboard → server → wrapper の
`permission_decision` は `{agent_id, request_id, allow}` のみを持ち、提示時刻、
判断時刻、wrapper での解決時刻、latency、終了理由は記録しない。また host と
browser の wall clock は一致する保証がない。

将来実験では、permission latency の測定に加えて AgentDetail の観察刺激を四条件
で切り替える。測定値を条件と結合可能にしつつ、permission dialog 自体と操作機能を
消して安全性を損なわない schema が必要である。

本 ADR は trial/replay/export の完全な実験基盤を決めない。第一段階で必要な
permission measurement と表示 condition の語彙だけを固定する。

## Decision

### D1. permission lifecycle は四時刻を分離する

一件の permission lifecycle を `request_id` で相関し、次の四時刻を別概念として
記録する。

| field | 記号 | 発生点 / clock owner | 意味 |
|---|---|---|---|
| `requested_at` | `t_request` | wrapper wall clock | `PermissionBroker.decide()` が要求を生成した時刻。既存 `pending_permission.ts` と同値 |
| `presented_at` | `t_presented` | browser wall + monotonic clock | 対象 `request_id` の dialog が DOM に反映され、operator に提示可能になった時刻 |
| `decided_at` | `t_decision` | browser wall + monotonic clock | operator の allow / deny 操作を dashboard が受理した時刻 |
| `resolved_at` | `t_resolved` | wrapper wall clock | broker が allow / deny / timeout / close 等で pending Promise を settle した時刻 |

`t_request` と `t_resolved` は engine host 側 lifecycle、`t_presented` と
`t_decision` は operator UI lifecycle を表す。ネットワーク遅延や描画遅延を判断
時間へ混入させないため、この四つを一つの「request timestamp」に潰さない。

wall-clock field は ISO 8601 UTC string とする。browser が所有する二時刻には、
同じ browser context 内の monotonic timestamp も併記する。

```ts
interface BrowserMeasurementTime {
  wall: string;          // new Date().toISOString()
  monotonic_ms: number;  // performance.now()
  context_id: string;    // page lifecycle ごとの random id
}
```

`context_id` は reload / navigation で更新する。異なる `context_id` の monotonic
値を減算してはならない。

### D2. 主指標は browser monotonic clock の decision latency とする

主指標 `latency_ms` は、同じ browser context で観測した場合に限り次で計算する。

```text
latency_ms = t_decision.monotonic_ms - t_presented.monotonic_ms
```

値は finite かつ 0 以上でなければならない。clock owner が異なる
`t_request → t_presented`、`t_decision → t_resolved`、`t_request →
t_resolved` は診断用 wall-clock interval として保持できるが、operator 判断時間
の主指標にはしない。NTP 補正や host/browser clock skew により負値になり得るため
である。

presentation は permission record を state に取り込んだ時刻ではなく、Svelte の
DOM update 完了後に対象 dialog が可視であることを確認した時刻とする。同一
`request_id` / `context_id` 内の同じ描画について最初の一回だけ記録し、単なる
再描画では上書きしない。一方、reload / navigation または reconnect 後に pending
dialog を復元した場合は、最初の presentation を置換せず `presentations` に追加する。

latency の eligibility は lifecycle 全体について次の規則で確定する。

| lifecycle | `latency_eligible` | `latency_ms` |
|---|---:|---|
| 同じ context で presentation → decision、途中の context 変更 / reconnect なし | `true` | 最初の presentation から decision までを計算 |
| 最初の presentation 後に context 変更または reconnect が発生 | `false` | absent。復元後の presentation から測り直さない |
| pending 復元または resolution の相関が回復不能と確定 | `false` | absent。terminal は `correlation_lost` |

復元後の presentation から測り直すと operator が切断前に観察していた時間を落とし、
latency を系統的に過小評価する。このため一度 `false` になった lifecycle を、後の
reconnect / presentation によって `true` へ戻してはならない。欠測を 0 ms として
補完しない。

### D3. terminal outcome と anomaly を別型で記録する

最小 record は次の論理 shape を持つ。transport 上の最終配置は実装 plan で
protocol 型と server validation を同期するが、field の意味は本 ADR を SSoT と
する。

```ts
type PermissionTerminalOutcome =
  | "allowed"
  | "denied"
  | "timeout"
  | "wrapper_close"
  | "correlation_lost";

type PermissionAnomaly =
  | "late_decision"
  | "duplicate_presentation"
  | "duplicate_decision"
  | "context_changed";

interface PermissionPresentation extends BrowserMeasurementTime {
  condition: ObservationCondition;
}

interface PermissionMeasurement {
  request_id: string;
  agent_id: string;
  session_id?: string;
  requested_at: string;
  presentations: PermissionPresentation[];
  decided_at?: BrowserMeasurementTime;
  resolved_at?: string;
  latency_ms?: number;
  latency_eligible: boolean;
  terminal_outcome?: PermissionTerminalOutcome;
  anomalies: PermissionAnomaly[];
}
```

terminal outcome の意味は次の通り。

- `allowed` / `denied`: operator decision が wrapper の pending request を
  settle した terminal outcome。
- `timeout`: `permission_timeout_ms` により broker が fail-closed deny した。
- `wrapper_close`: wrapper shutdown 時の `PermissionBroker.close()` により
  pending request が deny で settle した。
- `correlation_lost`: pending の復元不能または resolution の観測不能が回復不能と
  確定し、通常の terminal outcome と相関できなかった。

disconnect は lifecycle 上の event であり、それ自体は terminal outcome ではない。
browser reconnect 後も同じ `request_id` が authoritative pending state から復元
できる間は lifecycle を継続する。wrapper disconnect も再接続後に resolution を
相関できる可能性が残る間は同様であり、回復不能が確定した時点でのみ
`correlation_lost` を記録する。

anomaly の意味は次の通り。

- `late_decision`: terminal outcome 確定後に同じ `request_id` への decision が
  到着した。
- `duplicate_presentation`: 同一 context 内で同じ dialog presentation を二回以上
  観測した。最初の有効 presentation は保持する。
- `duplicate_decision`: terminal outcome 確定前に同じ decision を二回以上観測
  した。最初の有効 decision は保持する。
- `context_changed`: 最初の presentation 後に reload / navigation、または
  reconnect による measurement context の断絶が発生した。pending が復元できても
  `latency_eligible=false` とし、復元後の presentation から測り直さない。

anomaly は terminal outcome を破壊しない。配列なので、terminal 前の
`duplicate_decision` と terminal 後の `late_decision` が同じ lifecycle に発生しても
情報を失わない。durable store を導入する場合は terminal record の上書きではなく
append-only observation として残し、集計 view が terminal outcome と anomaly
flags に展開する。

operator action が無い `timeout` / `wrapper_close` / `correlation_lost` では
`decided_at` と `latency_ms` は absent でよい。wrapper が settle しなかった
`correlation_lost` や無視された anomaly event では `resolved_at` は absent でよい。
欠測を 0 ms として補完しない。

### D4. 表示 condition は closed enum とする

AgentDetail の観察領域に次の closed enum を導入する。

```ts
type ObservationCondition =
  | "raw_log"
  | "state_only"
  | "expression_only"
  | "combined";
```

| condition | transcript/raw log | 状態ラベル | 表情 sprite |
|---|---:|---:|---:|
| `raw_log` | 表示 | 非表示 | 非表示 |
| `state_only` | 非表示 | 表示 | 非表示 |
| `expression_only` | 非表示 | 非表示 | 表示 |
| `combined` | 表示 | 表示 | 表示 |

適用範囲は AgentDetail の観察刺激だけとする。次の operator control は全条件で
維持する。

- permission dialog と allow / deny controls
- question / input dialogs、composer、interrupt 等の操作手段
- close / navigation と、実験を安全に中止するための control

agent name、engine/permission metadata、model/cost/context 等の補助情報を観察刺激
へ含めるかは実験 protocol 側で別途固定する。本 ADR の四条件だけから暗黙に表示を
増減させない。第一実装では現行 settings の localStorage pattern を再利用できるが、
measurement record の各 `presentations[]` 要素には permission dialog を提示した
瞬間の**実効 condition**を copy し、後の settings 変更で過去 record の条件が
変わらないようにする。

### D5. 既存 permission protocol との整合

- `permission_request.payload.request_id` と
  `state_change.ext.pending_permission.request_id` を lifecycle correlation key と
  する。新しい ID を追加しない。
- `requested_at` は既存 `pending_permission.ts` を正規値として複製する。
  legacy `permission_request` envelope の外枠 `ts` も同値だが、dashboard は
  ADR-0022 に従い authoritative pending record を読む。
- `permission_request` は初出通知の役割を維持し、presentation の authoritative
  source に昇格させない。join/reconnect 後に `ext.pending_permission` から dialog
  が復元された場合も、その browser context での presentation を配列へ追加できる。
  ただし最初の presentation 後の context 変更 / reconnect は
  `latency_eligible=false` + `context_changed` とし、復元後の時刻から latency を
  再計算しない。
- 現行 `permission_decision` の allow / deny semantics は変更しない。測定 field を
  decision relay に同梱する場合も wrapper は operator decision と browser telemetry
  を区別し、未知/不正な測定値を理由に decision 自体を失わせてはならない。
- viewer には permission payload / measurement を配信しない。operator-only の
  既存 role policy ([ADR-0021](0021-role-information-disclosure-policy.md)) を継承する。
- Codex exec は `approval: "never"` で permission lifecycle を発生させない
  ([ADR-0033](0033-permission-model-dual-axis.md) F3)。record absent は欠測ではなく、
  現行 engine capability の非対称である。

### D6. 完了条件と非目標

最小実装の完了条件は、Claude permission request について四時刻を分離して相関
でき、eligible な operator decision record の `latency_ms` を browser monotonic
clock から再計算でき、提示時の condition、terminal outcome、anomalies を保持
できることである。

本 ADR の非目標:

- Codex exec の approval 固定解除
- trial / condition assignment の実験計画、被験者 ID、randomization
- durable outcome export の storage format
- trace playback または engine の決定論的再実行
- wall clock 間の clock synchronization

## Consequences

- 既存 `pending_permission.ts` を壊さず、request generation と presentation を
  区別できる。
- 主指標を単一 browser clock に閉じるため、host/browser clock skew の影響を
  受けない。
- reload/reconnect、timeout、shutdown、correlation loss、late/duplicate anomaly を
  正常な allow/deny から分離でき、latency eligibility と欠測処理を明示できる。
- 表示 condition は client-local に実装可能だが、再現可能性のため measurement
  record へ実効値を固定する必要がある。
- `t_resolved` と非 click outcome を正確に得るには wrapper 側の resolution 観測点
  が必要であり、client だけの変更では四時刻 schema を完結できない。

## Alternatives considered

| 案 | 判断 |
|---|---|
| `permission_request.ts` から click 時刻までを latency とする | 却下。network / server fan-out / browser rendering と host-browser clock skew が混入する |
| browser wall clock だけを使う | 却下。wall clock 補正で負値・不連続が起き得る。monotonic を主指標にする |
| `state_change(waiting_permission)` 受信時を presentation とする | 却下。受信と DOM 可視化は別時点で、background tab / render queue の遅延を落とす |
| timeout / close を deny にまとめる | 却下。operator 行動と system default を区別できず、介入率と latency の解釈を歪める |
| 四条件を独立 boolean で表す | 却下。未定義組合せと実験条件 drift を生むため closed enum にする |
