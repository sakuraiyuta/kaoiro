---
title: /new・/clear を第一級 session lifecycle command として扱う
status: accepted
date: 2026-07-12
opened: 2026-07-12
supersedes: []
superseded_by: null
related_specs: [protocol, architecture, threat-model]
related_adrs: [12, 14, 20, 34]
---

# ADR-0036 — /new・/clear を第一級 session lifecycle command として扱う

## Status

Accepted (2026-07-12、マスター決裁)。実装は
[phase-17-session-lifecycle-commands](../plans/phase-17-session-lifecycle-commands.md)。
phase-15 initial完了後に着手し、phase-16との実装順は着手時にマスターが決める。

## Context

kaoiro Composerはengineが報告したslash commandを補完できるが、command自体を
解釈しない。`/new`・`/clear`は通常の`send_instruction`としてwrapperへ届き、
Codexでは単なる1 turn promptになってthread IDもcontextも変化しないことを
2026-07-11にももが実測した。Claude/CodexともCLI native slash command parserを
経由しないSDK/exec統合なので、文字列をengineへ渡してもsession lifecycle操作に
ならない。

ももの実測では、kaoiroから`/new`送信直後も同じCodex sessionで過去会話を参照
でき、session boundaryは発生しなかった。一方disconnect -> resumeではhistory継続を
確認済み。Codex native `/new` (表示保持 + fresh task)、`/clear` (端末表示消去 +
fresh task)、`Ctrl+L` (表示だけ消去)、`/delete` (恒久削除)の意味差は公式仕様で
確認したが、kaoiro越しにnative commandを実行した実測ではない。また、同一processで
session IDをnull化して次turnを`startThread()`にする経路も未実測であり、本ADRは
その成立を前提にしない。

### 追補 (2026-07-28 — Claude Agent SDK `/compact` 実測)

2026-07-28 に実施した [phase-28 の Track S 実測結果](../plans/phase-28-agent-initiated-session-ops.md#track-s-実測結果)では、Claude Agent SDK 0.3.220 は streaming input mode でも文字列 `/compact` を CLI native slash command として解釈し、manual compact を実行した。したがって、上記の「Claude/CodexともCLI native slash command parserを経由しない」という断定は、Codex 側の実測に限る。Claude 側にはこの断定を適用しない。

operatorが同じagent/persona/cwdのまま新しい会話を始めるには、現状agent削除と
再spawnが必要である。必要なのは文章入力ではなく、表示履歴、resume pointer、
wrapper process、新しいSDK sessionを協調して切り替える第一級control operationで
ある。

本ADRは次を決める:

1. slash commandをどの層でinterceptするか。
2. 両engineでfresh sessionをどう生成するか。
3. `/new`と`/clear`の表示差。
4. 旧sessionへ戻る経路と`SessionPointers`の扱い。
5. 共通protocolとsession capabilityの境界。
6. turn実行中の挙動。

## Decision

### F1 — client第一級control + server防御reject

dashboardはtrim後の入力が**exactに**`/new`または`/clear`で、attachmentが無い時だけ
通常instructionを送らず、operator-only control eventを送る:

```text
session_reset { agent_id, mode: "new" | "clear" }
```

引数付き (`/new foo`)、複数行、attachment付きはsession resetとして解釈しない。
ただしreserved commandの誤送信を黙ってengineへ流さないため、serverの
`send_instruction` handlerもattachment無しのexact `/new`・`/clear`を検出し、
`reserved_session_command`でloud rejectする。旧clientには専用eventへのupgradeを
促す。wrapperがuser textを再parseする案は採らない。protocol controlとmodel入力の
責務を混ぜ、client/server validationを通過した後で意味が変わるためである。

exact文字列をmodelへ説明目的で送りたい場合はcode block、または先頭をescapeした
`\/new` / `\/clear`を用い、reserved exact tokenを避ける。phase-17はescape文字を
除去してexact tokenを送る特別経路を作らない。reserved command防御を迂回する裏口に
なるためである。

serverはoperator role、agent存在、live owner、capability、現在stateを検証し、
reset requestを一意`request_id`付きでrunnerへrelayする。client pushの`:ok`は受付
のみで、表示変更は後述のauthoritative completion broadcastを待つ。

### F2 — fresh relaunchで両engineを共通化

session resetは既存`resume_session`のrunner supervisor経路を拡張し、同じagent
entryを**kill + fresh relaunch (resume_session_idなし)**する。これにより:

- Claudeは`resume` optionなしの新しい`query()`を開始する。
- Codexは`resumeThread()`でなく`startThread()`から始める。
- agent_id、persona、cwd、engineを維持し、model、effort、permission mode、sandbox、
  network access等はphase-15 D8のsnapshotと同じ**最後に実効だった設定**で開始する。
  launch時値へ巻き戻さない。
- 旧SDK processのin-memory context/queue/tool stateを新sessionへ混入させない。

reset専用に各adapterの長寿命loopを内部再初期化する実装は採らない。Claudeの
streaming queryとCodexのper-turn execで別実装になり、queue/pending toolの残留を
証明しにくい。runner supervisorをprocess lifecycleのSSOTとして再利用する。

serverはreset開始時にagent単位の`session_reset_pending` lockを取り、後続の
instruction、model/effort switch、permission_mode switch、resume_session
(switch_session)、重複resetを`session_reset_pending`で拒否する
(**2026-07-12 ε 実装時の race 分析で resume_session の列挙漏れを検出し追補**、
race 塞ぎとして `AgentsChannel.handle_in("resume_session")` にも
`guard_against_reset_pending` を挿入)。
runnerがfresh wrapperの接続を確認した時だけ`session_reset_completed`をbroadcastし、
lockを解放する。Codexのthread/rollout IDが最初のturnまで採番されない場合、fresh
wrapper接続を「context reset成立」としてcompletionし、`to_session_id`はnullableで
markerへ載せ、最初のID報告で同じrequest IDのmarker/pointerを確定する。

fresh spawn/timeout失敗時は、runnerが保存した旧session IDで旧sessionを明示resume
してatomic rollbackを試みる。rollback成功後に`session_reset_failed`をloud broadcast
し、UI history/boundary/pointerを変更せずlockを解放する。これは成功を装うsilent
fallbackではなく、失敗したtransactionの復元である。rollback自体も失敗した場合のみ
agentをdisconnectedとし、両errorを表示する。

reset requestごとにgeneration/epochを進め、旧wrapper/旧rolloutから遅れて届いたevent、
tool/question/permission correlation、stale completionを新sessionへ混ぜない。fresh
wrapperはpersona/developer instructions、最後に実効だったmodel/effort/permission、
sandbox/network、MCP configを通常のspawn経路から再適用する。値のSSOTはphase-15 D8
の最新effective snapshotとし、phase-16のmid-session model/effort switch成功値も含む。

「通常のspawn経路から再適用」の具体化は [ADR-0014 F1 追補「resume 時の privilege 三軸再適用」](0014-session-resume-and-restore.md) に集約する: `ResetSessionCommand.resume_snapshot?` を server が同梱し、runner の `applyResumeSnapshot` pure helper が P0 の privilege 三軸 (Codex `sandbox` / `network_access`、Claude `permission_mode`) を fresh 相当の `ParsedSpawn` に反映する。`model` / `effort` は sanitized snapshot に保持され drift 計算にも入るが実 apply は P1。

### F3 — /new は表示維持、/clear は当該 agent の表示 projection を reset

両 mode とも新しい SDK session を作り、旧 session file (host JSONL/rollout) は保持
する。表示側の差は次のとおり:

- `/new` — 表示 projection を維持する。`session_boundary` marker を既存 history の
  末尾に append し、以降の SDK 出力が続く。旧 log と structured IA はそのまま。
- `/clear` — 当該 agent の pane 表示を **空にする**。通常 log も IA バブルも区別せず
  全て drop し、`session_boundary` marker 1 行だけを残す。IA の相手 pane は #109 の
  per-pane `ClearWatermarks` で hide するので、durable ledger
  (`InterAgentHistory` DETS) は削除しない (相手 agent の pane では IA が残る)。
  engine 側 session file (JSONL/rollout) は削除せず、旧 session は picker から
  resume 可能のままとする。

`server` 側 `AgentStates` を表示 projection の SSOT とし、client local store だけを
消す実装は採らない。再接続で消した log が復活するためである。/clear 完了時、
`SessionResets.confirm_connection/2` は `SessionStarts.advance_transition/3` が返す
`{order, display}` を `ClearWatermarks.record/3` に採用 (operator `clear_history`
の `adopt_session_start_watermark` と同型) し、`AgentStates.clear_history_with_boundary/2`
で history を marker 1 行だけに絞る。fsync-gated な `ClearWatermarks` を先に通し、
crash 時にも watermark を durable に残す (`M7-a` と同じポリシー)。

marker は `{mode, previous_session_id?, to_session_id?, request_id, ts}` を
operator 向け payload に持つ。`to_session_id` は ID 確定後に追記し、lazy 采番時
は一時 null を許す。`session_reset_completed` broadcast の payload には `/clear`
時のみ `clear_watermark`(ISO ts)を追加で載せ、live client が reload を待たず
watermark map を更新できるようにする。viewer への通知は ADR-0021 の allow-list
で operator に限定し、session ID を含む payload を漏らさない。operator `clear_history`
(#48) と /clear は **別機能**(前者は現行 session の他 session ログ purge、後者は
当該 agent の pane 全消去 + marker 保持)としてそれぞれ現状 API を維持する。

### F4 — SessionPointersは最新1件のまま、明示detachを追加

[ADR-0014](0014-session-resume-and-restore.md) F3の1:1最新pointer契約を維持し、
pointer stackは追加しない。fresh relaunch成功後、`SessionPointers`は旧session IDを
**明示的にdetachしてnilへ更新**し、cwd/engineは保持する。現在の`record(..., nil)`
は既存session IDを保存するmerge semanticsなので、phase-17で同期的な専用operation
(`detach_session/1`等)を追加する。fresh wrapperが新session IDを報告した時点で
通常のrecord経路が最新pointerを更新する。

旧sessionはrunnerのcwd配下session列挙と既存session picker/
`resume_session`で再開できる。専用「直前へ戻る」stackは作らない。serverに履歴を
複製せずhost session filesを候補SSOTとするADR-0014 F2/F3/A4を維持する。
completion toastから`previous_session_id`へ一度だけ戻るshortcutは将来追加可能だが、
pointer stackではなく既存`resume_session`へのUI shortcutとして扱い、MVP外とする。

reset後、最初のinstruction前はsession ID未採番でも正常な状態である。pointer=nilを
「reset済み・次turnでfresh ID確定」と扱い、旧pointerへ暗黙fallbackしない。

### F5 — capability advertiseでengine分岐を禁止

[ADR-0034](0034-session-capabilities-advertisement.md) F2を次で拡張する:

```text
supports_session_reset: boolean
session_reset_modes: ("new" | "clear")[]  // supports=true時は必須・非空
```

`supports_session_reset=false`時だけ`session_reset_modes`を省略できる。trueなのにmodesが
未指定または空ならinvalid advertisementとしてfail-closedし、UIをdisableする。
adapterのstamp testでもこの組合せをrejectする。

wrapper/runner/serverがF2のfresh relaunchとcompletion handshakeを提供するsessionだけ
trueをstampする。未stamp/falseはfail-closedでUI commandをdisableし、typed exact
commandも`unsupported_session_reset`としてengineへ流さない。dashboardはengine名で
判定しない。

`/new`・`/clear`はengineの`ext.slash_commands`とは別のkaoiro local commandだが、
capability=trueかつ該当mode列挙時だけ補完候補へmergeする。これによりengineが同名
commandを報告してもkaoiro controlの意味を優先し、重複表示しない。

### F6 — busy時は拒否。自動interrupt・queueはしない

resetを受理できるstateは`idle`または`waiting_input`のみとする。`thinking`、
`tool_running`、`waiting_permission`、`waiting_question`、`sending`その他実行中stateは
`agent_busy`でloud rejectする。

`error` stateのagentをresetして仕切り直す需要はあるが、MVPでは他の非idle stateと
同様にrejectする。errorからのreset受理は、旧process/rollback semanticsを実測した後の
将来拡張候補とする。

自動interrupt後のresetは採らない。tool write中断とcontext破棄を一操作に束ねると
誤操作の影響が大きい。queue待機も採らない。長いturn完了後に遅れてresetされると、
operatorが次の入力先を誤認する。必要ならoperatorが既存interruptを明示実行し、
`waiting_input`復帰を確認してresetを再送する。

serverはstate検証と同時にF2のpending lockを獲得し、新instructionとのTOCTOUを防ぐ。
runner/wrapperもreset requestのgeneration/request IDを検証し、stale completionを
無視する。

### F7 — protocol eventとfailureをSSOT化

control flowは次の一組とする:

```text
client -> server: session_reset {agent_id, mode}
server -> runner: reset_session {agent_id, mode, request_id}
runner -> server: session_reset_result {agent_id, mode, request_id, ok, reason?}
server -> clients: session_reset_started | session_reset_completed | session_reset_failed
```

`session_reset_started`受信中はUIに「新しいsessionを開始中」と表示する。既存の
coarse `KaoiroState`へ`starting_new_session`を追加せず、server-owned lifecycle eventと
pending lockをSSOTにする。wrapper processが入れ替わる操作をengine state machineへ
混ぜないためである。

serverがpending lock、AgentStates表示変更、SessionPointers detach、client broadcastの
SSOTである。runnerはprocess lifecycleのSSOT、wrapper/SDK session fileは会話履歴の
SSOTである。各層に同じ履歴やpointer stackを複製しない。

error reasonはclosed vocabulary (`agent_busy`, `unsupported_session_reset`,
`session_reset_pending`, `runner_unavailable`, `spawn_failed`, `rollback_failed`,
`timeout`)でloudに返し、engine promptへのfallbackや成功を装う旧sessionへのsilent
resumeを禁止する。stderrにも
`[wrapper session] command=<mode> from=<id> to=<id|null> result=<ok|failed|rolled_back>`
を1行出す。

## Consequences

### Positive

- 同じagent/persona/cwdのまま、CLI相当の会話仕切り直しができる。
- Claude/Codex差をrunnerのfresh relaunchへ閉じ、clientはcapabilityだけを見る。
- `/clear`後も旧sessionをpickerからresumeでき、session file (JSONL/rollout) は
  削除しない。当該 agent の pane 表示だけを reset し、IA の相手 pane は
  watermark で per-pane に hide する。
- busy操作は即時rejectされ、遅延resetや暗黙interruptが起きない。

### Negative

- control handshakeがclient/server/runner/wrapperの全層に跨る。
- reset時にwrapper processを再起動するため短いdisconnected窓が生じる。
- `SessionPointers`にnilへの明示detach operationを追加する必要がある。
- Codexのfresh thread IDが初turnまでlazyな場合、boundaryのID確定が二段階になる。

### Neutral

- pointerは最新1件のままで、旧session一覧はrunner列挙を継続する。
- `/clear`はSDK session fileを削除しない。完全削除機能は本ADRのscope外。

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
| wrapperが`user_message`先頭一致でslashを解釈 | model入力とcontrol責務が混ざり、literal textやattachmentの扱いがadapterごとにdriftする |
| clientだけでintercept | 旧/外部clientのexact commandがengineへ素通しされる。server防御rejectが必要 |
| adapter内部でsessionIdだけnullへ変更 | Codexには近いがClaude長寿命queryと非対称。queue/tool/pending stateの完全resetを証明しにくい |
| `/clear`でhost session fileも削除 | resume不能なdestructive operationになり、名称から予想しにくい。当該 agent の pane 表示だけを reset し、host session file (JSONL/rollout) は保持する |
| serverにprevious session stackを保存 | ADR-0014 F3/A4のlatest pointer + host列挙SSOTと重複。既存pickerで戻れる |
| busy時にinterruptしてreset | write/tool中断とcontext破棄が一clickで起きる。operatorの明示interruptを要求する |
| busy時にresetをqueue | 実行完了後の遅延破棄が予測困難で、次の入力先を誤認する |
| reset失敗時に旧sessionを復元せずdisconnectedで止める | UIを変えないatomic transactionにでき、旧sessionはidleで安全にresume可能。rollbackも失敗した時だけdisconnectedでよい |
| capabilityを`lifecycle_commands` object 1個に集約 | display policyはprotocol上modeで固定済み。ADR-0034のboolean + optional modes patternに揃えた方が既存UI判定とfail-closed semanticsを再利用できる |

## Implementation

[phase-17-session-lifecycle-commands](../plans/phase-17-session-lifecycle-commands.md)
で実装する。

### 実測項目の扱い (phase-17 chunk γ 時点、2026-07-12)

F2 の「fresh wrapper接続を確認した時だけcompletion」と Codex の thread
ID lazy 採番を巡る挙動は、γ (17-5/6) 実装時点では**実装 assumption**
として下記の形で coded に組み込んだ。実機での実測は Composer intercept
と boundary UI が入る δ (17-7/8/9) 完了後、operator による `/new`・`/clear`
の実操作で行い、必要ならこの ADR に findings を追補する。

- **Codex thread ID 確定タイミング**: runner の `session_reset_result`
  は `to_session_id` を optional / nullable にし、Codex 側は fresh
  spawn 時点で `null` を送出する。server (`SessionResets`) の
  `broadcast_completed` payload は `SessionResetCompleted.to_session_id`
  を `null` で載せる。fresh session の初回 envelope が session_id を
  報告した時点で既存の `SessionPointers.record` 経路が最新 pointer を
  更新するため、pointer 側の確定は既存経路で自然に達成される。marker
  側の後追い patch (δ 17-7 の `AgentStates` boundary marker への
  `to_session_id` 反映) は UI 実装時に fresh 側の初回 envelope を hook
  する形で追加する。
- **同 process 連続生成**: runner supervisor は reset のたびに child を
  kill + fresh spawn する (別 process)。同 process 内で `startThread()`
  → `resumeThread()` を切り替える経路は本 ADR では採らない (F2 「fresh
  relaunch」で SDK adapter 差を統合する方針)。実測で「同 process 内
  切替でも十分に隔離できる」と判ればコスト削減候補になるが、γ 時点では
  未検証・不採用。
- **旧 event 隔離**: 三段防御で担保する。(a) runner supervisor の
  child kill で旧 wrapper process を停止 (旧 rollout / tool 応答 /
  permission 要求は fresh 側 process に届かない)、(b) wrapper が
  envelope に session_id を stamp するので server 側 `AgentStates` が
  latest session_id で dedupe、(c) server `SessionResets` は
  request_id / phase mismatch の resolve / confirm を silent drop
  (F7)。三段のどれかが壊れても他 2 段で防ぐ。runner 側の generation
  counter は導入せず、child プロセス層の kill を主防御とする。

### F2 「接続確認」の実装分担 (chunk γ two-phase completion)

`SessionResets` に lock の `phase: :spawning | :awaiting_connect` を導入
し、runner の `session_reset_result { ok=true }` は `:awaiting_connect`
移行のみ (broadcast は発火せず)、`session_reset_completed` は fresh
wrapper の `WrapperChannel.after_join` から `SessionResets.confirm_connection/2`
経由で発火する。60 秒 timeout は spawn 段階 (runner ok 未受信) と接続
段階 (wrapper join 未確認) の両方を通算するので、いずれの段階で止まっ
ても `session_reset_failed { reason: "timeout" }` に落ちる。この two-
phase は本 ADR F2 の「fresh wrapper 接続を確認した時だけ completion」
文言を文字通りに実装したもので、`runner.ok=true` を completion と誤解
する近似実装 (fresh spawn 直後に wrapper が死んだ場合の completed 偽装
リスク) を明示的に避ける。
