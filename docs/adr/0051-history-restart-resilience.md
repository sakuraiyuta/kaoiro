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

Proposed(マスター大筋合意 2026-08-08。ふじ仕様レビュー待ち)

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
  正本は「agent が実際に何を受け取り何を返したか」を記録する engine
  transcript(Claude Code = SDK JSONL / Codex = rollout)に置く。

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

### D1 — 履歴正本は engine transcript のまま(A4 継承)

会話履歴の正本は wrapper ホストの engine transcript(Claude Code =
`~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`、Codex =
rollout file)とし、server の表示履歴は「捨てても再構築できる揮発
投影」のままとする。issue #24(server 全履歴永続)は引き続き不採用。
server の durable 状態は最小化する — 本 ADR で `InterAgentHistory`
DETS を撤廃し(D3)、durable な表示系状態を追加しない。

### D2 — server 再起動後の reconnect 時 replay(server 主導)

server は、表示履歴を 1 件も持たない agent の wrapper channel join を
検知したとき、当該 wrapper へ履歴 replay を要求する(S→W 制御
メッセージ `request_history_replay`、名称は protocol 改訂で確定)。
wrapper は resume 起動時と同一の replay 経路(`history_reset` → `log`
再生 → `history_replay_complete`。ADR-0014 phase-2 / issue #50 実装)
を現 session の transcript に対して実行する。

- トリガーは server 主導。server は自分が空であること(再起動直後で
  あること)を知っている唯一の主体であり、wrapper 側の推測より確実。
- replay 対象は現 session 分のみ。過去 session(`/new`・`/clear`
  以前)の再構築はスコープ外(受容した制約、D7)。
- 両 engine とも replay 実装は既存
  (`wrapper/claude-code/src/history.ts` /
  `wrapper/codex/src/history.ts` + `rollout.ts`)。追加は trigger の
  受け口のみ。

### D3 — IA sidecar による `InterAgentHistory` DETS 撤廃

wrapper は `inter_agent_message` を送信・受信した時点で、構造化
envelope をそのままローカル sidecar file へ append する(engine
transcript と同じディレクトリ、`<session-id>.ia.jsonl` 相当。正確な
パスは protocol-inter-agent 改訂で確定)。replay 時(resume /
reconnect とも)は sidecar を読み、構造化 IA envelope として再送出
する。

- server の DETS-backed `InterAgentHistory` は撤廃する(ADR-0014 の
  issue #105 追補を supersede)。既存 DETS データは移行せず破棄
  (dogfood 前提で受容)。
- server 合成 envelope(エラー直送通知、`agent_id: "server"`)も
  wrapper が受信した時点で sidecar に記録されるため coverage は
  揃う。
- IA 履歴の session 跨ぎ復元は廃止し、他の履歴と同じ「現 session
  分のみ」に統一する。これは現状(DETS で sender 毎 500 件、session
  跨ぎ保持)からの**意図的な後退**である(D7 の制約 (b) との整合)。

### D4 — boot epoch による client バッファ置換(亡霊修正)

server は起動毎に採番する boot epoch を join 時の `history` push に
載せる。client は保持している epoch と異なる epoch を受け取ったら
local の表示バッファを破棄して server 投影で置換する。同一 epoch 内
では既存 merge(join 直後に届く live envelope との race 対策、
`mergeHistories`)を維持する。これにより stale タブが再起動前ログを
表示し続ける問題を解消し、「全端末同一表示」を再起動後も保証する。

### D5 — プロセス復元と表示復元の分離

- **agent プロセスの復元**(resume-spawn)は operator 明示のまま
  変えない([ADR-0030](0030-agent-directory-and-explicit-restore.md)
  / issue #41)。
- **表示投影の復元**は自動(D2)。wrapper が生きて再接続してくれば
  operator 操作なしで timeline が戻る。
- offline agent(wrapper 停止中)の履歴は resume 操作まで空。tile は
  offline 表示なので UX 上の矛盾はなく、履歴を見たい場面は実質
  「復元して続きをやる場面」と重なる。

### D6 — cap の統一

表示履歴 cap は agent 毎 200 envelope に統一する(リングバッファ・
replay とも)。IA の cap 免除(issue #105 で導入)は DETS 撤廃に伴い
廃止する。

### D7 — 受容した制約(明文化)

- (a) offline agent の履歴は resume 操作まで表示されない。
- (b) 再起動後に復元されるのは現 session 分のみ。
- (c) server 再起動から wrapper 再接続 + replay 完了までの数秒間は
  timeline が空白になる。

## Consequences

### Positive

- server 再起動を跨いで、live agent の timeline が operator 操作なし
  で復元される。全 operator 端末で同一表示・F5 全復元が成立する。
- server の durable 状態が減る(`InterAgentHistory` DETS 撤廃。
  deployment の DETS パスは 8 種 → 7 種)。
- stale タブの亡霊表示が解消される(D4)。
- 「正本は agent ホスト、server は投影」という ADR-0014 A4 の原則が
  例外なしに一貫する。

### Negative

- IA 履歴の session 跨ぎ復元が現状より後退する(D3、意図的)。
- wrapper 側に sidecar の記録・読出実装が増える(agent-common に
  共通化可能)。
- 再起動直後の空白期間(D7 (c))。

### Neutral

- replay 経路・dedup 境界(`history_reset` /
  `history_replay_complete`)は既存機構の再利用で、protocol 追加は
  `request_history_replay` と epoch field のみ。
- threat model への影響は軽微: replay 要求は S→W で新規情報開示が
  なく、sidecar はホストローカル(transcript と同じ責務境界 T1)。
  IA メタの operator 限定配信(T2)は不変。

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
| 案A: server 側で表示履歴を durable 化(#24 再オープン) | transcript の複製が第二の正本になり、/clear・cap・replay との drift 整合問題を新設。優位は「offline agent の履歴即表示」「過去 session 保持」のみで、二重正本の整合コストに見合わない |
| 案C: 現状維持 + 亡霊修正のみ | 再起動後の履歴消失が残り、マスター要件(再起動跨ぎの全端末同一表示)を満たさない |
| B-1: 注入 framing テキストのパースで IA 復元 | 表示・モデル向けテキストを直列化形式として扱う脆さを恒久的に背負う(書式変更で過去履歴が読めない・誤パース・engine 別 tool_use 形状差) |
| IA DETS 維持 | 実装コストはゼロだが「server 状態最小化」原則に例外が残る。sidecar のコスト(小〜中)で例外を消せるため撤廃を選択 |
| wrapper 主導の replay トリガー(再接続時に常時 replay) | server が履歴を保持したままの通常再接続(wrapper 側ホットリロード等)でも毎回 replay が走り無駄。空かどうかを知る server 主導が正確 |

## Related

- 改訂対象 specs: [protocol](../specs/protocol.md)
  (`request_history_replay` + epoch field)、
  [protocol-inter-agent](../specs/protocol-inter-agent.md)
  (sidecar 節新設、#105 記述の差替え)、
  [architecture](../specs/architecture.md)、
  [deployment](../specs/deployment.md)(DETS 8 種 → 7 種)。
- 訂正対象: [ADR-0014](0014-session-resume-and-restore.md) A4 の IA
  「逆算不能」記述(本 ADR への参照を追記)。
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
