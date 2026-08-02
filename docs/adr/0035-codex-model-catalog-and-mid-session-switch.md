---
title: Codex model catalog 復活と mid-session switch 契約
status: accepted
date: 2026-07-11
opened: 2026-07-11
supersedes: []
superseded_by: null
related_specs: [protocol, plugin-model, codex-model-catalog, codex-sdk-events]
related_adrs: [32, 34, 37, 39, 40]
---

# ADR-0035 — Codex model catalog 復活と mid-session switch 契約

## Status

Accepted (2026-07-11、マスター決裁)。実装は
[phase-16-codex-model-switch](../plans/phase-16-codex-model-switch.md)。phase-15
initial 完了後に着手する。

## Context

[ADR-0032](0032-codex-adapter.md) F4bc は、ChatGPT-account 認証で explicit
model が全て 400/404 になった 2026-07-11 の観測を根拠に Codex の
`supportedModels()` を空にした。後に、この観測は ChatGPT Plus 加入前だった
ことが判明した。加入前後の同一 persona rollout では account default が
`gpt-5.6-terra` から `gpt-5.6-sol` へ変化し、同じ session history が継続した
(2026-07-11)。Plus 加入後、codex-cli 0.144.1 を host terminal から実行し、
次を確認した:

| slug | 結果 |
|------|------|
| `gpt-5.6-sol` | exit 0、`MODEL_OK` |
| `gpt-5.6-terra` | exit 0、`MODEL_OK` |
| `gpt-5.6-luna` | exit 0、`MODEL_OK` |
| `gpt-5-codex` (negative control) | HTTP 400、`turn.failed`、exit 1 |

Plus auth では curated trio の explicit 指定が通り、非 entitled slug は silent
fallback せず loud fail する。一方 `codex doctor --json` は auth mode までは
返すが、ChatGPT plan tier と entitled model 集合を返さない。この制約下で、
UI が提示する catalog をどう truthful にするかを決める必要がある。

model switch の輸送路は既に存在する。`setModel(value)` が次 turn 用の値を保持し、
各 turn は同一 `sessionId` を fresh `ThreadOptions` で `resumeThread()` する。
不足しているのは catalog、capability advertisement、失敗時 rollback の正式契約、
および Codex effort の UI 統合である。

## Decision

### F1 — operator plan 申告 (案 B) を採用する

`runner.config.json` に optional な Codex 固有設定を追加する:

```json
{
  "codex": { "chatgpt_plan": "plus" }
}
```

`chatgpt_plan` は `free | go | plus | pro | business | enterprise` の closed enum。
runner は `codex.auth_mode` (Phase-24 で追加) の明示宣言、または
`codex doctor --json` の stored auth mode 検出 (fallback) とこの申告を
組み合わせて catalog を構成する。

- auth mode `chatgpt` + plan 未申告: 空 catalog、account default 委任、stderr warn。
- auth mode `chatgpt` + `free|go`: Terra のみ。
- auth mode `chatgpt` + `plus|pro|business|enterprise`: Sol / Terra / Luna。
- auth mode `apikey`: API-key 用 curated catalog。残置された ChatGPT plan 申告は
  stderr warnを出して無視する。auth切替だけでrunner起動を壊さない。
- auth mode 検出失敗: 空 catalogへ fail closedし、stderr warn。推測しない。

#### auth mode 決定の priority (Phase-24 追補、2026-07-16)

runner が catalog resolve に使う `codexAuthMode` は以下 priority で確定
する (実装は `runner/src/codex-auth.ts::resolveCodexAuthMode` の
injectable policy resolver に集約、startup と hot reload の両方から
呼ばれる):

1. **Codex disabled** (`capabilities` に `"codex"` 無し) → `"unknown"`。
   doctor は絶対に呼ばれない。
2. **explicit `codex.auth_mode`** (`"chatgpt"` / `"apikey"` の closed enum
   を config で明示宣言) → その値を verbatim 採用、doctor は呼ばれない。
   runner 環境 PATH に `codex` binary が無いホスト (dogfood 環境依存の
   典型) でも catalog を正しく resolve する。auth_mode は catalog
   selection 用の宣言 metadata のみで、runner は credential (OAuth token
   / API key 等、Codex 側の credential store / environment) を付与も変更
   もしない — その意味で escalation にならない。誤宣言時は catalog が
   実 entitlement からずれ、unsupported な model / effort の explicit
   request が SDK 側で loud fail → 既存 switch_error rollback に到達し
   うる (auth 実体の invalid credentials エラーになるかどうかは runtime
   の credential store / SDK 実装依存で、config だけからは断定しない)。
3. **absent + Codex enabled** (旧 config 互換 fallback) → `detectCodexAuthMode`
   (doctor 経由) を run。失敗 (spawn ENOENT / JSON parse 失敗 / mode 未報告)
   なら `"unknown"` へ fail-closed、stderr warn (doctor stdout / stderr は
   絶対に relay しない — credential-presence details を stored auth mode
   と同一 JSON に含む可能性があるため)。
4. **`chatgpt_plan` からの暗黙推定は禁止**。API-key runner でも `chatgpt_plan`
   を config に残置しているケース (auth 切替の途中経過) を誤判定するため、
   auth_mode 決定に `chatgpt_plan` を根拠として使わない。

hot reload では priority は同じで、以下 5 遷移すべてが helper 側で一貫
処理される (詳細は phase-24 plan を参照):

- next disabled → `"unknown"` (prev mode 破棄、doctor 非呼出)
- next explicit → 即採用 (doctor 非呼出、値は verbatim)
- prev explicit → next absent → doctor 再走 (operator が pin を外した)
- prev off → next on (absent) → doctor 走る (off から復帰した初回検出)
- prev on (absent) → next on (absent) → prev mode 維持 (doctor 非呼出)

案 A' の「chatgpt auth なら Plus とみなして trio を出す」は採らない。Free / Go
にも Sol / Luna を提示して capability advertisement を偽るためである。非 entitled
slug の loud fail は安全弁として必要だが、既知の誤選択肢を提示する第一防衛線の
代替にはしない。

operator の申告が stale、workspace admin 制約、rollout drift 等で catalog と
実 entitlement がずれる可能性は残る。そこで explicit 指定失敗時の F3 を第二
防衛線とする。catalog は availability の保証ではなく、operator申告と現在の
curated snapshotに基づく候補集合であることを UI tooltip と docs に明記する。

### F2 — catalog と effort を `ext.models` に統合する

`CODEX_MODELS` の global constant を、auth mode + operator plan から構成する
resolver に置換する。runner register の engine catalog と、spawn後の
`state_change.ext.models` は同じ resolver 出力を使い、LaunchDialog と
AgentDetail の候補集合を一致させる。

Sol / Terra / Luna の各 entry に、Codex SDK 0.144.1 が受理する reasoning effort
を `effort_levels` として付ける。値集合は実装開始時に CLI/SDK 型と実機で再確認し、
未検証値は advertise しない。[ADR-0032](0032-codex-adapter.md) F4bc の E-B、
すなわち独立 effort catalog ではなく model entry への統合を実行する。

### F3 — mid-session model switch contract

operator の `set_model` は次の契約に従う:

1. **turn boundary**: 実行中 turn は変更しない。選択は次 turn から適用する。
   実行中に即時変更したい場合は interrupt 後、新しい instruction を送る。
2. **continuity**: 同一 `sessionId` を `resumeThread(sessionId, options)` し、history
   を維持する。model変更のためだけに fresh sessionを作らない。
3. **pending と effective の分離**: UI は選択直後に pending 値を表示できるが、
   `ext.model` と server snapshot は成功した turn が報告した実効値でのみ確定する。
4. **loud fail**: 400/404その他の明示指定拒否を失敗として表示し、別modelや
   account defaultへ silent fallbackしない。
5. **rollback**: wrapper は最後に成功した model を保持する。switch turn が失敗
   したら pending値を破棄し、次 instruction は旧modelで同一sessionをresumeする。
   operatorが明示的に再試行するまでは失敗modelを再送しない。
6. **drift semantics**: operator-requested switch は意図した変更であり
   `resume_drift` にしない。phase-15 の resume snapshot は最後に成功した実効値を
   保存する。失敗した pending値はsnapshotへ書かない。

effort switch も turn boundary、effective確定、loud fail、rollback、drift の同じ
契約に従う。model変更時に現在effortが新modelの `effort_levels` 外なら、UIでmodel
選択と同時に有効値を選ばせるか既定へ戻す。黙って近似levelへ変換しない。

### F4 — `supports_model_switch` を実装する

[ADR-0034](0034-session-capabilities-advertisement.md) F2 の予約field
`ext.session_capabilities.supports_model_switch` を実装する。true の条件は、その
sessionで使用する Codex catalog が非空であり、wrapperが `set_model` と rollback
契約を提供すること。未stamp/falseなら model switch UI をdisabledにする。

同時に `supports_effort_switch` を追加し、active model に非空の
`effort_levels` がある場合のみtrueとする。dashboardは engine名ではなくこの
capabilityでmid-session操作を判定する。LaunchDialogの起動時model選択はrunner
engine catalogを用い、session capabilityはspawn後の操作に用いる。

### F5 — phase-15 との境界

phase-15 task 15-4 が AgentDetail の「アカウント既定」Codex特例を
`model_source` 判定へ置換するため、phase-16では同特例を再度触らない。
phase-16のUI scopeは次に限定する:

- LaunchDialog の Codex model / effort select復帰。
- AgentDetail のmid-session model / effort switch有効化。
- pending / effective / failure / rollback表示。
- capabilityによるenable/disable。

## Consequences

### Positive

- Free / Go に使えないmodelを一律提示せず、Plus以上では選択自由度が戻る。
- session/historyを維持したmodel切替が正式な契約になる。
- modelとeffortの候補、起動時選択、mid-session選択が同じcatalogを使う。
- entitlement driftはloud fail + rollbackでsessionを壊さず露出する。

### Negative

- ChatGPT plan変更時にoperatorがrunner configを更新する必要がある。
- plan申告だけではworkspace admin制約や段階rolloutを完全には表現できない。
- auth検出とcatalog resolverがrunner起動時の外部状態に依存する。

### Neutral

- plan未申告時の既存挙動 (空catalog + account default) は維持される。
- API-key用catalogはChatGPT plan catalogと別branchであり、entitlement推測を共有しない。

## Alternatives Considered

| Option | Decision |
|--------|----------|
| A': `auth-mode=chatgpt` ならPlus前提でtrioを提示 | Reject。Free/Goでも同じauth modeなのでfalse positiveを構造的に作る。loud failは誤advertiseの免罪符ではない |
| B: operatorがplanを申告 | **Adopt**。手動更新コストはあるが、列挙API不在で最もtruthfulかつfail-closedにできる |
| endpointへ各slugをprobeしてcatalog生成 | Reject。起動ごとにquota/latencyを消費し、probe自体がsessionを生成する。rate limitと一時障害をentitlementと誤認する |
| 永久に空catalog | Reject。Plusでtrioが通るgating factとoperatorの切替要求が成立し、既存switch輸送路を無効化し続ける便益がない |
| model切替ごとにfresh session | Reject。history喪失が不要で、SDKのsame-session resume経路が既にある |

## Implementation

[phase-16-codex-model-switch](../plans/phase-16-codex-model-switch.md) で実装する。
