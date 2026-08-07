---
title: 表示履歴の再起動耐性 — reconnect replay・IA sidecar・epoch 置換
status: proposed
date: 2026-08-08
opened: 2026-08-08
supersedes: []
superseded_by: null
related_specs: [protocol, protocol-inter-agent, architecture, deployment]
related_adrs: [12, 14, 30, 36]
---

# ADR-0051 — 表示履歴の再起動耐性 — reconnect replay・IA sidecar・epoch 置換

## Status

Proposed(マスター大筋合意 2026-08-08。ふじ仕様レビュー 1 巡目の
must-fix 5 件・should 7 件を反映済み、再レビュー待ち)

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
(`ClearWatermarks` は既存のまま維持、D3-3 参照)。

### D2 — hydration handshake による replay(server 主導)

server は agent 投影の **hydration 状態**を投影 lifecycle 内
(AgentStates、boot 毎に揮発)で管理し、それを根拠に replay を要求
する。「表示履歴が 0 件かどうか」を trigger にしない — partial
replay(reset 後に数件送って切断)で非ゼロのまま未完了確定する
取りこぼしがあるため。

- **状態**: agent 毎に `unhydrated` / `in_flight(replay_id)` /
  `hydrated` を持つ。boot 時は全 agent `unhydrated`。
- **要求**: wrapper channel join 時、当該 agent が `hydrated` で
  なければ server 採番の `replay_id` を載せた S→W
  `request_history_replay` を送る。
- **完了**: 対応する `history_replay_complete` 到達で `hydrated` に
  遷移。未完了のまま channel が切れたら `unhydrated` へ戻し、再接続
  時に再要求する。
- **wrapper 側 single-flight**: startup resume replay(現行、
  無条件実行)と server 要求 replay は wrapper 内で合流
  (coalesce)し、同時に 2 本走らせない。実行中 attempt がある間に
  要求が来たら、その attempt の完了を要求への応答として報告する。
- **fresh session**: session_id 未採番 / transcript 不在の場合、
  wrapper は空 replay(`history_reset` → 即
  `history_replay_complete`)で応答し、server は `hydrated` に
  できる。
- server 生存中の通常再接続(wrapper ホットリロード等)では agent は
  `hydrated` のままなので要求は出ず、無駄 replay は走らない。

replay 対象は現 session 分のみ。過去 session(`/new`・`/clear`
以前)の再構築はスコープ外(受容した制約、D7)。両 engine とも
transcript replay 実装は既存(`wrapper/claude-code/src/history.ts` /
`wrapper/codex/src/history.ts` + `rollout.ts`)。

### D3 — IA sidecar による `InterAgentHistory` DETS 撤廃

#### D3-1 記録(sidecar への append)

wrapper は `inter_agent_message` の構造化 envelope を、server が採番
する **ingress stamp**(D3-3)ごとローカル sidecar file へ append
する(engine transcript と同じディレクトリ、`<session-id>.ia.jsonl`
相当。正確なパス・schema は protocol-inter-agent 改訂で確定)。

- **受信側 pane**: server からの配信を受けた時点(SDK 注入の前)で
  append する。注入失敗時に sidecar だけ残る phantom は受容する
  (配信された事実の記録として妥当)。server 合成 envelope
  (`agent_id: "server"` のエラー直送通知)も受信側として同様に
  記録され、coverage に穴はない。
- **送信側 pane**: `send_to_agent` の server ack(tool result。既に
  conversation_id を返す経路)に ingress stamp を追加し、**ack 受領
  時点で** append する。ack 喪失時にその行が sidecar から欠ける
  loss は受容する(fire-and-forget な現行 `ServerLink.send` の性質。
  stderr warn で露出)。
- 破損・途中切れの末尾行は skip + stderr warn(fail-soft)。fsync は
  要求しない。sidecar パスは transcript ディレクトリ固定・
  session_id はサニタイズ・symlink は辿らない。
- dedup identity は `conversation_id|turn_number|pane_agent_id`。

#### D3-2 復元(replay 専用 ingress)

sidecar の復元は **display replay 専用の W→S ingress** で行い、通常
の `envelope` 経路は使わない。通常経路は `route_inter_agent` により
宛先 wrapper への再 push → SDK 再注入を引き起こし、履歴復元ではなく
会話の再実行になるため(ふじ must-fix 1)。また受信側が保存した
sender 名義の envelope は `agent_id != topic` guard で送れない。

- 新設メッセージ(名称は protocol 改訂で確定。例: `replay_ia`)は
  replay stream 内で `{pane_agent_id, original_envelope,
  ingress_stamp, replay_id}` を運ぶ。
- server は topic の wrapper が pane 所有者であることを検証した上で
  **投影のみ更新**する: routing・ConversationStates・peer wrapper
  push・SDK injection には一切触れない。
- **pane ownership**: 各 wrapper は自分の sidecar から自分の
  pane-local view のみを復元する(sender pane は sender の sidecar、
  receiver pane は receiver の sidecar)。片方が offline でも他方の
  pane は独立に戻る。双方が同じ IA を持つことによる二重化は、pane
  ごとの stable identity upsert で防ぐ。
- server 生存中の resume(reset → replay)でも同じ upsert で置換
  される。これに伴い `history_reset` の `preserve_inter_agent` は
  不要になる(spec sweep 対象、D8)。

#### D3-3 clear 境界との整合(ingress stamp)

`/clear`・`clear_history` の IA visibility cutoff は
[ADR-0036](0036-session-lifecycle-commands.md) F3 のとおり server の
ingress-order domain で判定される。sidecar 再取込に新しい ingress
order を振ると clear 済み IA が復活するため:

- server は IA を配信・ack する際に ingress stamp(server の
  ingress-order domain の値)を wire envelope に載せ、wrapper は
  これを verbatim 保存、replay 時にそのまま返す。
- server は replay 取込時、durable な `ClearWatermarks`(既存 DETS、
  維持)と **保存された stamp** を比較して per-pane hide を適用
  する。
- stamp を持たない行(legacy / 破損)は **fail-closed で破棄**する。
  wrapper clock の `ts` 比較への後退は clock-skew 問題を再導入する
  ため不可。

#### D3-4 session lifecycle(未採番期間・/new・/clear・削除)

- **session_id 未採番期間**: fresh wrapper は最初の turn まで
  session_id が無く、その間にも IA は到着し得る。この間は
  **pending journal**(`pending.ia.jsonl` 相当)へ append し、
  session_id 確定時に当該 session の sidecar へ bind(rename)する。
  bind 前に crash した orphan journal は replay 対象にせず、次回
  起動時に GC する(fail-closed)。
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
  のに epoch が同じ」という嘘がない(D7 (d) も参照)。再起動間で
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
     残るが互換維持。D6 rollout matrix 参照)。

### D5 — プロセス復元と表示復元の分離

- **agent プロセスの復元**(resume-spawn)は operator 明示のまま
  変えない([ADR-0030](0030-agent-directory-and-explicit-restore.md)
  / issue #41)。
- **表示投影の復元**は自動(D2)。wrapper が生きて再接続してくれば
  operator 操作なしで timeline が戻る。
- offline agent(wrapper 停止中)の履歴は resume 操作まで空。tile は
  offline 表示なので UX 上の矛盾はなく、履歴を見たい場面は実質
  「復元して続きをやる場面」と重なる。

### D6 — cap の統一と rollout matrix

- **cap**: 表示履歴 cap は「server が transcript 行と IA を pane
  ごとに時系列 merge・dedup・filter した**最終投影**で newest 200
  envelope」に統一する。供給源が transcript 200 + sidecar 200 でも
  合算 400 にはしない。receiver pane にも同じ cap を適用する。IA の
  cap 免除(issue #105)は廃止する。
- **rollout matrix**(event / field が additive でも要件は自動では
  成立しない):

| 組合せ | 挙動 |
|--------|------|
| 新 server + 旧 wrapper | `request_history_replay` は無視され、当該 agent は空のまま(degrade)。要 wrapper 更新 |
| 新 client + 旧 server | epoch absent → 従来 merge(亡霊残存の可能性)。要 server 更新 |
| 旧 client + 新 server | epoch を無視して亡霊保持。要 client 更新 |
| rollback(epoch present → absent) | client は保持 epoch を破棄して従来動作へ戻る |

  要件(再起動跨ぎの全端末同一表示)の成立には server / wrapper /
  client の 3 層更新が必要。deploy 順は任意(いずれの中間状態も
  現状より悪化しない)。

### D7 — 受容した制約(明文化)

- (a) offline agent の履歴は resume 操作まで表示されない。
- (b) 再起動後に復元されるのは現 session 分のみ。IA も同様(session
  跨ぎ復元の廃止、D3-4)。
- (c) server 再起動から wrapper 再接続 + replay 完了までの数秒間は
  timeline が空白になる。
- (d) AgentStates 単体 crash(root supervisor は one_for_one)は
  完全回復を保証しない: epoch は変わるため client が stale merge を
  することはないが、wrapper channel が生存中のため再 hydration は
  次回 join まで遅延し得る。完全回復の対象は container / server
  process 再起動とする。
- (e) sidecar の記録 durability は D3-1 のとおり(送信側 ack 喪失
  loss・受信側注入失敗 phantom を受容、fsync なし)。

### D8 — protocol / 既存文書の改訂対象

protocol 追加は次の 4 点(「2 点のみ」ではない):

1. S→W `request_history_replay`(replay_id 付き、D2)
2. W→S replay 専用 IA ingress(`replay_ia` 仮、D3-2)
3. IA wire envelope / send ack への ingress stamp(D3-3)
4. `history` push への projection epoch(D4)

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
- 「正本は wrapper ホスト、server は投影」という原則が composite
  SSOT として例外なしに一貫する。

### Negative

- IA 履歴の session 跨ぎ復元が現状より後退する(D3-4、意図的)。
- wrapper 側に sidecar の記録・読出・generation 管理の実装が増える
  (agent-common に共通化可能)。
- protocol 追加が 4 点あり、3 層(server / wrapper / client)更新
  完了まで要件は部分成立に留まる(D6 rollout matrix)。
- 再起動直後の空白期間(D7 (c))。

### Neutral

- transcript replay 経路・dedup 境界(`history_reset` /
  `history_replay_complete`)は既存機構の再利用。
- threat model への影響は軽微: `request_history_replay` は S→W で
  新規情報開示がなく、replay ingress は pane 所有権検証付きで投影
  のみ更新、sidecar はホストローカル(transcript と同じ責務境界
  T1)。IA メタの operator 限定配信(T2)は不変。

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
| 案A: server 側で表示履歴を durable 化(#24 再オープン) | transcript の複製が第二の正本になり、/clear・cap・replay との drift 整合問題を新設。優位は「offline agent の履歴即表示」「過去 session 保持」のみで、二重正本の整合コストに見合わない |
| 案C: 現状維持 + 亡霊修正のみ | 再起動後の履歴消失が残り、マスター要件(再起動跨ぎの全端末同一表示)を満たさない |
| B-1: 注入 framing テキストのパースで IA 復元 | 表示・モデル向けテキストを直列化形式として扱う脆さを恒久的に背負う(書式変更で過去履歴が読めない・誤パース・engine 別 tool_use 形状差) |
| IA DETS 維持 | 実装コストはゼロだが「server 状態最小化」原則に例外が残る。sidecar のコスト(小〜中)で例外を消せるため撤廃を選択 |
| IA replay を通常 `envelope` 経路で再送出 | `route_inter_agent` が宛先 wrapper へ再 push → SDK 再注入し、履歴復元が会話の再実行になる。`agent_id != topic` guard とも衝突(ふじ must-fix 1) |
| replay trigger =「表示履歴 0 件」判定 | partial replay 後の切断で非ゼロのまま未完了確定し、取りこぼしを永久化(ふじ must-fix 2) |
| clear 境界を wrapper `ts` 比較で判定 | 解消済みの clock-skew 問題を再導入(ふじ must-fix 3) |
| epoch 不一致時の local 単純全破棄 | join 直後・history 到着前に新接続へ届いた正当な live envelope まで喪失(ふじ must-fix 4) |
| wrapper 主導の replay トリガー(再接続時に常時 replay) | server が投影 hydration 状態を知る主体であり、生存中の通常再接続でも毎回 replay が走り無駄 |

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
- 仕様レビュー: ふじ 1 巡目 2026-08-08(must-fix 5 / should 7 /
  nit 2、conversation 0b5c31a4)。
