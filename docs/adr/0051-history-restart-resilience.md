---
title: 表示履歴の再起動耐性 — reconnect replay・IA sidecar・epoch 置換
status: accepted
date: 2026-08-08
opened: 2026-08-08
supersedes: []
superseded_by: null
related_specs: [protocol, protocol-inter-agent, architecture, deployment]
related_adrs: [12, 14, 30, 36]
---

# ADR-0051 — 表示履歴の再起動耐性 — reconnect replay・IA sidecar・epoch 置換

## Status

Accepted(2026-08-08。ふじ仕様レビュー 2 巡(must-fix 計 10 件)を
全反映して approve、マスター最終承認済み)

## Context

### dogfood での観測(2026-08-08)

server の docker container 再起動後、operator 端末間で表示が不一致に
なる事象を観測した:

- 再起動前から開きっぱなしの dashboard タブは、client 側 merge
  (`projectAndMergeHistory`)が local バッファを温存するため、server に
  もう存在しない再起動前ログを表示し続ける(亡霊表示)。
- 新規に開いたタブはほぼ空(揮発リングバッファが消えたため)。
- 直近の作業ログは、wrapper を resume 起動しない限りどの端末にも
  戻らない。

### 要件の明確化(マスター判断 2026-08-08)

- どの operator 端末でも同一の画面・ログが見えること。
- F5 リロードで、自身の送信・agent の返信・IA メッセージを含めて
  元通り表示されること。
- 上記が server 再起動を跨いでも成立すること。
- 一方で server が抱える durable 状態は削れるだけ削ること。履歴の
  正本は wrapper ホスト側の記録(engine transcript + 本 ADR で新設
  する IA sidecar)に置く。

現行仕様([ADR-0014](0014-session-resume-and-restore.md) A4)は
「server 稼働中」はこの要件をほぼ満たすが、再起動耐性がスコープ外
だった。全履歴の server 永続化
([#24](https://gitea.example.invalid/sakurai.yuta/kaoiro/issues/24))は
不採用のまま維持する(本 ADR でも変えない)。

### 記述 drift の訂正

ADR-0014 は「`inter_agent_message` は SDK へ注入された整形済み user
text から routing metadata を逆算できず、JSONL から再構築できない」
とし、これを根拠に server の DETS-backed `InterAgentHistory` を正本に
した(issue #105)。現行実装では受信側注入 framing に
`conversation_id` / `turn_number` / kind / sender / body が全て含まれ
ており(`formatInboundMessage`)、「逆算不能」は実装と drift した
記述である。ただし表示・モデル向けテキストのパースを復元手段に
すること自体は脆く(書式変更で過去履歴が読めなくなる・誤パース)、
採らない(Alternatives 参照)。

## Decision

### D1 — 履歴正本は wrapper ホストの composite SSOT(A4 拡張)

会話履歴の正本は wrapper ホストに置く **composite SSOT** とする:

- 通常 transcript: engine transcript(Claude Code =
  `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`、Codex =
  rollout file)。
- 構造化 IA: engine transcript と同居する **IA sidecar**(D3)。

server の表示履歴は「捨てても wrapper ホストから再構築できる揮発
投影」のままとする。issue #24(server 全履歴永続)は引き続き不採用。
server の durable 状態は最小化する — 本 ADR で `InterAgentHistory`
DETS を撤廃し(D3)、durable な表示系状態を追加しない
(`ClearWatermarks` は既存のまま維持、D3-4 参照)。

### D2 — hydration handshake による replay(server 主導)

server は agent 投影の **hydration 状態**を投影 lifecycle 内
(AgentStates、boot 毎に揮発)で管理し、それを根拠に replay を要求
する。「表示履歴が 0 件かどうか」を trigger にしない — partial
replay(reset 後に数件送って切断)で非ゼロのまま未完了確定する
取りこぼしがあるため。

- **状態**: agent 毎に `unhydrated` /
  `in_flight(replay_id, channel_owner)` / `hydrated` を持つ。boot 時
  は全 agent `unhydrated`。
- **join handshake**: wrapper channel join の応答(または join 直後
  の hydration control)で、server が **replay 要否 + server 採番
  `replay_id`** を確定して返す。新 server に対する wrapper は、この
  verdict を受けてから replay を開始する(現行の startup 無条件
  replay は新 server 相手には行わない — 「無条件 startup replay」と
  「hydrated なら無駄 replay なし」は wrapper が要求の有無を事前に
  知れない以上両立しないため)。
  - `required: false`(hydrated)→ replay しない。server 生存中の
    通常再接続で無駄 replay が走らないことが wrapper の事前知識
    なしで成立する。
  - `required: true` → 返された `replay_id` を `history_reset` /
    `replay_ia` / `history_replay_complete` で**一貫使用**する。
    dashboard の reset/complete pairing と server の hydration 遷移
    が同一 ID を参照し、ID の曖昧さによる race を残さない。
- **legacy fallback**: join 応答に verdict が無い(旧 server、
  capability absent)場合のみ、従来どおり wrapper 採番 ID で startup
  replay を行う。
- **完了遷移は CAS**: `history_replay_complete` の replay_id と
  channel owner が `in_flight` の記録と一致する場合のみ `hydrated`
  へ遷移する。`in_flight` のまま当該 owner の channel が切断されたら
  `unhydrated` へ戻し、再接続時に再要求する。stale な旧 connection
  の terminate / complete は CAS で無視され、新 connection の
  attempt を巻き戻さない。
- **fresh session**: session_id 未採番 / transcript 不在の場合、
  wrapper は空 replay(`history_reset` → 即
  `history_replay_complete`)で応答し、server は `hydrated` に
  できる。
- **wrapper 側 single-flight**: 1 attempt のみ実行し、実行中に別
  要求が来たら実行中 attempt の完了で応答する。

replay 対象は現 session 分のみ。過去 session(`/new`・`/clear`
以前)の再構築はスコープ外(受容した制約、D7)。両 engine とも
transcript replay 実装は既存(`wrapper/claude-code/src/history.ts` /
`wrapper/codex/src/history.ts` + `rollout.ts`)。

### D3 — IA sidecar による `InterAgentHistory` DETS 撤廃

#### D3-1 per-pane projection contract(live / replay 共用)

server の IA 揮発投影を **per-pane projection/upsert API** に一本化
し、live ingress(通常の IA accept)と replay ingress(D3-3 の
`replay_ia`)が同じ contract を共用する。DETS 撤廃後の live 表示 /
F5 復元はこの投影が担う(現行の「AgentStates sender history +
DETS fan-out」構成の置き換え)。

- **live accept 時**: server は validate → **ingress stamp 採番** →
  sender pane + receiver pane へ同一 stamp で upsert → routing
  (peer push)の順に処理する(stamp 採番と投影反映は
  `route_inter_agent` の peer push より**前**。この因果順を spec で
  固定する)。ここでの validate には participant / quota 等の routing
  preflight を含め、**reject が確定し得る検査は全て projection
  upsert より前**に置く。upsert 後に行う routing は peer push のみ
  とし、reject 済み IA が pane に残らないことを protocol 文面
  (30-2)と server test で pin する(ふじ 2 巡目 approve 時の
  非 blocking 注意)。
- server 合成 envelope(`agent_id: "server"` のエラー直送通知)は
  recipient pane のみへ upsert する。
- clear filter(D3-4)と最終 pane cap(D6)もこの経路上で適用され、
  live / replay で挙動差を作らない。
- **upsert identity は `ingress_stamp|pane_agent_id`**。同一 IA の
  sender/receiver copy は stamp を共有し pane だけ異なる。replay
  retry は同一 key への upsert で冪等。`conversation_id|turn_number`
  は identity に使わない — server 合成通知は常に turn_number=0 で、
  同一 conversation・同一 pane に複数回発生し衝突するため
  (Alternatives 参照)。

#### D3-2 記録(sidecar への append)

wrapper は `inter_agent_message` の構造化 envelope を、server が採番
した ingress stamp ごとローカル sidecar file へ append する(engine
transcript と同じディレクトリ、`<session-id>.ia.jsonl` 相当。正確な
パス・schema は protocol-inter-agent 改訂で確定)。

- **受信側 pane**: server からの配信を受けた時点(SDK 注入の前)で
  append する。配信 envelope には D3-1 で採番済みの stamp が載って
  いる。注入失敗時に sidecar だけ残る phantom は受容する(配信
  された事実の記録として妥当)。server 合成 envelope も受信側として
  同様に記録される。
- **送信側 pane**: **transport(Phoenix push)の acceptance ack**
  で記録する。server は validate → stamp 採番 → per-pane projection
  反映 → routing accept の後、当該 push への reply として
  `{ingress_stamp}` を返し、wrapper は **ack 到着時点で** append
  する。MCP tool result(`send_to_agent` の応答)は server ack とし
  ては使わない — 現行実装の tool result はローカル生成文字列であり、
  `wait_for_response=true` では peer reply / timeout まで返らない
  ため、そこまで append を遅らせると session generation を跨ぎ得る
  (ふじ 2 巡目 must-fix 3)。MCP の peer reply 待ちは別 promise の
  まま。reject / timeout / ack 喪失時は sidecar に記録せず、tool
  result にその旨を表示する(loss は受容、stderr warn で露出)。
- 破損・途中切れの末尾行は skip + stderr warn(fail-soft)。fsync は
  要求しない。sidecar パスは transcript ディレクトリ固定・
  session_id はサニタイズ・symlink は辿らない。

#### D3-3 復元(replay 専用 ingress)

sidecar の復元は **display replay 専用の W→S ingress** で行い、通常
の `envelope` 経路は使わない。通常経路は `route_inter_agent` により
宛先 wrapper への再 push → SDK 再注入を引き起こし、履歴復元ではなく
会話の再実行になるため(ふじ 1 巡目 must-fix 1)。また受信側が保存
した sender 名義の envelope は `agent_id != topic` guard で送れない。

- 新設メッセージ(名称は protocol 改訂で確定。例: `replay_ia`)は
  replay stream 内で `{pane_agent_id, original_envelope,
  ingress_stamp, replay_id}` を運ぶ。`replay_id` は D2 の server 採番
  ID。
- server は topic の wrapper が pane 所有者であることを検証した上で
  D3-1 の projection contract に upsert する: routing・
  ConversationStates・peer wrapper push・SDK injection には一切
  触れない。
- **pane ownership**: 各 wrapper は自分の sidecar から自分の
  pane-local view のみを復元する(sender pane は sender の sidecar、
  receiver pane は receiver の sidecar)。片方が offline でも他方の
  pane は独立に戻る。双方が同じ IA を持つことによる二重化は
  `ingress_stamp|pane_agent_id` upsert で防ぐ。
- server 生存中の resume(reset → replay)でも同じ upsert で置換
  される。これに伴い `history_reset` の `preserve_inter_agent` は
  **意味論として廃止**する。ただし wire field は互換期間中
  `false` を明示送信する — 旧 dashboard は省略を `true` と解釈する
  ため、単純削除すると新 server の reset で旧 IA が残る(D6 rollout
  参照。field の物理削除は旧 client タブ消滅後の別段階)。

#### D3-4 clear 境界との整合(ingress stamp)

`/clear`・`clear_history` の IA visibility cutoff は
[ADR-0036](0036-session-lifecycle-commands.md) F3 のとおり server の
ingress-order domain で判定される。sidecar 再取込に新しい ingress
order を振ると clear 済み IA が復活するため:

- ingress stamp は D3-1 のとおり live accept 時に採番され、durable /
  globally unique な ingress-order domain の値とする。wrapper は
  verbatim 保存、replay 時にそのまま返す。
- server は replay 取込時、durable な `ClearWatermarks`(既存 DETS、
  維持)と **保存された stamp** を比較して per-pane hide を適用
  する。
- stamp を持たない行(legacy / 破損)は **fail-closed で破棄**する。
  wrapper clock の `ts` 比較への後退は clock-skew 問題を再導入する
  ため不可。

#### D3-5 session lifecycle(未採番期間・/new・/clear・削除)

- **session_id 未採番期間**: fresh wrapper は最初の turn まで
  session_id が無く、その間にも IA は到着し得る。この間は
  **pending journal** へ append し、session_id 確定時に当該 session
  の sidecar へ bind(rename)する。pending journal は
  **`{agent_id, reset_generation}` で namespace** し、同一 cwd の
  並行 fresh wrapper・rollback と衝突させない(exact path は spec で
  確定)。bind 前に crash した orphan journal は replay 対象にせず、
  次回起動時に GC する(fail-closed)。
- **`/new`・`/clear`**: 旧 generation への append を即停止し、新
  generation(次の pending → 新 session sidecar)へ切り替える。
  reset rollback 時のみ旧 generation へ戻る。
- **agent 削除**: server 側 store の purge では wrapper ホストの
  transcript / sidecar は消えない。engine transcript と同様
  「host local artifact は残置」と明記する(ADR-0030 の削除 semantics
  と整合)。
- 既存 `InterAgentHistory` DETS のデータは移行せず破棄する(dogfood
  前提で受容)。IA 履歴の session 跨ぎ復元は廃止し、他の履歴と同じ
  「現 session 分のみ」に統一する。これは現状からの**意図的な後退**
  である(D7 (b) との整合)。

### D4 — projection epoch による client 再同期(亡霊修正)

- **epoch の採番源**: AgentStates の init 時に採番する opaque な
  UUID 相当の値(**投影 lifecycle に紐づく**)。container 再起動
  だけでなく AgentStates 単体 crash でも変わるため、「投影が失われた
  のに epoch が同じ」という嘘がない(限界は D7 (d))。再起動間で
  衝突し得る連番・時刻は使わない。
- **client 側 algorithm**(単純置換にしない — join 直後、history
  push より先に新接続へ届く正当な live envelope を落とさないため):
  1. join 時点から「**この接続で受信した live envelope**」を旧
     baseline と分離した buffer に積む。
  2. `history` push の epoch が保持値と不一致 → 旧 baseline を破棄
     (対象: 表示ログ、clearWatermarks、resume replay marker、
     未読/new マーカー等の履歴派生 state を列挙して全て)し、
     authoritative history + 新接続 buffer のみを merge する。
  3. epoch が一致 → 従来どおり merge(`mergeHistories`)。
  4. epoch が absent(旧 server)→ 従来動作に fallback(亡霊は
     残るが互換維持)。

### D5 — プロセス復元と表示復元の分離

- **agent プロセスの復元**(resume-spawn)は operator 明示のまま
  変えない([ADR-0030](0030-agent-directory-and-explicit-restore.md)
  / issue #41)。
- **表示投影の復元**は自動(D2)。wrapper が生きて再接続してくれば
  operator 操作なしで timeline が戻る。
- offline agent(wrapper 停止中)の履歴は resume 操作まで空。tile は
  offline 表示なので UX 上の矛盾はなく、履歴を見たい場面は実質
  「復元して続きをやる場面」と重なる。

### D6 — cap の統一と rollout

- **cap**: 表示履歴 cap は「server が transcript 行と IA を pane
  ごとに時系列 merge・dedup・filter した**最終投影**で newest 200
  envelope」に統一する。供給源が transcript 200 + sidecar 200 でも
  合算 400 にはしない。receiver pane にも同じ cap を適用する。IA の
  cap 免除(issue #105)は廃止する。
- **rollout**: 変更は server / wrapper / client の 3 層に跨り
  (組合せは 8 通り)、**deploy 順は任意ではない**。混在時の主な
  劣化: 新 wrapper + 旧 server は ack に stamp が無く sidecar に
  記録できない(この window の IA は復元不能)、新 server(DETS
  撤廃)+ 旧 wrapper は sidecar が無く現行より durability 後退、
  旧 client は epoch・`preserve_inter_agent` 省略の解釈で誤動作
  する。
- 本 phase は dogfood 前提で **atomic maintenance rollout** を採用
  する。運用条件として固定:
  1. maintenance window 中は IA 送信なし(全 agent 停止の上で
     server / wrapper / dashboard を同時更新)。
  2. 更新後、全 dashboard タブを reload する(旧 JS のタブを残さ
     ない)。
  3. `preserve_inter_agent` は D3-3 のとおり互換期間 `false` 明示
     送信とし、物理削除は後続段階。
- 段階 rollout が必要になった場合(将来のマルチホスト长期運用)の
  参考手順: (1) 互換 server(stamp/ack/hydration/`replay_ia` 追加 +
  DETS 一時 dual-write)→ (2) wrapper 更新(sidecar 開始)→
  (3) client 更新 → (4) 旧 wrapper 不在を確認して final server で
  DETS 撤廃。本 phase では実装しない。

### D7 — 受容した制約(明文化)

- (a) offline agent の履歴は resume 操作まで表示されない。
- (b) 再起動後に復元されるのは現 session 分のみ。IA も同様(session
  跨ぎ復元の廃止、D3-5)。
- (c) server 再起動から wrapper 再接続 + replay 完了までの数秒間は
  timeline が空白になる。
- (d) AgentStates 単体 crash(root supervisor は one_for_one)は
  完全回復を保証しない: epoch は変わるが、既存接続の dashboard には
  history push が届かないため**亡霊は次の reconnect / F5 まで残存
  し得る**。wrapper の再 hydration も次の wrapper join まで遅延
  する。「stale merge をしない」保証は epoch 変更後に join した
  client に限る。完全回復の対象は container / server process
  再起動とする。
- (e) sidecar の記録 durability は D3-2 のとおり(送信側 ack 喪失
  loss・受信側注入失敗 phantom を受容、fsync なし)。
- (f) rollout は D6 の atomic maintenance 運用条件に依存する。

### D8 — protocol / 既存文書の改訂対象

protocol 追加・変更は次の 5 点:

1. wrapper channel join 応答(または hydration control)への
   replay 要否 + server 採番 `replay_id`(D2)
2. W→S replay 専用 IA ingress(`replay_ia` 仮、D3-3)
3. ingress stamp: 受信配信 envelope への付与 + 送信 acceptance ack
   (Phoenix push reply)での返却(D3-1 / D3-2)
4. `history` push への projection epoch(D4)
5. `history_reset` の `preserve_inter_agent`: 意味論廃止・互換期間は
   `false` 明示送信(D3-3)

既存文書の amendment sweep 対象:

- [ADR-0014](0014-session-resume-and-restore.md) A4 の IA「逆算
  不能」記述と issue #105 追補(本 ADR への参照を追記)
- [ADR-0036](0036-session-lifecycle-commands.md) F3(IA visibility
  cutoff の DETS ledger 前提 → sidecar + stamp 方式へ)
- [protocol](../specs/protocol.md) の `preserve_inter_agent` /
  `InterAgentHistory` 記述、`delete_agent` の purge store 数
- [ADR-0030](0030-agent-directory-and-explicit-restore.md) D6 の
  store 数記述(既に drift しているためこの機会に現行へ同期)
- [deployment](../specs/deployment.md) の DETS パス 8 種 → 7 種

## Consequences

### Positive

- server 再起動を跨いで、live agent の timeline が operator 操作なし
  で復元される。全 operator 端末で同一表示・F5 全復元が成立する。
- server の durable 状態が減る(`InterAgentHistory` DETS 撤廃)。
- stale タブの亡霊表示が解消される(D4)。
- live と replay が同一の per-pane projection contract に載り、表示
  経路の分岐(現行の sender history + DETS fan-out の二重構造)が
  消える。
- 「正本は wrapper ホスト、server は投影」という原則が composite
  SSOT として例外なしに一貫する。

### Negative

- IA 履歴の session 跨ぎ復元が現状より後退する(D3-5、意図的)。
- wrapper 側に sidecar の記録・読出・generation 管理の実装が増える
  (agent-common に共通化可能)。
- protocol 追加・変更が 5 点あり、rollout は atomic maintenance の
  運用条件(D6)に依存する。
- 再起動直後の空白期間(D7 (c))。

### Neutral

- transcript replay 経路・dedup 境界(`history_reset` /
  `history_replay_complete`)は既存機構の再利用。
- threat model への影響は軽微: hydration verdict は S→W で新規情報
  開示がなく、`replay_ia` は pane 所有権検証付きで投影のみ更新、
  sidecar はホストローカル(transcript と同じ責務境界 T1)。IA
  メタの operator 限定配信(T2)は不変。

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
| 案A: server 側で表示履歴を durable 化(#24 再オープン) | transcript の複製が第二の正本になり、/clear・cap・replay との drift 整合問題を新設。優位は「offline agent の履歴即表示」「過去 session 保持」のみで、二重正本の整合コストに見合わない |
| 案C: 現状維持 + 亡霊修正のみ | 再起動後の履歴消失が残り、マスター要件(再起動跨ぎの全端末同一表示)を満たさない |
| B-1: 注入 framing テキストのパースで IA 復元 | 表示・モデル向けテキストを直列化形式として扱う脆さを恒久的に背負う(書式変更で過去履歴が読めない・誤パース・engine 別 tool_use 形状差) |
| IA DETS 維持 | 実装コストはゼロだが「server 状態最小化」原則に例外が残る。sidecar のコスト(小〜中)で例外を消せるため撤廃を選択 |
| IA replay を通常 `envelope` 経路で再送出 | `route_inter_agent` が宛先 wrapper へ再 push → SDK 再注入し、履歴復元が会話の再実行になる。`agent_id != topic` guard とも衝突(ふじ 1 巡目 must-fix 1) |
| replay trigger =「表示履歴 0 件」判定 | partial replay 後の切断で非ゼロのまま未完了確定し、取りこぼしを永久化(ふじ 1 巡目 must-fix 2) |
| startup 無条件 replay の維持(join verdict なし) | 「hydrated なら無駄 replay なし」と両立せず、wrapper 採番 ID と server 採番 ID の pairing が曖昧になり race が残る(ふじ 2 巡目 must-fix 2) |
| MCP tool result を送信側 sidecar の server ack に使用 | tool result はローカル生成文字列で、`wait_for_response=true` では peer reply まで返らず append が session generation を跨ぐ(ふじ 2 巡目 must-fix 3) |
| dedup identity = conversation_id\|turn_number\|pane | server 合成通知が turn_number=0 固定で同一 conversation・同一 pane に複数回発生し衝突(ふじ 2 巡目 must-fix 4) |
| `preserve_inter_agent` の即時 field 削除 | 旧 dashboard は省略を `true` と解釈し、新 server の reset で旧 IA が残る(ふじ 2 巡目 must-fix 5) |
| clear 境界を wrapper `ts` 比較で判定 | 解消済みの clock-skew 問題を再導入(ふじ 1 巡目 must-fix 3) |
| epoch 不一致時の local 単純全破棄 | join 直後・history 到着前に新接続へ届いた正当な live envelope まで喪失(ふじ 1 巡目 must-fix 4) |

## Related

- 改訂対象 specs / ADR: D8 参照。
- 実装計画: [phase-30](../plans/phase-30-history-restart-resilience.md)。
- 関連 issue:
  [#24](https://gitea.example.invalid/sakurai.yuta/kaoiro/issues/24)
  (不採用継続)、
  [#41](https://gitea.example.invalid/sakurai.yuta/kaoiro/issues/41)
  (明示復元、不変)、
  [#50](https://gitea.example.invalid/sakurai.yuta/kaoiro/issues/50)
  (replay 経路)、
  [#105](https://gitea.example.invalid/sakurai.yuta/kaoiro/issues/105)
  (IA DETS、本 ADR で撤廃)。
- 仕様レビュー: ふじ 1 巡目・2 巡目 2026-08-08(conversation
  0b5c31a4)。
