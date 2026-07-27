---
title: Phase 27 — list_agents に状況判断メタデータを追加 (issue #160)
description: MCP list_agents (directory_request) の peer entry に 6 field (残コンテキスト / セッション開始日時 / turn 数 / 最終活動時刻 / IA 対話状況 / rate_limits) を追加し、agent が委任先選定・割り込み回避・停滞検知を自律判断できるようにする。取得は server が envelope から蓄積した snapshot で完結し、初版は in-memory (session 開始日時のみ SessionStarts DETS を fallback 参照)。
status: draft
phase: 27
depends_on: [8, 21]
last_updated: 2026-07-28
---

# Phase 27 — list_agents に状況判断メタデータを追加

## Goal

[issue #160](https://gitea.example.invalid/sakurai.yuta/kaoiro/issues/160)
を実装する。`mcp__kaoiro__list_agents` が返す peer entry に稼働状況
6 field を追加し、エージェントが operator の介在なしに

- 残コンテキストが逼迫した peer に重い委任をしない
- 利用上限に張り付いた peer を避ける / 窓明けを待つ
- 長時間無活動の peer を避ける・報告する
- 対話中の peer への割り込みを控える

を判断できるようにする。設計判断はマスター決裁済み
(#160 issuecomment-2211 / -2213)。本 plan はその決定を実装可能な粒度に
落としたもので、決定そのものは変更しない。

## 確定済み前提 (変更禁止)

| # | 決定 | 出典 |
|---|---|---|
| P1 | 取得方式は server が envelope から蓄積した snapshot。wrapper への都度照会はしない | #160 comment-2211 (1) |
| P2 | turn 数 (応答往復数) も server 側で envelope から導出 | 同 (2) |
| P3 | 初版は永続化なし (in-memory、server 再起動でリセット許容)。セッション開始日時のみ既存 `session_starts` DETS の流用可否を調査 | 同 (3) |
| P4 | IA 対話状況は「active な会話の有無 + 相手 agent_id 一覧」まで agent 間に開示。ADR-0021 に agent 間開示の節を追記 | 同 (4) |
| P5 | 追加 field は 6 つ (残コンテキスト / セッション開始日時 / turn 数 / 最終活動時刻 / IA 対話状況 / rate_limits) | #160 本文 + comment-2213 |

## 現行実装経路の調査結果 (#160 明記事項 e)

`list_agents` は wrapper のローカル MCP tool で、実体は server への
`directory_request` 1 往復である。

```mermaid
flowchart LR
  M[model] -->|mcp__kaoiro__list_agents| T[InterAgentTools.listAgents]
  T --> R[ServerLink#requestDirectory]
  R -->|"directory_request {}"| WC[WrapperChannel]
  WC --> AS[AgentStates.snapshot]
  AS --> DE[directory_entry/2]
  DE -->|"{:ok, %{agents: []}}"| R
  R --> N[directoryEntryFrom で構造 narrow]
  N -->|JSON text| M
```

| 段 | 実体 | 現状 |
|---|---|---|
| tool 定義 | `wrapper/agent-common/src/inter_agent.ts` `descriptors()` / `listAgents()` / `LIST_AGENTS_DESCRIPTION` | 入力 schema は空オブジェクト。provider 未注入なら error result |
| 送信 | `wrapper/core/src/transport.ts` `ServerLink#requestDirectory` | `directory_request` を push、reply の `agents` を `directoryEntryFrom` で narrow |
| 型 | `wrapper/core/src/transport.ts` `DirectoryEntry` | `agent_id` / `persona` / `state` 必須、`engine` / `model` / `effort` optional。**`@kaoiro/protocol` ではなく `@kaoiro/wrapper-core` に居る** |
| 受信 | `server/lib/kaoiro_server_web/channels/wrapper_channel.ex` `handle_in("directory_request", …)` | `AgentStates.snapshot()` から自分を除外して `directory_entry/2` へ |
| 整形 | 同 `directory_entry/2` + `maybe_put_directory_field/3` | latest envelope の `persona` / `state` と `ext.engine` / `ext.model` / `ext.effort` のみ。non-empty string のときだけ載せる |

調査で判明した実装上の重要点:

1. **`AgentStates` は agent ごとに latest envelope 1 件しか持たない。**
   `ext` はその latest envelope のもの。Claude adapter は `#statusExt` を
   毎 state_change で lazy stamp する (ADR-0040 D2) ため
   `ext.context` / `ext.rate_limits` は最新 state_change に載っている。
2. **`log` / `result` / `inter_agent_message` は `append_log` 経路で、
   latest envelope を更新しない** (`store/1`)。よって turn 数・最終活動
   時刻を latest envelope から導出することはできない。ingest 点
   (`handle_in("envelope", …)`) での計測が必要。
3. **切断時の `disconnected` envelope は `ext` を `%{}` に落とす**
   (`AgentStates.disconnected_envelope/2`)。切断済み peer では
   `context` / `rate_limits` が自動的に消える。これは望ましい挙動なので
   そのまま利用する (stale 値を出さない)。
4. **`directoryEntryFrom` は entry を明示構築するので未知 field を落とす。**
   server だけ更新しても旧 wrapper では新 field が model に届かない。
   後方互換の観点で TS 側の narrow 拡張が必須。
5. **`ext` の viewer 除去は `AgentsChannel.sanitize_envelope_for/2` の
   責務で、`directory_request` は `WrapperChannel` の別経路**。つまり
   ADR-0021 の viewer 秘匿は本変更に一切かからない。逆に言えば agent 間
   開示は ADR-0021 が未定義の軸であり、追記が必要 (P4)。

### `session_starts` DETS の流用可否 (P3 の調査)

`KaoiroServer.SessionStarts` は `{agent_id, order, display, sid, pending}`
を DETS に持つ。`display` は ISO8601 で、session transition を server が
認識した時刻である。流用可否の結論は **「fallback としてのみ流用可、
primary source にはしない」**。

| 論点 | 事実 | 帰結 |
|---|---|---|
| カバー率 | `advance_transition/2` は `prior != nil and prior != new_sid` のときだけ発火 (`wrapper_channel.ex maybe_advance_session_boundary/2`) と、`SessionResets` の /clear・/new 経路のみ | **初回 spawn の agent には record が無い**。primary にすると新規 agent で常に欠損 |
| 意味 | `display` は「server が遷移を認識した時刻」。resume で同一 sid なら advance しないため、現セッションの開始時刻として整合的 | 意味論は流用可能 |
| 副作用 | record は `IngressOrder` を消費し、#109 clear watermark / #105 IA filtering の boundary order に効く | **書き込みを増やす改修は禁止**。read-only 参照に留める |
| 永続性 | DETS なので server 再起動を跨いで残る | in-memory tracker が失う情報を埋められる |

よって設計は hybrid とする (下記 D3)。in-memory tracker が
「初回 spawn を含む全ケース」を、`SessionStarts` が「server 再起動を
跨いだ復元」を、それぞれ相補的に埋める。

## Decision

### D1. wire schema — peer entry に 6 field を flat 追加

既存 entry (`agent_id` / `persona` / `state` / `engine?` / `model?` /
`effort?`) と同じ平坦構造に追加する。ネストしたグループは作らない
(既存 3 field と同じ読み方で済む)。

```json
{
  "agent_id": "lab-pc-1.claude-b",
  "persona": { "id": "ao", "name": "あお", "sprite_set": "ao" },
  "state": "idle",
  "engine": "claude-code",
  "model": "claude-opus-5",
  "effort": "high",
  "context": {
    "used_tokens": 132400,
    "max_tokens": 200000,
    "used_percentage": 66.2
  },
  "session_started_at": "2026-07-28T01:12:44Z",
  "turns": 17,
  "last_activity_at": "2026-07-28T03:41:09Z",
  "conversation": { "active": true, "peers": ["lab-pc-1.claude-a"] },
  "rate_limits": {
    "five_hour": {
      "status": "allowed",
      "utilization": 0.42,
      "resets_at": 1785200000
    },
    "seven_day": { "utilization": 0.71, "resets_at": 1785600000 }
  }
}
```

| field | 型 | 意味 | 欠損時 |
|---|---|---|---|
| `context` | `{used_tokens, max_tokens, used_percentage}` | 現セッションの context 使用量。**数値は `ext.context` と同一** (dashboard の ctx meter と同じ値であることを担保) | `ext.session_capabilities.supports_context_usage == true` **でない** engine (absent / explicit false)、`ext.context` 未到着、shape 不正、切断済みでは **field ごと省略** (D4 の capability gate) |
| `session_started_at` | ISO8601 (UTC) | 現セッションの開始を **server が観測した時刻** (wrapper 実測値ではない、裁定 O3) | server が現セッションの開始を観測しておらず `SessionStarts` からも復元できない場合は省略 |
| `turns` | 非負整数 | 現セッションの応答往復数 (定義は D2) | **tracker が当該セッションの開始を観測した (`session_start_observed == true`) 場合のみ返す。** `SessionStarts` fallback で `session_started_at` だけ復元した entry では省略する (開始日時は分かるが往復数は復元できないため、裁定 O2) |
| `last_activity_at` | ISO8601 (UTC) | server が当該 agent の envelope を最後に受理した時刻 | server 再起動後まだ 1 通も受けていない agent では省略 |
| `conversation` | `{active: boolean, peers: string[]}` | active な IA 会話の有無と相手 agent_id 一覧 | **常に含める** (server が必ず判定できるため、D5 参照) |
| `rate_limits` | `{<window>: {status?, utilization?, resets_at?}}` | 最終 turn 時点の利用上限 snapshot。window は `five_hour` / `seven_day` ほか engine 固有 | 未報告 engine / セッション、shape 不正、切断済みでは省略 |

`context` / `rate_limits` の **数値は換算しない**。残量や残り時間へ変換
すると dashboard 表示と値がずれ、#160 受け入れ基準「dashboard 側の表示と
矛盾しない」を破る。残量の解釈 (100 − `used_percentage`) は model に
委ねる。

ただし「数値を換算しない」ことと「`ext` の nested 構造をそのまま素通し
する」ことは **別である**。server は D4 の projection を通し、canonical な
key だけを写した新しい map を組み立てる。`ext` 由来の未知 nested key は
peer に出さない (F6-2 の allow-list を nested 階層まで適用する)。

### D2. turn 数 (応答往復数) の定義

**`type: "result"` の envelope を 1 件受理するごとに +1** とする。

- `result` は「1 回の SDK turn の完了」を表す envelope (ADR-0012) であり、
  両 engine が turn 完了時に emit する。operator 由来か peer 由来かに
  関わらず「入力 → 応答」の往復が 1 回閉じたことを意味する。
- `state: "error"` で終わった `result` も加算する。往復自体は成立して
  おり、疲弊度の指標としては同じ重みを持つ。
- `log` / `state_change` / `inter_agent_message` は加算しない。1 turn の
  中で任意個発生するため往復数にならない。
- resume 再生 (`history_reset` → JSONL replay) は `log` envelope なので
  自動的に加算されない。追加のガードは不要。
- server 合成 envelope (`disconnected` / `escalate-to-user`) は
  `result` ではないので加算されない。IA のハード制限 turn (server 側
  `ConversationStates.turns`) とは **別カウント** である点に注意。

#### 加算判定と reducer order (MUST)

1 envelope の処理は **必ず次の順で行う**。順序を入れ替えてはならない。

1. **transition / reset 判定** — 当該 envelope が新セッションの開始を
   示すか (D3 の L4)、あるいは explicit reset 後の sid adopt か
   (D3 の L5) を先に決める
2. **entry の初期化 / adopt** — 遷移なら `turns = 0` に初期化。adopt なら
   `session_started_at` を保持したまま `session_id` を埋めるだけ
3. **当該 envelope 自身の加算** — その envelope が `type: "result"` なら
   `turns` を +1、`last_activity_at` を受理時刻で更新

この順序が要るのは、**新セッションの最初の envelope が `result` である
ケース**があるため。3 → 1 の順だと初期化が加算を打ち消し、第 1 往復が
0 に消える。

加算対象の網羅表 (テスト要件):

| envelope | 加算 |
|---|---|
| `result` (正常終了) | +1 |
| `result` (`state: "error"`) | +1 |
| `log` / `state_change` / `question_request` / `permission_request` | 0 |
| `inter_agent_message` | 0 |
| resume replay の `log` 群 | 0 |
| server 合成 (`disconnected` / `escalate-to-user`) | 0 |
| **新 session の最初の envelope が `result`** | **+1** (0 ではない) |

### D3. server 側データモデル — `KaoiroServer.AgentActivity` (新設)

entry は
`agent_id => %{session_id, session_started_at, session_start_observed,
awaiting_sid, turns, last_activity_at}` の in-memory GenServer とする。
既存 `AgentStates` に相乗りさせない理由: `AgentStates` は「latest
envelope の保管庫」という単一責務で、履歴 ring / boundary patch /
disconnect race guard を既に抱えている。計測状態を混ぜると
put/append_log の分岐がさらに増える。

`ts` ではなく **server の受理時刻 / hook 実行時刻** を使う。`ts` は
wrapper ホストの時計であり、ホスト跨ぎのズレを判断材料に混ぜたくない
(protocol.md「ホスト跨ぎの時刻ズレに注意」)。

#### セッション lifecycle (MUST)

セッション境界は 6 ケースを区別する。**「wrapper の join ごとに reset」は
禁止** — 通常の reconnect と server 再起動後の復元を壊し、生きている
セッションの `turns` を毎回 0 に落とすため。

| # | ケース | 検知点 | 挙動 |
|---|---|---|---|
| L1 | fresh spawn | `AgentsChannel` の spawn コマンド発行点 | **seed** |
| L2 | /new・/clear | `SessionResets` の完了点 (既存の boundary 確定と同じ箇所) | **reset** |
| L3 | restore / resume | `resume_session` / restore コマンド発行点 | **reset** |
| L4 | server が関与しない session 変化 | envelope の `session_id` が **既知の非空値から別の非空値へ** 変化 | **reset** |
| L5 | lazy 采番の adopt | `awaiting_sid == true` の entry に非空 `session_id` が初到達 | **adopt** (reset しない) |
| L6 | 未知 agent の初 envelope | entry が無い | `session_start_observed = false` で entry 作成 |

- **seed / reset の内容**: `turns = 0`、`session_started_at` = hook 実行
  時刻、`session_start_observed = true`、`session_id = nil`、
  `awaiting_sid = true`。開始時刻を **先に確定** させ、実 sid は後から
  adopt する。
- **adopt (L5) の内容**: `session_id` を埋め `awaiting_sid = false` に
  するだけ。`session_started_at` と `turns` は **保持する**。
- **二重 reset の禁止 (MUST)**: `awaiting_sid == true` の間は L4 を
  発火させない。L1〜L3 の explicit reset 後に新 sid を載せた envelope が
  届いても、それは L5 の adopt であって新たな遷移ではない。Codex の
  lazy 采番 (reset 時点では sid が nil、最初の turn 完了後に確定) が
  この経路に乗る。
- L1 が必要な理由: fresh spawn は `nil → 非空 sid` であり L4 の条件
  (既知の非空 → 別の非空) に該当しない。かつ `SessionStarts` にも
  record が無い (advance_transition は `prior != nil` 条件下でしか
  発火しない) ため、L1 が無いと新規 agent の `session_started_at` /
  `turns` が永久に省略される。
- L3 が必要な理由: 通常の restore は **同一 SDK session_id を resume**
  するため、L4 (sid 変化) も L2 (SessionResets) も発火しない。#160 本文
  の「restore でリセット」を満たすには、server がコマンドを出した時点で
  明示 reset する必要がある。異なる sid での復帰も同じ hook で覆える。
- spawn / restore が失敗した場合 (`spawn_result` が fail) は seed した
  entry を削除する。成功しなかったセッションの開始時刻を残さない。

#### その他の更新契機

| 契機 | 更新 |
|---|---|
| 任意の envelope を受理 (validate / route / store 通過後) | `last_activity_at` を受理時刻で更新 |
| `type == "result"` | `turns` を +1 (順序は D2 の reducer order) |
| `AgentsChannel` の `delete_agent` | entry を削除 (既存の `AgentDirectory.delete` / `SessionStarts.delete` と同じ箇所) |

#### `session_started_at` の解決順序

1. `session_start_observed == true` → tracker の値を使う
2. そうでなく、`SessionStarts.get(agent_id)` の `sid` が当該 agent の
   現 `session_id` と一致する → その `display` を使う (server 再起動を
   跨いだ復元)
3. どちらでもない → **field 省略**、`turns` も併せて省略

`turns` は 1 の場合だけ返す。2 の fallback で開始日時が復元できても
往復数は復元できないため、0 から数え直した値を出さない (裁定 O2、
ADR-0040 の「推定値を出さない」作法の踏襲)。

#### 並行性ガード (MUST)

`AgentActivity` は ingest (WrapperChannel)・lifecycle hook
(AgentsChannel / SessionResets)・read (directory_request) の 3 系統から
触られる。次の 3 点を守る。

- **G1 — 記録対象の限定**: `record_envelope/2` は `validate/2` /
  `route_inter_agent/2` / `store/1` がすべて `:ok` を返した envelope に
  対してのみ呼ぶ。reject された envelope で entry を作ると、存在しない
  agent の orphan entry ができ、tracker の agent 数上限を独立に食い潰す
  経路になる。
- **G2 — 投影時の session 一致検査**: `directory_request` で
  session-specific field (`session_started_at` / `turns`) を載せるのは、
  **`AgentActivity` の `session_id` と `AgentStates` latest envelope の
  `session_id` が一致するときだけ**。不一致なら両 field を省略する。
  `record_envelope/2` は cast (下記 G3) なので両者は一瞬ずれうる。この
  検査でズレを **一時的な欠損** に閉じ込め、旧セッションの `turns` を
  新セッションの値として誤表示することを防ぐ。`awaiting_sid == true`
  の間 (`session_id = nil`) も不一致として扱い省略する。
  `last_activity_at` と `conversation` は session に紐づかないので本
  検査の対象外。
- **G3 — hook の同期性**: `record_envelope/2` は hot path なので cast
  (fire-and-forget)。同一 `WrapperChannel` プロセスからの cast は
  GenServer への到達順が保証されるので、同一 agent の envelope 間で
  順序は狂わない。一方 lifecycle hook (L1〜L3) は **別プロセス**
  (AgentsChannel / SessionResets) から出るため順序保証が無い。よって
  **lifecycle hook は synchronous call とし、reset の完了を待って
  から** spawn / reset / restore の後続処理へ進む。これで「reset より
  後に受理された envelope が reset 前の entry に加算される」経路を塞ぐ。

### D4. `context` / `rate_limits` の取得元と projection

一次ソースは `AgentStates.snapshot()` が返す latest envelope の
`ext.context` / `ext.rate_limits`。tracker には持たせない (二重の真実源
を作らない)。ただし **raw を素通ししない** — 下記の gate と projection を
通した新しい map を組み立てて載せる。

#### `context` は capability driven (MUST)

`ext.context` の **presence では判定しない**。次の条件をすべて満たす
ときだけ `context` を載せる:

1. latest envelope の
   `ext.session_capabilities.supports_context_usage == true`
   (boolean の `true`。absent / explicit `false` はいずれも非投影)
2. `ext.context` が到着済みで、`used_tokens` / `max_tokens` /
   `used_percentage` がすべて数値

presence-driven にできない理由: rolling upgrade 中の **旧 Claude
wrapper** は `ext.context` を stamp するが capability field を持たない。
dashboard は ADR-0040 D1 に従い capability absent で ctx 行を
**隠す** ため、presence-driven だと list_agents だけが値を公開し、#160
受け入れ基準「dashboard 側の表示と矛盾しない」を破る。3-state
(absent / false / true) の解釈を dashboard と揃える。

capability field 自体は peer に開示しない (F6-4 の deny 集合に
`session_capabilities` を残す)。gate の入力に使うだけである。`null` や
推定値を代入しないことは従来どおり (ADR-0040 D1/D3 踏襲、#160 明記事項
b)。

#### projection / validation (MUST)

`ext` は wrapper が自由に拡張できる open schema であり、そのまま流すと
将来 adapter が足した未知 nested key が peer directory の allow-list
(F6-2) を素通りする。server は **canonical key だけを写した新しい map**
を作る。

| 対象 | 許可する key | 検証 | 逸脱時 |
|---|---|---|---|
| `context` | `used_tokens` / `max_tokens` / `used_percentage` の 3 つのみ | すべて数値 | `context` field ごと省略 |
| `rate_limits` | 各 window の `status` / `utilization` / `resets_at` のみ | `status` = string、`utilization` = number、`resets_at` = integer。存在する key だけ検査 (3 つとも optional) | 当該 window を drop。他の window は残す |
| `rate_limits` の window key | open string (engine 固有 window を阻害しない) | 長さ ≤ 32、charset `[A-Za-z0-9_-]`、**window 数 ≤ 8** | 逸脱 window を drop。上限超過分は drop してログに残す (黙って落とさない) |

- 数値の **換算はしない** (D1)。projection は「写す key を絞る」操作
  であって値の加工ではない。
- **malformed は top-level field 単位で drop し、valid な sibling は
  残す**。例: `context` が壊れていても `rate_limits` は載る。
- 未知 nested key は写さない (allow-list を nested 階層まで適用)。
- 切断済み peer は `ext` が空になるため両方が自然に消える。stale な
  数値を peer に見せないという意味で正しい。
- 同じ規約を TS 側 narrow (`directoryEntryFrom`) にも適用する。server が
  新しくても旧 narrow が素通しする経路を作らないため、**両側で** テスト
  する (27-A5 / 27-B4)。

#### `resets_at` 経過時の解釈規約 (#160 明記事項 c)

`rate_limits` は **当該 peer の最終 turn 時点の snapshot** であり、
idle 中は更新されない。したがって:

- MUST: **peer directory の消費側 (`list_agents` を呼ぶ agent)** は、
  `resets_at` (Unix 秒) が現在時刻より過去である window を
  **窓が明けたものとみなし、`utilization` / `status` を信用しない**。
  この MUST の owner は agent 側であり、`LIST_AGENTS_DESCRIPTION`
  (27-B3) に明文で書いて model に伝える。
- **これは deterministic な強制ではない。** server も wrapper も判定を
  代行せず、model の解釈に委ねる best-effort な規約である。spec には
  その旨を正直に書く (強制されていると読める書き方をしない)。
- server は snapshot を加工せず、判定に必要な `resets_at` をそのまま
  渡す。server が窓明けを検知して field を削る案は採らない — server
  時計と engine 側の窓境界がずれた場合に「上限に達しているのに空に
  見える」という危険側の誤りを生むため。
- **dashboard 側の同等対応は本 phase の scope 外。**
  [#164](https://gitea.example.invalid/sakurai.yuta/kaoiro/issues/164) へ
  委譲する (クロエが #164 に scope 追記)。本 plan と spec は dashboard が
  既に実装済みであるかのように書かない。
- SHOULD: `last_activity_at` が古い peer の `rate_limits` は、その分だけ
  古い情報であると解釈する。両 field を並べて返すのはこのため。

### D5. IA 対話状況の導出 (`conversation`)

`KaoiroServer.ConversationStates` は
`conversation_id => %{agents: MapSet, …}` を保持している。ここに
**副作用のない read-only API** を 1 本追加する:

```elixir
@doc """
参加中の会話から `agent_id => [peer_agent_id]` の index を 1 回で返す。
値は重複排除済みのソート済みリスト。会話に参加していない agent は
key ごと現れない。
"""
def peer_index(server \\ __MODULE__)
```

- **per-peer に 1 call 張る API にはしない (MUST)**。`directory_request`
  1 回につき **batch snapshot を 1 call** だけ取り、呼び出し側で index を
  引く。`peers_of(agent_id)` を peer 数だけ呼ぶ設計は、上限値
  (agent 1,000 × conversation 10,000) で 1 回の `list_agents` が
  routing 用 GenServer を長時間占有する。`list_agents` は auto-allow の
  read-only tool で model が自由に叩ける経路なので、ここが詰まると
  inter-agent messaging 全体が停止する。
- index の構築コストが問題になるなら、`record_message/6` /
  GC / `drop/2` の各更新点で `agent_id => conversation_ids` の逆引きを
  維持する案に切り替えてよい (実装判断)。wire も呼び出し回数も変わら
  ない。
- `conversation_id` は **返さない**。P4 が明示した開示範囲が
  「active な会話の有無 + 相手 agent_id 一覧」であり、識別子はその範囲を
  **超える** ため。単に範囲外というだけで、#17 の機密性論点をここで
  先取りして判断したわけではない (trust boundary の再評価は
  ADR-0021 F6-6 の将来項目)。
- `claim_unreachable_targets/3` は notified フラグを立てる副作用がある
  ので流用しない。
- entry は done / ハード制限超過 / wallclock GC で消えるため、
  「active」の定義は「その時点で `ConversationStates` に entry がある」
  と一致する。GC 周期 (60 秒) 分の遅れは許容する。
- `conversation` は **常に載せる** (`{active: false, peers: []}` を含む)。
  他 5 field と違い engine 非依存で server が必ず判定できるため、
  「省略 = 不明」とする理由がない。旧 server では field ごと absent に
  なるので、消費側は absent と `active: false` を区別できる。

### D6. 後方互換 (#160 明記事項 a)

- 既存 field は一切変更しない。追加のみ。`version` 据え置き
  (ADR-0010 / ADR-0015 の未知キー追加規約)。
- 旧 wrapper × 新 server: `directoryEntryFrom` が新 field を落とす。
  entry 自体は今までどおり返るので機能低下のみ、破壊はしない。
- 新 wrapper × 旧 server: 新 field が来ないので narrow が optional として
  落とす。`conversation` も absent になり「不明」として扱われる。
- 追加 field は **すべて optional**。1 field の欠損が entry 全体の破棄に
  ならないよう、narrow は field 単位で判定する (既存
  `maybe_put_directory_field` / `for key of [...]` と同じ方針)。

### D7. `DirectoryEntry` 型の置き場所

現在 `DirectoryEntry` は `@kaoiro/wrapper-core`
(`wrapper/core/src/transport.ts`) にある。#160 本文の「共有型は
`@kaoiro/protocol` に追加する」は、この現状を踏まえると
**移動を伴う**。本 phase では移動しない:

- 移動は import 元の変更を wrapper 4 パッケージに波及させる純粋な
  リファクタで、6 field 追加とは独立している。
- server / dashboard は Elixir / 別型定義なので、protocol package に
  置く実利が現時点で無い。

新 field は既存 `DirectoryEntry` を拡張する形で `wrapper-core` に足す。
`@kaoiro/protocol` への移設が必要になったら別 issue とする
(→ Open items O1)。

## 影響範囲 (spec docs)

| doc | 差分方針 |
|---|---|
| `docs/specs/protocol-inter-agent.md` | 主戦場。「peer directory の情報境界 (#102)」節を 6 field 追加に合わせて書き直し、除外リストから `context` / `rate_limit` を外す。`directory_request` 行の entry shape を更新。コンパニオンツール表の `list_agents` 用途説明を更新。`conversation` の常時同梱 (D5) を Constraints に MUST として追加。`resets_at` 解釈規約 (D4) は **消費側 agent の MUST** として書き、deterministic に強制される仕組みではない旨も併記する (dashboard が実装済みと読める書き方をしない、#164 へ委譲)。`ext` からの projection 規約 (canonical key のみ、未知 nested key 非開示) を情報境界節に明記。`session_started_at` / `last_activity_at` は「**server が観測した時刻**」であり wrapper 実測値ではないと定義を明記する (裁定 O3) |
| `docs/specs/protocol.md` | L222 の `directory_request` 行が #102 の `engine`/`model`/`effort` 追加を反映しておらず既に drift している。本 phase で 6 field 込みの現行 shape に修正し、詳細は protocol-inter-agent へのポインタに寄せる (重複記述を作らない) |
| `docs/specs/threat-model.md` | 緩和策表と Constraints は viewer/operator 軸のまま。agent 間開示という第 3 の軸が入ったことを 1 行追記し、ADR-0021 の新節を参照させる |
| `docs/adr/0021-role-information-disclosure-policy.md` | F6「agent 間開示 (peer directory)」を追記。詳細は下記 |

### ADR-0021 追記案 (P4)

新規 ADR は **不要** と判断する。ADR-0021 の主題は「誰に何を見せるか」
の allow-list ポリシであり、agent という主体が増えるのは同じ主題の軸の
追加である。Decision の F1〜F5 は無効化されず (viewer/operator の
マトリクスは不変)、supersede にも当たらない。ADR-0021 に節を足すのが
単一情報源の原則に合う。

以下は 27-C1 でそのまま ADR-0021 の Decision 末尾へ挿入する実文案。
本 phase (設計) では ADR 本文には手を入れない — 未実装の決定を
accepted ADR に先行して載せると status が drift するため。

> ### F6: agent 間開示 (peer directory)
>
> F1〜F5 は client (dashboard) 向けの `agents:lobby` 配信を対象とする。
> [issue #160](https://gitea.example.invalid/sakurai.yuta/kaoiro/issues/160)
> で agent が peer の稼働状況を読んで委任判断を行う要求が生じたため、
> **第 3 の開示主体として `agent` を定義する**。
>
> **F6-1 — `agent` は `operator` の部分集合ではない。** operator が
> 見る経路 (`agents:lobby` / `AgentsChannel.sanitize_envelope_for/2`) と
> agent が見る経路 (`wrapper:<id>` /
> `WrapperChannel.handle_in("directory_request", …)`) は別実装であり、
> 片方の allow-list がもう片方を守らない。両者は独立に判断する。
>
> **F6-2 — peer directory も allow-list 方式。** `directory_entry/2` が
> 明示列挙した field だけが agent 間に出る。envelope の `ext` を丸ごと
> 流し込む実装は禁止する (F2 と同じ fail-closed)。allow-list は
> **nested 階層まで適用** する — `ext` 由来の構造体を載せる場合も
> canonical key だけを写した新しい map を組み立て、未知の nested key は
> 開示しない。
>
> **F6-3 — 現時点の allow 集合**: `agent_id` /
> `persona{id, name, sprite_set}` / `state` / `engine` / `model` /
> `effort` / `context` / `session_started_at` / `turns` /
> `last_activity_at` / `conversation` / `rate_limits`。
> 後半 6 field は #160 (phase-27) で追加。
>
> **F6-4 — 明示 deny (継続除外)**: `cwd`、`permission` (`sandbox` /
> `approval`)、`permission_mode` / `fast_mode`、`session_id`、
> `pending_permission` (特に `input`)、`pending_question`、
> `slash_commands`、`models` catalog、`resume_snapshot` /
> `resume_drift`、`model_source` / `effort_source`、
> `session_capabilities`、`cost`。委任判断に不要か、operator 固有の
> 作業内容を推測させるため。`session_capabilities` は
> `supports_context_usage` を `context` 投影の gate 入力として **server
> 内部で読むだけ** で、値そのものは peer に出さない。
>
> **F6-5 — `conversation` は相手 `agent_id` までを開示し、
> `conversation_id` は開示しない。** 開示範囲として決定されたのが
> 「active な会話の有無 + 相手 agent_id 一覧」(#160 決定 4) であり、
> 識別子はその範囲を超えるため。範囲外だから出さないという判断であって、
> [#17](https://gitea.example.invalid/sakurai.yuta/kaoiro/issues/17) の
> conversation_id 機密性についてここで結論を出したわけではない。信頼
> 境界そのものの再評価は F6-6 の将来項目に含める。
>
> **F6-6 — 妥当性の根拠と再評価条件。** 現状 kaoiro は単一 operator
> 配下の閉じた系であり、peer は同一の人間が起動した agent に限られる。
> 稼働状況の相互可視化による露出リスクは小さく、operator 介在の削減
> という便益が上回る。外部 inbound
> ([#98](https://gitea.example.invalid/sakurai.yuta/kaoiro/issues/98))
> 導入時、または agent 間の信頼境界が operator 単位でなくなった時点で
> 本節を再評価する。
>
> **F6-7 — 拡張手順。** peer directory に新 field を足すときは、F5 の
> viewer 判断と同様に **agent 開示の要否を明示判断** し、F6-3 / F6-4 の
> どちらかに列挙してからテストで両主体の可視性を covering する。

## タスク分割

server (Elixir) と wrapper/protocol (TS) で path が重ならないよう分割し、
2 名で並行実装できる形にする。**共有 working tree のため
`git add` は各自の担当 path のみを指定すること。**

### Track A — server (Elixir)

担当 path: `server/lib/**`, `server/test/**`

| Task | 内容 | 主な path |
|---|---|---|
| 27-A1 | `KaoiroServer.AgentActivity` 新設 (D3)。`record_envelope/2` (cast)、`start_session/2` / `reset_session/2` (**call**、G3)、`get/1`、`delete/1`。entry に `awaiting_sid` を持ち L5 adopt と L4 reset を判別。D2 の reducer order を実装。agent 数上限を持つ。`Application` の supervision tree へ登録 | `server/lib/kaoiro_server/agent_activity.ex`, `server/lib/kaoiro_server/application.ex` |
| 27-A2 | `ConversationStates.peer_index/1` 追加 (D5)。**batch で 1 call**、副作用なし、重複排除 + ソート。per-peer call 版は作らない | `server/lib/kaoiro_server/conversation_states.ex` |
| 27-A3 | lifecycle + ingest 配線 (D3 の L1〜L6)。spawn コマンド発行点 → `start_session/2` (L1、spawn 失敗時は `delete/1`)、`SessionResets` 完了点 → `reset_session/2` (L2)、`resume_session` / restore 発行点 → `reset_session/2` (L3)、`WrapperChannel.handle_in("envelope", …)` の **validate/route/store が :ok の後** → `record_envelope/2` (G1)、`delete_agent` → `delete/1` | `server/lib/kaoiro_server_web/channels/wrapper_channel.ex`, `server/lib/kaoiro_server/session_resets.ex`, `server/lib/kaoiro_server_web/channels/agents_channel.ex` |
| 27-A4 | `directory_entry/2` を 6 field 対応に拡張 (D1/D3/D4/D5)。**capability gate** (`supports_context_usage == true` のときだけ `context`)、**projection/validation** (canonical key のみ写す、window 数・key 長 bound)、**G2 の session 一致検査**、`SessionStarts` fallback (D3 解決順序 2)。省略規約は helper に集約 | `server/lib/kaoiro_server_web/channels/wrapper_channel.ex` |
| 27-A5 | テスト。`agent_activity_test.exs` 新設: **lifecycle 4 ケース** (fresh spawn / same-sid restore / different-sid restore / Codex の nil→sid adopt)、**新 session の最初が result で +1**、加算網羅表 (success/error result=+1、log・state_change・IA・resume replay・server 合成=0)、二重 reset しないこと、fallback、上限。`conversation_states_test.exs` に `peer_index/1`。`wrapper_channel_test.exs` に directory reply 検査: capability absent/false/true × context 有無の 4 組、projection (未知 nested key 非開示 / malformed top-level のみ drop / valid sibling 保持 / window 数超過 drop)、G2 不一致時の省略、`conversation` 常時同梱、切断後に `context`/`rate_limits` が消えること | `server/test/**` |

### Track B — wrapper (TypeScript)

担当 path: `wrapper/**` のみ。**`protocol/**` は触らない** — O1 で
`DirectoryEntry` の `@kaoiro/protocol` 移設を本 phase の scope 外と
確定したため、担当 path から外して accidental な scope 拡大を防ぐ。

| Task | 内容 | 主な path |
|---|---|---|
| 27-B1 | `DirectoryEntry` に 6 field を optional 追加 (D1/D7)。JSDoc に欠損規約 (省略 = 不明、`null` は出さない、`turns` 省略を 0 と読まない) を明記 | `wrapper/core/src/transport.ts` |
| 27-B2 | `directoryEntryFrom` の narrow 拡張。**server と同じ projection 規約を適用する** (D4): canonical key のみ採用、未知 nested key は写さない、malformed は top-level field 単位で drop して valid な sibling は残す。`context` は 3 数値 field、`rate_limits` は window ごとに `status`/`utilization`/`resets_at` の型検査 + window 数・key 長 bound、`conversation` は `{active: boolean, peers: string[]}` | `wrapper/core/src/transport.ts` |
| 27-B3 | `LIST_AGENTS_DESCRIPTION` を更新。追加 field の意味と、model が取るべき判断を記述: 残 context 逼迫 peer に重い委任をしない / **`resets_at` (Unix 秒) を現在時刻と比較し、過去なら `utilization`・`status` を信用しない** (D4 の MUST、owner は agent 側) / `conversation.active` な peer への割り込みを控える / `last_activity_at` が古い peer は停滞を疑う。**省略された field を「0」や「問題なし」と読まない** ことも明記 | `wrapper/agent-common/src/inter_agent.ts` |
| 27-B4 | テスト: `transport.test.ts` に narrow の正常系・malformed top-level のみ drop・valid sibling 保持・未知 nested key 非開示・window 数超過 drop、`inter_agent.test.ts` に list_agents 結果が新 field を欠落なく model へ渡すことの検査 | `wrapper/core/test/**`, `wrapper/agent-common/test/**` |

### Track C — docs (どちらかが実装完了後に一括)

| Task | 内容 | 主な path |
|---|---|---|
| 27-C1 | ADR-0021 に F6 節を追記 (上記骨子) | `docs/adr/0021-role-information-disclosure-policy.md` |
| 27-C2 | `protocol-inter-agent.md` の情報境界節・`directory_request` 行・コンパニオンツール表・Constraints 更新 | `docs/specs/protocol-inter-agent.md` |
| 27-C3 | `protocol.md` L222 の drift 修正 + ポインタ化、`threat-model.md` に agent 間開示軸の 1 行追記 | `docs/specs/protocol.md`, `docs/specs/threat-model.md` |
| 27-C4 | 本 plan の Progress 表と frontmatter (`status` / `last_updated`)、`docs/plans/README.md` の phase 27 行 (起案時に ⏳ で登録済み) を実状に更新 | `docs/plans/**` |

依存関係: 27-A1 → 27-A3 → 27-A4、27-A2 → 27-A4。Track B は Track A と
独立に着手できる (wire 定義 D1 が両者の契約)。Track C は A/B 完了後。

## Progress

| Task | 状態 | 内容 |
|---|---|---|
| 27-A1 | ⏳ | `AgentActivity` 新設 |
| 27-A2 | ⏳ | `ConversationStates.peer_index/1` (batch) |
| 27-A3 | ⏳ | lifecycle (L1-L3) / ingest / delete 配線 |
| 27-A4 | ⏳ | `directory_entry/2` 6 field 拡張 |
| 27-A5 | ⏳ | server テスト |
| 27-B1 | ⏳ | `DirectoryEntry` 型拡張 |
| 27-B2 | ⏳ | `directoryEntryFrom` narrow 拡張 |
| 27-B3 | ⏳ | `LIST_AGENTS_DESCRIPTION` 更新 |
| 27-B4 | ⏳ | wrapper テスト |
| 27-C1 | ⏳ | ADR-0021 F6 追記 |
| 27-C2 | ⏳ | `protocol-inter-agent.md` 更新 |
| 27-C3 | 🟡 | `protocol.md` L222 の #102 drift 修正のみ設計時に先行実施。`threat-model.md` の agent 間開示軸 1 行追記が未 |
| 27-C4 | 🟡 | README へ phase 27 行を登録済み。plan status の更新は実装後 |

## Acceptance Criteria

- [ ] `list_agents` の各 peer entry に 6 field が D1 の shape で含まれる

### context の capability gate (MF1)

- [ ] `supports_context_usage == true` かつ `ext.context` が valid な
      ときだけ `context` が載る
- [ ] `supports_context_usage` が **absent** の wrapper では、
      `ext.context` が到着していても `context` を **載せない**
      (旧 Claude wrapper の rolling upgrade。dashboard が ctx 行を隠す
      挙動と一致させる)
- [ ] `supports_context_usage: false` (Codex) では `context` が省略され、
      `null` も推定値も現れない (ADR-0040 踏襲)
- [ ] `session_capabilities` 自体は entry に含まれない

### セッション lifecycle (MF2)

- [ ] **fresh spawn**: 新規 agent の初セッションで `session_started_at` /
      `turns` が返る (永久省略にならない)
- [ ] **same-sid restore**: 同一 `session_id` を resume する通常の restore
      でも `turns` が 0 に戻り `session_started_at` が更新される
- [ ] **different-sid restore / resume**: 同上
- [ ] **/new・/clear**: 同上
- [ ] **Codex の lazy 采番**: explicit reset 後 `session_id` が nil の
      期間を経て sid が確定しても、`session_started_at` は reset 時刻を
      保持し、**二度目の reset は起きない** (`turns` が巻き戻らない)
- [ ] wrapper の通常 reconnect と server 再起動後の復元で reset が
      **起きない** (join ごと reset になっていない)

### turn カウント (MF3)

- [ ] 新セッションの **最初の envelope が `result`** のとき `turns == 1`
      になる (0 に消えない)
- [ ] `result` は正常終了 / `state: "error"` とも +1
- [ ] `log` / `state_change` / `inter_agent_message` / resume replay /
      server 合成 envelope は +0

### projection / validation (MF5)

- [ ] `ext.context` / `ext.rate_limits` に未知の nested key があっても
      entry には現れない
- [ ] malformed な top-level field だけが drop され、valid な sibling
      (例: `context` 不正時の `rate_limits`) は残る
- [ ] window 数・key 長の上限を超えた `rate_limits` の window が drop
      され、超過分がログに残る
- [ ] 同じ検査が **server と TS narrow の双方** にテストされている

### 欠損規約 / 並行性

- [ ] `rate_limits` を未報告の engine / セッションでは field ごと省略される
- [ ] 切断済み peer では `context` / `rate_limits` が消える
- [ ] `conversation` は常に含まれ、会話が無ければ
      `{active: false, peers: []}` になる。`conversation_id` は含まれない
- [ ] server 再起動直後、まだ envelope を受けていない agent では
      `turns` / `last_activity_at` / `session_started_at` が省略される
      (0 や現在時刻で埋めない)
- [ ] `SessionStarts` に現 `session_id` の record がある agent では、
      server 再起動後も `session_started_at` が復元される。ただし `turns`
      は復元されず省略される (裁定 O2)
- [ ] `AgentActivity` の `session_id` と latest envelope の `session_id`
      が不一致のとき、`session_started_at` / `turns` が省略される (G2)
- [ ] reject された envelope で tracker entry が作られない (G1)

### 互換 / 一貫性

- [ ] 旧 wrapper (narrow 未更新) が新 server に `directory_request` を
      投げても entry が壊れず、既存 field で従来どおり動作する
- [ ] `context` / `rate_limits` の数値が dashboard の ctx meter /
      rate 行と一致する (#160 受け入れ基準)
- [ ] `list_agents` 1 回あたり `ConversationStates` への call が 1 回
      (peer 数に比例しない、A1)
- [ ] ADR-0021 に F6 が追記され、明示 deny 集合が列挙されている
- [ ] `server && mix test` / `wrapper && pnpm test` / `pnpm typecheck` が
      pass

## Non-goals

- 永続化 (turn 数・最終活動時刻の DETS 保存)。P3 により初版は in-memory。
  必要になれば後続 issue。
- `conversation_id` の agent 間開示。P4 が定めた開示範囲を超えるため
  (#17 の機密性そのものを本 phase で判断はしない)。
- capability を持たない engine への残コンテキスト推定値の投影
  (ADR-0040 で不採用済み)。
- `DirectoryEntry` 型の `@kaoiro/protocol` への移設 (D7、裁定 O1)。
- dashboard 側の表示追加。本 phase は agent 間 wire のみ。
- **dashboard 側の `resets_at` 経過判定**。D4 の MUST は peer-directory
  の消費側 (agent) に限定し、dashboard の同等対応は
  [#164](https://gitea.example.invalid/sakurai.yuta/kaoiro/issues/164) へ
  委譲する。

## Risks / 注意

| 項目 | 内容 |
|---|---|
| #164 との依存 | [#164](https://gitea.example.invalid/sakurai.yuta/kaoiro/issues/164) (claude 5h が常に 0% / claude 7day 未表示 / codex 7day 非表示) は **同一データ源**。#164 未修正のまま本 phase を検収すると `rate_limits` の受け入れ検証ができない。#164 の修正完了を検収の前提とする |
| 計測の hot path | `record_envelope/2` は全 envelope 受理で走る。GenServer call を毎回張ると ingest がボトルネックになりうる。`AgentDirectory.touch/1` と同じく **cast** で実装し、read 側 (`directory_request`) と lifecycle hook だけ call にする (G3)。cast による staleness は G2 の session 一致検査で一時欠損に閉じ込める |
| auto-allow 経路の負荷 | `list_agents` は broker 承認を経ない auto-allow tool なので model が自由に叩ける。`ConversationStates` への問い合わせを peer 数に比例させると、routing 用 GenServer を塞いで inter-agent messaging 全体を止めうる。**directory 1 回につき call 1 回** の batch API に固定する (D5) |
| tracker の上限 | `AgentStates` と同じく agent 数上限を持たせる。未認証 wrapper が捏造 agent_id で map を膨らませる経路を塞ぐ |
| GC 周期の遅れ | `conversation.active` は `ConversationStates` の GC (60 秒周期) に従うため、wallclock 超過直後の最大 60 秒は active に見えうる。判断材料としては許容範囲だが spec に注記する |
| 時計 | `last_activity_at` / `session_started_at` は server clock。peer の `ts` (wrapper ホスト clock) と混ぜない |

## 裁定済み論点 (2026-07-28、クロエ経由でマスター裁定)

起案時の Open items 3 点は起案者推奨どおり確定した。以降は決定事項として
扱う (再提起不要)。

| # | 論点 | 裁定 |
|---|---|---|
| O1 | #160 本文の「共有型は `@kaoiro/protocol` に追加」と現状 (`DirectoryEntry` は `wrapper-core` 在) の食い違い | **本 phase は `wrapper-core` 拡張に留める** (D7 のとおり)。`@kaoiro/protocol` への移設は別 issue 化 (クロエが起票)。Track B の工数は現行見積のまま |
| O2 | `turns` の省略条件 (D3)。再起動後は `last_activity_at` だけ出て `turns` が無い状態が発生する | **observed するまで省略**。「0」と偽るより欠落が正しい。数値の連続性より正確さを優先 |
| O3 | `session_started_at` の fallback (`SessionStarts.display`) は wrapper のセッション開始時刻と厳密には一致しない | **許容**。ただし spec (27-C2) に「**server が遷移を観測した時刻**」と定義を明記すること。実測値ではないと読み手が判別できる形にする |

## 設計レビュー反映履歴

ふじ 設計レビュー (a9688bd 対象) の must-fix 6 件 / advisory 7 件を反映
した。対応箇所は次のとおり。

| 指摘 | 内容 | 反映先 |
|---|---|---|
| MF1 | `context` の gate を presence-driven から capability-driven へ戻す | D4「`context` は capability driven」、D1 の欠損時列、AC「context の capability gate」 |
| MF2 | fresh spawn / same-sid restore を取りこぼす lifecycle | D3「セッション lifecycle」(L1〜L6)、AC「セッション lifecycle」、27-A1 / 27-A3 / 27-A5 |
| MF3 | reducer order の pin と二重 reset 禁止 | D2「加算判定と reducer order」、D3 の L5、AC「turn カウント」 |
| MF4 | cross-GenServer race のガード | D3「並行性ガード」(G1 / G2 / G3)、AC「欠損規約 / 並行性」、Risks |
| MF5 | `ext` raw 素通しの disclosure boundary 違反 | D4「projection / validation」、D1 末尾、ADR-0021 F6-2、AC「projection / validation」、27-A4 / 27-B2 |
| MF6 | `resets_at` MUST の owner 不在 (選択肢 b 採用) | D4「`resets_at` 経過時の解釈規約」、Non-goals、27-B3 |
| A1 | `peers_of` の per-peer call を batch 1 call へ | D5、27-A2、Risks「auto-allow 経路の負荷」 |
| A2 | `turns` 欠損表現を裁定 O2 と一致させる | D1 の欠損時列 |
| A3 | `conversation_id` 非開示の根拠を P4 の開示範囲へ | D5、ADR-0021 F6-5、Non-goals |
| A4 | Track B の担当 path から `protocol/**` を外す | タスク分割 Track B |
| A5 | 27-C3 の進捗を ✅ → 🟡 | Progress |
| A6 / A7 | 後方互換 matrix・`SessionStarts` read-only fallback・protocol.md drift 修正は追認 | 変更なし (D6 / D3 / 影響範囲表のまま) |

なお ふじ のレビューは a9688bd 固定で、裁定反映 (02f9ad7) は対象外
だった。両者の整合を確認済み — 裁定 O1〜O3 は must-fix と衝突せず、
A2 / A3 / A4 はむしろ裁定内容を各節へ波及させる指摘だったため、
同じ方向で統合してある。

## References

- [issue #160](https://gitea.example.invalid/sakurai.yuta/kaoiro/issues/160)
  — 本 phase の起点。決定は comment-2211 / -2213
- [issue #164](https://gitea.example.invalid/sakurai.yuta/kaoiro/issues/164)
  — rate_limits 表示不具合 (同一データ源、検収の前提)
- [issue #17](https://gitea.example.invalid/sakurai.yuta/kaoiro/issues/17)
  — conversation_id 機密性の論点
- [ADR-0040](../adr/0040-context-usage-capability.md) — capability driven
  な context 表示、推定値を出さない作法
- [ADR-0021](../adr/0021-role-information-disclosure-policy.md) —
  情報開示ポリシ (本 phase で F6 を追記)
- [ADR-0010](../adr/0010-protocol-precisification.md) /
  [ADR-0015](../adr/0015-protocol-version-stamping.md) — 未知キー追加と
  version 据え置きの規約
- [protocol-inter-agent](../specs/protocol-inter-agent.md) — peer
  directory の情報境界 (#102)
- [phase-8-inter-agent-messaging](phase-8-inter-agent-messaging.md) —
  directory_request の初出
