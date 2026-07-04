---
title: pending_permission の authoritative source を state_change.ext へ — permission_request envelope は初出通知に降格
status: accepted
date: 2026-06-22
opened: 2026-06-22
supersedes: []
superseded_by: null
related_specs: [protocol, threat-model]
related_adrs: [10, 11, 12, 21, 27]
---

# ADR-0022 — pending_permission の authoritative source を `state_change.ext` へ

## Status

Accepted

## Context

Phase 3 で導入された permission ダイアログには、表示直後に他の
`state_change` envelope が届くと **ダイアログが消失して操作不能** になり、
600 秒後にラッパーの broker タイムアウトで自動 deny → セッションが詰む致命的
不具合がある(issue #59)。

直接原因はクライアント (`server/assets/src/App.svelte`,
`server/assets/src/lib/AgentDetail.svelte`) が agent ごとに **最新 envelope
1 件** をバケットに上書き保持しており、`permission_request` envelope が
`state_change` で上書きされた瞬間に永続性を失うこと。

修正方針は 3 案あった:

| 案 | 概要 | 採否 |
|---|---|---|
| A | クライアント側に `pendingPermissions` ストアを設け envelope 単独依存を回避 | 却下: 短期は有効だがリロード復元・複数 operator 同期・viewer 観測・history 整合で再発火する。protocol が状態を完全表現していないことが構造的な原因なので、クライアント側のローカルストアでは根治しない |
| B | wrapper が waiting_permission 中の `state_change.ext` に `pending_permission` を持続付与し、クライアントは ext から派生する | **採用**: protocol を真実の単一ソースとする ADR-0012 / ADR-0021 と整合する。snapshot で復元可能、複数クライアント間で常に同期する |
| C | wrapper 側で waiting_permission 中の `state_change` を queue し permission_resolved 後にフラッシュ | 却下: state 機械の根本変更でリスク大。進行情報のクライアント観測が遅れる |

## Decision

### F1: `state_change.ext.pending_permission` を authoritative source とする

pending 中の許可要求の真実は `state_change.ext.pending_permission` に乗る。
`null` / 未設定なら pending 無し。形状は `{ request_id, tool_name, input?,
truncated?, ts }`(`permission_request` envelope の payload と同等)。

```json
{
  "type": "state_change",
  "state": "waiting_permission",
  "payload": {},
  "ext": {
    "pending_permission": {
      "request_id": "abc-123",
      "tool_name": "Bash",
      "input": { "command": "ls" },
      "ts": "2026-06-22T05:30:00Z"
    }
  }
}
```

### F2: `permission_request` envelope は **初出通知** に降格

protocol 互換維持と「pending が新たに出た」イベント通知の目的で
`permission_request` envelope は残すが、状態の真実ではなくなる。今後は
クライアントは ext を読むのが正解。

`permission_request` envelope の payload と `state_change.ext.pending_permission`
は wrapper 側で同期保証する(同一の `request_id` / `tool_name` /
`input` / `truncated` / `ts`)。

### F3: wrapper が ext に持続付与する

- `wrapper/src/host.ts` に `#pendingPermission` 状態を持つ。
- `wrapper/src/permission.ts` は decide() 開始時に `onPendingChange(pending)` で
  host に通知、resolve / timeout / close 時に `onPendingChange(null)` で
  クリアする。
- host の `#statusExt()` が `#pendingPermission !== null` のとき
  `ext.pending_permission` を含めて返す。`waiting_permission` 中に他の
  state 変化(thinking / tool_running / session_init による idle 等)が
  起きても ext は持続する。
- `permission_resolved` で host は `#pendingPermission = null` を確認
  (broker が先に通知済み)してから `state_change(tool_running)` を emit
  する。ext は当然 pending を含まない。

### F4: viewer 配信は ADR-0021 の allow-list で自動カバー

`pending_permission` は ext に乗るため、ADR-0021 の「viewer は全 type で
ext を除去」によって viewer へは漏れない。新規ガード不要。
`permission_request` envelope 自体も ADR-0021 で viewer 完全除去
(合成 `state_change(waiting_permission)` に置換)済み。

### F5: snapshot 復元

サーバの `AgentStates` は state_change を最新 envelope として put する。
よって新規 join したクライアントの snapshot に `ext.pending_permission`
が乗り、未解決の permission がそのまま復元される。DETS 等の永続化は
不要(セッション中の生存性のみが目的、#49 とは別関心)。

### F6: broker timeout は SDK デフォルト(無制限)へ移行

ADR-0011 が「無応答 600 秒で deny」と規定していたが、根本原因が pending
消失だった以上、10 分の自動 deny は **正規ユーザのキーボード離席で誤発火
する UX 上の弊害** が主になる。SDK 本体は canUseTool に timeout を設けず
応答受信まで待つので、broker のデフォルトもそれに合わせる:

- `wrapper/src/permission.ts` の `DEFAULT_PERMISSION_TIMEOUT_MS = 600_000`
  を撤廃。`options.timeoutMs` / `config.permission_timeout_ms` が undefined
  なら無制限待機。
- 任意の有限タイムアウトは config / 環境変数で opt-in 可能とする(設定面
  整備は別 issue #60、本 ADR ではコード側の挙動変更のみ)。
- ADR-0011 の該当節は本 ADR への参照で更新する。

### F7: クライアントは ext 経由へ一発切替

互換 fallback は残さない。すべてのクライアント(ダッシュボード)が in-tree
で `permission_request` envelope を直接読まなくなる。`permissionRequestOf`
helper は `pendingPermissionFrom` へ役割を移し、AgentDetail.svelte 等の
派生も `envelope.ext.pending_permission` 経由に統一する。

## Consequences

### Positive

- waiting_permission 中の state_change(thinking / tool_running /
  session_init 由来の idle 等)で **ダイアログが消失しない**(issue #59
  根治)。
- リロード・再接続時に snapshot 経由で pending が即座に復元される。
- 別タブで開いた operator 間でも常に同じダイアログが表示・同期される。
- viewer 漏洩は ADR-0021 の allow-list で自動的に守られる(追加ガード
  不要)。
- 600 秒の意図しない auto-deny が消え、長時間離席後の操作再開が UX 的に
  自然になる。

### Negative

- `state_change.ext` のサイズが pending 中だけ膨らむ(`input` を最大
  16KB 含むため)。`pending_permission` 自体は viewer から除去されるので
  漏洩リスクは ADR-0021 と同じ範囲。
- broker timeout を無制限にしたことで、operator が決定を返さないまま
  永続化されたセッションは canUseTool の Promise が解決されず、wrapper
  側で当該ターンが進行しない。これは現状の deny と同じ「ターンが進まない」
  状態だが、wrapper の終了で `close()` 時に強制 deny される。

### Neutral

- `permission_request` envelope は protocol に残るので、外部クライアントが
  当面 envelope 単独依存でも壊れない(ただし新クライアントは ext 経由を
  推奨)。
- DETS 永続化は不要(snapshot 復元で足りる)。長期保管が必要になったら
  #49 (session_id ポインタ) と同じパターンで後追い可能。

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
| A: クライアント側で pendingPermissions ストア新設 | リロード復元・複数 operator 同期・viewer 観測・history 整合で再発火する。protocol が状態を完全表現しないことが構造原因なので、ローカルストアは対症療法に留まる |
| C: wrapper で waiting_permission 中の state_change を queue/フラッシュ | state 機械の根本変更でリスク大。進行情報のクライアント観測が遅れる。本 ADR の F3 (ext に持続付与) より変更面が広い |
| 2 段階移行 (ext fallback あり) | クライアントは全て in-tree で外部互換性なし。fallback コードは保守負債となる。一発切替で十分(#59 user 決定) |
| broker timeout を据置(600 秒)| 根本原因が pending 消失だった以上、10 分の自動 deny は正規ユーザの離席で誤発火する UX 弊害が主になる |

## Related

- specs: [protocol](../specs/protocol.md)(`state_change.ext.pending_permission`
  を追補、`permission_request` envelope を初出通知に降格)、
  [threat-model](../specs/threat-model.md)(viewer 漏洩は ADR-0021
  経由で自動カバー)。
- ADR: [0010](0010-protocol-precisification.md)(段階的精緻化方針)、
  [0011](0011-phase3-reliability-and-auth.md)(broker timeout 規約を
  本 ADR で更新)、[0012](0012-response-display-and-dashboard-scope.md)
  (protocol = 真実の単一ソース原則)、[0021](0021-role-information-disclosure-policy.md)
  (viewer 漏洩を allow-list で守る基盤)。
- 由来: [issue #59](https://gitea.example.invalid/sakurai.yuta/kaoiro/issues/59)。
  関連 follow-up: [#60](https://gitea.example.invalid/sakurai.yuta/kaoiro/issues/60)
  (broker timeout の設定項目化、低優先)。
