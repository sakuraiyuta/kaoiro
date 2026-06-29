---
title: ホスト常駐 runner — supervisor 専任・1 process=1 agent・TS/Node 単一バイナリ
status: accepted
date: 2026-06-24
opened: 2026-06-23
supersedes: []
superseded_by: null
related_specs: [architecture, protocol, threat-model, setup-wizards]
related_adrs: [2, 14, 18, 24]
---

# ADR-0023 — ホスト常駐 runner のアーキテクチャ

## Status

Accepted

## Context

現行トポロジ([ADR-0002](0002-local-wrapper-websocket-topology.md))は「1 AI
エージェント = 1 wrapper が各自で直接 kaoiro サーバへ WebSocket 接続」。これは
wrapper をどこで動かしどう繋ぐか(トポロジ)だけを決めており、**ホスト単位の
ライフサイクル管理は未定義**。結果として:

- wrapper(エージェント)が落ちると UI は disconnected を見るだけで再起動手段がない。
- 新しいエージェントを UI から追加起動する経路がない(人が手でホストに入る)。
- ホスト単位で「今何体動いているか / 動かせるか」を取りまとめる主体が不在。

各ホストに常駐プログラム(runner)を 1 つ置き、サーバと wrapper の間でホスト内
エージェント群のライフサイクルを担わせる。issue
[#23](https://gitea.example.invalid/sakurai.yuta/kaoiro/issues/23) で複数案を比較し、
本 ADR の決定(D1-D4)に収束した。

### 現行コードの実態(地盤、2026-06-23 調査)

- spawn / stop / restart は**未実装**(server の client→wrapper 制御は instruction /
  permission_decision / interrupt / clear_history / delete_agent のみ)。
- サーバ側に**「ホスト」概念が無い**(管理は agent_id 単位、SessionPointers も
  `agent_id => {session_id, cwd}` のみで host を捨象)。
- **多重起動防止は不完全**(owner フェンシングは re-join 時のみ、別プロセスの同
  agent_id 接続は last-write-wins で上書き → runner ローカルロックが本体、
  [ADR-0014](0014-session-resume-and-restore.md) F4)。
- **1 wrapper = 1 process が深く根付く**(AgentHost が完全プロセス私有状態)。

## Decision

### D1 — runner ↔ wrapper の関係 = supervisor 専任

runner は**プロセスのライフサイクル(spawn / stop / restart / 監視)と session
列挙だけ**を担う管理層とする。wrapper は**従来どおり** `wrapper:<agent_id>` で
サーバへ直結し、データ経路(共通イベント)は runner を通さない。すなわち
**[ADR-0002](0002-local-wrapper-websocket-topology.md) の直結トポロジは維持**し、
本 ADR はその上に監督層を**追補**する(supersede ではない)。

runner が接続を終端して wrapper 群を多重化(proxy)する案 D1=B は、runner が
データ経路の単一障害点になり、agent 非依存原則・現行 transport と緊張するため
採らない。

### D2 — プロセスモデル = 1 wrapper = 1 agent = 1 process

runner は N 個の wrapper プロセスを spawn・監督する(CI runner 型)。1 体が
クラッシュしても他は無事(隔離)。複数 agent を 1 プロセスに内包する案 D2=B は
隔離を失い AgentHost の大改修を要するため採らない。

### D3 — 実装言語 / 形態 = TypeScript / Node、単一バイナリ `kaoiro-runner`

D1=A / D2=A なら runner は「Node 子プロセスを監督するだけ」であり、wrapper と
config / 制御 envelope の**型を共有**できる利得が大きい。配布は
[ADR-0018](0018-runner-distribution.md) に従い OS 別単一バイナリ(bun / Node SEA
等)。バイナリ名は `kaoiro-runner`。堅牢性最優先で Go/Rust も一案だが、三言語目の
導入と型共有の喪失を避ける。

### D4 — 命名 = runner

仮称 `runner` を正式名称とする(doc 全体で既に浸透)。`supervisor` は OTP
Supervisor と語が衝突するため不可。`kaoirod` は採らない。

### runner の責務(仕様)

- サーバへ恒常接続し、自**ホストを登録**(生存・稼働可能ペルソナを束ねて提示)。
- サーバ経由の operator 指示で、ホスト内エージェントの **spawn / stop / restart**
  を実行。
- ホスト内の wrapper / エージェント群を**取りまとめ**、状態をサーバへ束ねて見せる。
- ホストや wrapper が落ちても runner は生き続け、**復旧の起点**になる
  ([ADR-0014](0014-session-resume-and-restore.md) の生存単位)。
- 復帰・召喚時に当該 cwd 配下の session JSONL を**列挙**し、resume 起動する。
- **二重起動防止のローカルロック**(同一 session の同時 resume を物理阻止、
  [ADR-0014](0014-session-resume-and-restore.md) F4)。

### 不変条件(脅威制約、[threat-model](../specs/threat-model.md))

UI からのリモート spawn は実質リモートコード実行(issue #22)。runner はその
実行点となるため、spawn / 指示は **operator 限定**、resume 対象 session_id は
当該 agent 束縛 cwd 配下に**実在検証**(T1/T2/T3、ADR-0014 F6)。

### 制御メッセージスキーマ(#66、2026-06-24 追補)

[#66](https://gitea.example.invalid/sakurai.yuta/kaoiro/issues/66) で runner ↔ server
制御メッセージを確定(schema 本体は [protocol](../specs/protocol.md)「runner 制御
メッセージ」、本 ADR は決定の記録)。

- **トピック**: 専用 `runner:<host_id>`(データ経路 `wrapper:<agent_id>` と別系統)。
  既存 `wrapper:` 系への相乗りは role gate / `agents:lobby` 購読不変条件(#27)を
  複雑化するため却下。
- **形式**: 既存制御と同じ **Channels イベント方式**。envelope `type` 追加は観測
  データ用の枠を制御へ流用することになり却下。
- **認証**: ホスト別トークン(env `host_id:token`、
  [ADR-0011](0011-phase3-reliability-and-auth.md) の per-entity トークン主義を拡張)。
  host_id は設定固定。共有トークン 1 本は漏洩時に全ホスト交換が要るため却下
  (ADR-0011 と同じ判断)。
- **version**: 新メッセージ種別の追加は前方互換のため `"0"` 据え置き
  ([ADR-0015](0015-protocol-version-stamping.md))。
- **二重起動**: server owner フェンシング + runner ローカルロックの二段
  ([ADR-0014](0014-session-resume-and-restore.md) F4)。spawn 競合は
  `spawn_result.reason = already_running` で返す。

### TS パッケージ・トポロジ(#68 着手前、2026-06-24 追補)

D3 の「wrapper と型を共有」を、**複数 wrapper を前提**に具体化する。wrapper は
当面 Claude Code CLI 版のみだが、将来 codex 版・ホスト状態取得 / クライアント提供版
を**別パッケージ**として追加予定。同一 protocol / envelope を話す TS consumer が
3 つ以上に増えるため、各実装が protocol.md から型を**自前コピー**する現行流儀
(wrapper / dashboard が各々保持)は drift が線形に増え、SSOT を型レベルで破る。

決定:

- リポジトリルートに最小 **pnpm workspace** を導入し、共有パッケージ
  **`@kaoiro/protocol`** を切り出す。中身 = envelope / 制御メッセージ / agent 状態型
  - **全 wrapper 共通の spawn / CLI 契約**。これを TS 側の SSOT とする。
- 現 `@kaoiro/wrapper`(= Claude 版)は protocol 関連型を共有パッケージへ移して
  参照に切替。**リネームは codex 版追加時まで先送り**(今は型抽出のみ、挙動不変)。
- runner(`@kaoiro/runner`)および将来の wrapper 群はこの共有パッケージを consume。
- **適用範囲は Node 側に限定**。dashboard(`server/assets`)は別ビルド系のため
  本作業では据え置き(独自 `protocol.ts` 継続、整合は将来別件)。
- 単一バイナリ([ADR-0018](0018-runner-distribution.md))への複数 wrapper バンドル
  方式は隣接論点として配布フェーズ([#70](https://gitea.example.invalid/sakurai.yuta/kaoiro/issues/70))で詰める。本決定は型 / パッケージ構造のみ。

## Consequences

### Positive

- 現行 transport 無改修で済み、runner は純粋な管理層に保てる(ボトルネック無し)。
- クラッシュ隔離(1 体落ちても他は無事)。wrapper の既存コードを活用できる。
- wrapper と型(config / 制御 envelope)を共有でき、実装コストが低い。
- ADR-0002 を壊さないため、直結データ経路の決定が一箇所に残る(記録の単純さ)。

### Negative

- 二重起動防止に server owner フェンシング + runner ローカルロックの**二段**が要る。
- runner プロセスあたりメモリは 1:1 モデルのため大きめ。
- 制御 envelope(spawn / stop / restart / enumerate-sessions)を新規定義する必要が
  ある(#66 で確定、[protocol](../specs/protocol.md)「runner 制御メッセージ」)。

### Neutral

- runner の配布・常駐形態は [ADR-0018](0018-runner-distribution.md) に従う(単一
  バイナリ・CLI のみ)。
- ホスト非 ephemeral・agent_id ↔ cwd 固定の前提に依存
  ([ADR-0014](0014-session-resume-and-restore.md))。

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
| D1=B: runner が接続を終端・多重化(proxy) | データ経路の単一障害点・transport 大改修・agent 非依存原則と緊張 |
| D2=B: 1 プロセスに複数 agent を内包 | 1 クラッシュで全滅・AgentHost の大改修・隔離喪失 |
| D3=b: Elixir で実装 | BEAM 同梱が重くホスト常駐に過剰 |
| D3=c: Go / Rust で実装 | コードベース三言語目・wrapper と型共有不可(堅牢性最優先なら再考余地) |
| 命名 `supervisor` | OTP Supervisor と語が衝突 |
| ADR-0002 を supersede | D1=A で直結トポロジは維持されるため、supersede は記録上ミスリード(却下案 D1=B を指す)。amend が正確 |

## Related

- 改訂(追補)対象: [ADR-0002](0002-local-wrapper-websocket-topology.md)(直結
  トポロジは維持、本 ADR で監督層を追加)。
- 関連 ADR: [0014](0014-session-resume-and-restore.md)(runner を生存単位とする
  resume / 召喚)、[0018](0018-runner-distribution.md)(runner の配布)。
- 関連 specs: [architecture](../specs/architecture.md)、
  [protocol](../specs/protocol.md)(制御メッセージ)、
  [threat-model](../specs/threat-model.md)。
- 制御スキーマ: #66 で確定(上記「制御メッセージスキーマ」、
  [protocol](../specs/protocol.md)「runner 制御メッセージ」)。
- 実装: Phase 4([phase-4-host-runner](../plans/phase-4-host-runner.md))。
- 由来: issue [#23](https://gitea.example.invalid/sakurai.yuta/kaoiro/issues/23)。
