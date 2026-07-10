---
title: 権限モデルの共通抽象を sandbox × approval の二軸へ拡張
status: accepted
date: 2026-07-10
opened: 2026-07-10
supersedes: []
superseded_by: null
related_specs: [protocol, plugin-model]
related_adrs: [22, 32]
---

# ADR-0033 — 権限モデル共通抽象を sandbox × approval の二軸へ拡張

## Status

Accepted (実装は [phase-14-codex-adapter](../plans/phase-14-codex-adapter.md))。envelope schema・Claude 写像 table・UI 語彙は 2026-07-10 の実 SDK 検証と spec-elicitation で確定済み (旧 open-questions Q2/Q3 は解決・close)。

## Context

現状 wrapper / server / dashboard の権限モデル抽象は Claude Agent SDK の `permissionMode` (default/acceptEdits/bypassPermissions/plan/dontAsk/auto) を直接踏襲した単軸で、[protocol](../specs/protocol.md) の `ext.permission_mode` に露出、`ext.pending_permission` の authoritative source は [ADR-0022](0022-pending-permission-authoritative-source.md) で `state_change.ext` に確立された。

[ADR-0032](0032-codex-adapter.md) で Codex CLI アダプタを追加するにあたり、Codex の権限モデルが二軸である事実に共通抽象を合わせる必要がある (値集合は `@openai/codex-sdk` 0.144.1 の型定義で実証済み):

- **sandbox_mode**: `read-only` | `workspace-write` | `danger-full-access` — file system への書き込み可否と範囲 (OS レベル sandbox)。
- **approval_policy**: `untrusted` | `on-request` | `on-failure` | `never` — 各操作について都度承認を求めるかの方針。初期 ADR 起草時に想定していた `granular` は実 SDK に存在しない。

Claude は単軸 mode で「shell も勝手にやってよいか」と「file edit を勝手にやってよいか」を区別できないため、二軸で表現するほうが表現力が広い。単軸プリセット (`default / accept-edits / yolo` 等) に潰すと Codex 二軸の表現力を失うため、共通抽象自体を二軸へ拡張する。

**制約 (2026-07-10 実証)**: `@openai/codex-sdk` は毎ターン `codex exec` を新規 spawn し stdin を prompt 書込直後に close するため、**実行中に operator の承認を SDK へ返す経路が存在しない** (feature flag `exec_permission_approvals` は under development = 未リリース、exec の既定 approval_policy は `never`)。したがって Codex agent の二軸は spawn 時に固定され、`waiting_permission` 状態は Codex では発生しない。upstream の承認対応は [open-questions/codex-exec-approval-upstream](../open-questions/codex-exec-approval-upstream.md) で追跡する。

## Decision

### F1 — envelope schema の二軸拡張 (`ext.permission`)

agent-level の `ext.permission = {sandbox, approval}` を新設し、現行 `ext.permission_mode` の後継とする。`pending_permission` (承認要求ごとの record) 内への軸複製は**しない** — Codex は pending_permission を発行せず (Context の制約)、Claude では同じ `state_change.ext` に `permission` と `pending_permission` が並んで載るため複製は冗長:

```json
{
  "type": "state_change",
  "state": "waiting_permission",
  "ext": {
    "permission": { "sandbox": "workspace-write", "approval": "untrusted" },
    "pending_permission": {
      "request_id": "abc-123",
      "tool_name": "Bash",
      "input": { "command": "ls" },
      "ts": "2026-07-10T05:30:00Z"
    }
  }
}
```

列挙値 (Codex 語彙そのまま、写像レイヤなし):

- `sandbox`: `read-only` | `workspace-write` | `danger-full-access`
- `approval`: `untrusted` | `on-request` | `on-failure` | `never`
  (`on-failure` は upstream 0.144 で `on-request` の deprecated alias に格下げ
  済み。kaoiro の wrapper が emit することはないが、SDK 型との互換のため
  enum には残す)

**deprecation プラン (D-A)**: `ext.permission_mode` は 1 リリース窓の間 `ext.permission` と並置して送出し、次リリースで削除する ([ADR-0031](0031-runner-persona-trust-mode.md) の personas legacy フィールドと同じ流儀)。dashboard は本 phase から `ext.permission` のみを読む。

### F2 — Claude 6 mode の二軸写像は wrapper/claude-code に閉じる

Claude Agent SDK の `permissionMode` 全 6 値 → 二軸への写像は `wrapper/claude-code` アダプタ内に写像 table として持つ。SDK 出力を wrapper で正規化してから envelope へ載せることで、server と dashboard は engine 語彙を意識せず二軸だけ扱えばよい。写像は**表示用の近似**であり、SDK へ渡す値は従来どおり mode そのもの:

| Claude mode | sandbox | approval | 根拠 (SDK doc) |
|---|---|---|---|
| `default` | workspace-write | untrusted | 危険操作は都度確認 ("prompts for dangerous operations") |
| `acceptEdits` | workspace-write | on-request | file edit 自動承認、他はモデル要求時に確認 |
| `plan` | read-only | on-request | ツール実行なし・読み取りのみ |
| `bypassPermissions` | danger-full-access | never | 全バイパス |
| `dontAsk` | workspace-write | never | 聞かずに事前承認外は拒否 ("deny if not pre-approved") |
| `auto` | workspace-write | on-request | 分類器が承認を代行 (要求自体は発生する) |

### F3 — Codex は二軸を直接使う (approval は `never` 固定)

`wrapper/codex` アダプタは spawn 時に選択された `sandbox_mode` をそのまま `ext.permission.sandbox` に投影する。`approval` は **`never` 固定** — `codex exec` は harness override で approval_policy を `never` に強制し (`-c approval_policy=...` も無効)、SDK 経由で承認を返す経路が存在しないため、事実をそのまま envelope に載せる。mid-session の権限変更 (`set_permission_mode` 相当) も Codex では非対応。

### F4 — dashboard UI は engine-native 操作 + 二軸バッジ表示

- **表示** (AgentCard / AgentDetail): `ext.permission` 由来の二軸バッジで engine 非依存に統一。
- **操作** (LaunchDialog / AgentDetail): engine-native なセレクトを出す。Claude = mode セレクト (6 値)、Codex = sandbox セレクト (3 値) + workspace-write 時の network access toggle。各選択肢のラベルには二軸換算を併記する (例:「acceptEdits — 書込: workspace / 承認: on-request 相当」)。
- 当初検討した cross-engine preset ショートカット (default / edit-friendly / yolo 等) は**採らない**: 選べる組合せが engine ごとに 3-6 個しかなく、preset 層は写像保守だけ増やす (2026-07-10 spec-elicitation で決定、旧 Q3 close)。

### F5 — ADR-0022 との関係

[ADR-0022](0022-pending-permission-authoritative-source.md) の「`state_change.ext.pending_permission` が authoritative source」原則は本 ADR で維持する。本 ADR はその payload 形状に `sandbox` / `approval` を追加する追補で、ADR-0022 を supersede しない。

## Consequences

### Positive

- Codex 二軸の表現力を失わず、Claude / Codex の権限概念を単一の envelope schema (`ext.permission`) で表現できる。
- dashboard の権限**表示**が engine 分岐なしに一本化 (二軸バッジだけを実装すればよい)。操作 UI は engine-native だが、選択肢集合は engine adapter が返すため dashboard に engine 知識は染み込まない。
- Codex の OS レベル sandbox が envelope 上で第一級表現になり、「承認なしでも sandbox で抑える」という Codex の安全モデルが operator に見える。

### Negative

- `ext.permission_mode` の 1 リリース窓並置期間、wrapper は両フィールドを送出する。
- Claude 6 mode → 二軸 mapping は表示用の**近似**であり、mode の細かな意味論 (auto の分類器承認など) は二軸に落ちない。ラベル併記で補う。
- Codex の承認体験は upstream の `exec_permission_approvals` が stable になるまで存在しない ([open-questions/codex-exec-approval-upstream](../open-questions/codex-exec-approval-upstream.md) で追跡)。

### Neutral

- `permission_request` envelope の役割 (ADR-0022 F2 で初出通知に降格済) は本 ADR で変わらない。二軸フィールドは envelope 内にも同期する。
- viewer 配信は ADR-0021 の allow-list で自動カバー (ext は viewer 完全除去)。

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
| 行為プリセット共通抽象 (`default / accept-edits / auto-shell / plan-only / yolo`) を単軸で維持 | Codex 二軸の表現力を単軸に潰し、意味論マッピング table が結局 open-question の巣になる。preset 命名合意コストも大 |
| engine 別語彙をそのまま UI に露出 (Claude 6 mode 側と Codex 二軸を並置) | dashboard の permission **表示**が engine ごとに違う集合になり、envelope schema / server validation が engine 分岐だらけ (操作 UI の engine-native 化とは別問題 — 表示は二軸で統一する) |
| Codex 側を単軸に丸めて既存 `permissionMode` schema を据置き | Codex 二軸の表現力を失い、OS sandbox という Codex の安全モデルが envelope 上で見えなくなる |
| `sandbox` / `approval` を pending_permission 内に置く (本 ADR 初稿の形) | Codex は pending_permission を発行しない (承認フロー自体が exec で提供不能) ため、Codex の権限状態の置き場所が消える。agent-level `ext.permission` に一本化 |
| cross-engine preset ショートカット層 (旧 Q3 暫定方針) | 選べる組合せが engine ごとに 3-6 個しかなく、preset → engine 写像の保守だけ増える。Codex では大半の preset が同一設定に潰れる |
| `codex app-server` (JSON-RPC) 直叩きで承認を配線 | published SDK を捨てて experimental protocol に依存。実装コスト大・upstream 変更で壊れやすい。MVP は起動時固定二軸で足りる |

## Related

- 追補元: [ADR-0022](0022-pending-permission-authoritative-source.md) (authoritative source 原則を維持しつつ ext 拡張)。
- 由来: [ADR-0032](0032-codex-adapter.md) F2 (Codex adapter 追加に伴う権限抽象の拡張)。
- 実装: [phase-14-codex-adapter](../plans/phase-14-codex-adapter.md)。
- Open questions: [codex-exec-approval-upstream](../open-questions/codex-exec-approval-upstream.md) (upstream 承認対応の追跡)。旧 Q2 (envelope schema) / Q3 (UI 語彙) は 2026-07-10 に解決済み・close。
- 関連 specs: [protocol](../specs/protocol.md) (`ext.permission` 追補)、[plugin-model](../specs/plugin-model.md)。
