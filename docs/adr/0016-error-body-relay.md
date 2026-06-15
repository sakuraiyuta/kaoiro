---
title: ラッパーエラー本文のクライアントへのリレー(result.error_message)
status: accepted
date: 2026-06-16
opened: 2026-06-16
supersedes: []
superseded_by: null
related_specs: [protocol, threat-model]
related_adrs: [10, 12]
---

# ADR-0016 — ラッパーエラー本文のクライアントへのリレー

## Status

Accepted

## Context

wrapper(Claude Code アダプタ)でエラー(例 500 Overloaded)が起きても、その
本文がクライアントへ届かない。`wrapper/src/host.ts` の `run()` は SDK エラーを
catch せず、落ちると `cli.ts` の catch が stderr に出すだけ。`result` payload は
`{text?, is_error?}` のみでエラー本文フィールドが無く、クライアント
(`server/assets/src/lib/AgentDetail.svelte`)は `is_error` を見て「エラーで終了」
固定文字列を表示するだけ。原因が分からず対処できない。

## Decision

- `result` payload に **`error_message?: string`** を追加し、wrapper が捕捉した
  エラー本文を**生のまま**載せて、サーバ経由でクライアントへリレーする。
- 対象は (a) SDK/API レベルのエラー本文(500 Overloaded 等)に加え、
  (b) **wrapper プロセスの異常終了**も「落ちる直前に最後のエラーを送る」形で
  カバーする。
- クライアントは `error_message` を詳細ペインに**常時表示**(整形・要約・
  マスキングしない)。
- エラー専用の新 envelope type は新設しない(`result` の拡張で済ます)。
- 配信は `result` 同様 **operator role 限定**
  ([ADR-0012](0012-response-display-and-dashboard-scope.md))。

## Consequences

### Positive

- 「エラーで終了」固定文字列でなく実エラー内容が見え、原因究明・対処が可能。
- wrapper クラッシュ時も最後のエラーが届く。

### Negative

- wrapper クラッシュ時の「落ちる直前送信」を確実にする実装が要る(プロセス
  終了フック)。
- エラー本文に機微情報が混じり得る(operator 限定配信で緩和、
  [threat-model](../specs/threat-model.md))。

### Neutral

- #1(version、[ADR-0015](0015-protocol-version-stamping.md))・#3(session_id、
  [ADR-0014](0014-session-resume-and-restore.md))と同一の protocol.md 改訂で
  まとめる。

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
| エラー専用の新 envelope type を新設 | `result` 拡張で足り、過剰 |
| エラー本文を整形・要約して表示 | 原因把握には生本文が有用。整形は情報を削る |
| SDK エラーのみ対応(プロセス異常終了は対象外) | 「落ちて終了」の主因を取りこぼす |

## Related

- spec: [protocol](../specs/protocol.md) result payload、
  [threat-model](../specs/threat-model.md)。
- 関連 ADR: [0010](0010-protocol-precisification.md)、
  [0012](0012-response-display-and-dashboard-scope.md)。
- 由来: my-idea-brief(走り書き「エラー本文をクライアントまでリレー」、高優先)。
