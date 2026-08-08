---
title: Phase 30 — 表示履歴の再起動耐性 (ADR-0051)
description: hydration handshake による reconnect 時 replay・IA sidecar と per-pane projection contract による DETS 撤廃・projection epoch による client 再同期を実装する。
status: in-progress
phase: 30
depends_on: []
last_updated: 2026-08-08
---

# Phase 30 — 表示履歴の再起動耐性 (ADR-0051)

## Goal

[ADR-0051](../adr/0051-history-restart-resilience.md) を実装する:
server 再起動を跨いでも全 operator 端末が同一の timeline を見られる
状態にし、`InterAgentHistory` DETS を撤廃して server の durable 状態を
削減する。

## Tasks

| # | Task | Owner | Status | Notes |
|---|------|-------|--------|-------|
| 30-1 | ADR-0051 仕様レビュー | ふじ | ✅ | 2 巡 (must-fix 計 10 件、全反映) → approve。マスター承認で accepted 化済み (2026-08-08) |
| 30-2 | ADR 確定 + specs 改訂 | クロエ | ✅ | wire 確定: hydration verdict は wrapper join 応答 `hydration: {replay_required, replay_id?}` (専用 S→W event なし)、`replay_ia {replay_id, items:[{envelope, ingress_stamp}]}` は topic bind、送信 ack は envelope push reply `{ingress_stamp}`。 protocol.md (ADR D8 の 5 点: join hydration verdict / `replay_ia` / ingress stamp (配信 + acceptance ack) / projection epoch / `preserve_inter_agent` false 明示)、protocol-inter-agent.md (sidecar schema・pending journal namespace・generation・live projection の因果順)、architecture.md |
| 30-3 | 既存文書 amendment sweep | もも | ✅ | 完了 2026-08-08。ADR D8 の対象: ADR-0014 A4 / ADR-0036 F3 / ADR-0030 D6 store 数 / protocol.md `preserve_inter_agent`・purge store 数 / deployment.md DETS 8 種 → 7 種。phase-17 / 19 の旧 DETS 前提にも dated note を追補 |
| 30-4 | server: per-pane projection contract | あお | ✅ | 2026-08-08 完了 (1493eb4)。 live/replay 共用の volatile per-pane upsert API。live accept 時の validate → stamp 採番 → 両 pane upsert → routing の因果順、server 合成 IA は recipient pane のみ、identity = `ingress_stamp\|pane_agent_id`、clear filter + 最終 200 cap 同経路 (ADR D3-1/D6) |
| 30-5 | wrapper: IA sidecar 記録 | あお | ✅ | 2026-08-08 完了 (186f542)。 agent-common 共通化、両 engine。受信 = 注入前 append (stamp 付き配信) / 送信 = transport acceptance ack (`{ingress_stamp}` reply) 到着時 append、pending journal ({agent_id, reset_generation} namespace) → session bind、/new・/clear generation 切替 (ADR D3-2/D3-5) |
| 30-6 | wrapper: hydration handshake + IA replay 送出 | あお | ✅ | 2026-08-08 完了 (186f542)。 join verdict (要否 + server replay_id) を待って replay 開始、legacy fallback (verdict absent → 従来 startup replay)、single-flight、fresh session の empty-complete、sidecar → `replay_ia` 送出 (ADR D2/D3-3) |
| 30-7 | server: hydration 状態管理 + replay ingress + DETS 撤廃 | あお | ✅ | 2026-08-08 完了 (1493eb4)。 hydrated の無効化条件は ADR D2 追補 (あお Q1)。 AgentStates に hydration state (in_flight は replay_id + channel_owner の CAS)、join 応答 verdict、`replay_ia` の pane 所有権検証 + 投影 upsert、stamp と ClearWatermarks 比較、InterAgentHistory と purge 経路の除去、`preserve_inter_agent: false` 明示送信 (ADR D2/D3-3/D3-4) |
| 30-8 | dashboard: projection epoch 再同期 | あお | ✅ | 2026-08-08 完了 (150b3a2)。 新接続 buffer の分離、epoch 不一致時の baseline 破棄 (logs / clearWatermarks / replay marker / 未読 state) + history と新接続 buffer のみ merge、epoch absent fallback (ADR D4) |
| 30-9 | docs 整合 sweep | もも | ⏳ | 実装後の README / specs 齟齬確認 |
| 30-10 | 実装レビュー | ふじ | 🟡 | 1 巡目 2026-08-08: must-fix 5 → あお修正済み (c2f8a2a / 2428304 / c8ceec8 / 15dd791、下記「30-10 must-fix 対応」)、差分再レビュー待ち (M1 liveSinceJoin の接続 generation 窓 / M2 replay 復元行を operator-only 専用 pane event へ / M3 sidecar の ingress_stamp sort / M4 replay_ia の 8MB chunk 分割 / M5 acceptance ack と tool outcome の接続) + should 3 (S1 reject 後 pane 不変 pin / S2 partial 置換 pin / S3 sidecar 全量 read は将来課題)。仕様差分 4 点 + 追補 1 点も併せてレビュー済み (追補 1 は M2 で wire 差し替え)。観点は下記「30-10 レビュー観点」 |
| 30-11 | dogfood 検証 + atomic rollout 実施 | デフォルトくん + マスター | ⏳ | ADR D6 の maintenance 手順 (IA 停止 → 3 層同時更新 → 全タブ reload) で deploy し、下記シナリオを検証 |

Status legend: ✅ done, 🟡 in progress, ⚠ partial, ⏳ not started,
⛔ blocked.

## Acceptance Criteria

基本要件:

- [ ] server 再起動後、live wrapper の agent timeline が operator
      操作なしで現 session 分復元される(claude-code / codex 両方)
- [ ] **server を再起動せずに** live IA を送受信 → F5 で sender /
      receiver 両 pane が一致して復元される(DETS 撤廃後の live
      経路、ADR D3-1)
- [ ] IA バブルが sidecar + `replay_ia` 経由で復元され、replay が
      IA の再配送(peer への再 push・SDK 再注入)を一切起こさない
- [x] `InterAgentHistory` DETS がコードベース・deployment doc から
      消えている
- [ ] 再起動前から開いていたタブが再起動前ログを表示し続けない。
      複数端末で同一表示になる
- [ ] server 稼働中の F5 全復元・端末間一致が従来どおり成立する
      (回帰なし)
- [x] 全テスト green(server `mix test` / wrapper `pnpm test` /
      dashboard `pnpm test`)

failure matrix(ふじレビュー由来。(a)-(e)・(h)・(i)・(k) は
**deterministic automated test 必須**、(f)(g) と全体 UX は dogfood
併用):

- [x] (a) replay 途中(reset 後 partial)で wrapper 切断 → 再接続で
      再要求され完全な timeline に到達する [test]
- [x] (b) join verdict handshake: `required: true` の replay_id が
      reset / `replay_ia` / complete で一貫し、hydration 遷移が CAS
      で行われる。startup replay との二重実行が起きない [test]
- [x] (c) server 生存中の wrapper 再接続では verdict
      `required: false` が返り、無駄 replay が走らない [test]
- [x] (d) fresh session(session_id nil / transcript 無し)は
      empty-complete で hydrated になる [test]
- [x] (e) `/new`・`/clear`・rollback・旧 session resume・
      `clear_history` の各操作後に clear 済み IA が復活しない
      (ingress stamp 比較) [test]
- [ ] (f) sender / receiver の片方 offline でも他方の pane が独立に
      復元される [test + dogfood] — test 側は済 (30-11 の dogfood 待ち)
- [ ] (g) server 合成 IA(エラー直送通知)が受信側 sidecar 経由で
      復元され、同一 conversation の複数回通知が識別・共存する
      (`ingress_stamp|pane` identity) [test + dogfood] — test 側は済
      (30-11 の dogfood 待ち)
- [x] (h) transcript + IA 合算で 200 件超のとき最終投影が newest 200
      に cap される(201 件・400 件境界) [test]
- [x] (i) epoch 不一致 + history 到着前の live envelope 到着で、
      live 行を失わず亡霊だけ消える [test]
- [ ] (j) atomic maintenance rollout の運用条件(IA 停止・3 層同時
      更新・全タブ reload)が手順書どおり実施され、旧 client 向け
      `preserve_inter_agent: false` 明示送信が確認できる [dogfood]
- [x] (k) sidecar の途中切れ・破損行が skip され replay が継続する
      [test]

## 30-10 レビュー観点 (あお申し送り、2026-08-08)

実装者が「ここは判断が入った / 見てほしい」と挙げた点。詳細は各 commit
メッセージと該当箇所のコード注釈にある。

1. **`replay_ia` 受理行の `agents:lobby` broadcast** (追補 1、150b3a2)。
   ADR/spec に記述が無かった欠落への対処なので、設計判断として最優先で
   見てほしい。`history_reset` が `preserve_inter_agent: false` を送る
   ため接続中タブは IA を落とすが、`replay_ia` は投影 upsert のみで live
   通知が無く、F5 まで IA バブルが戻らなかった。既知の粗さ: peer が
   offline で replay しない場合、live タブでは peer の pane にもその IA が
   見える (client は `agent_id ∪ payload.to` で fanout する) が reload で
   消える。厳密化には pane を指す wire field が要る。
2. **Q1 の invalidate trigger set の網羅性** (1493eb4)。`restore` の
   resume 分岐と `resume_session` の 2 経路のみ。runner 起点の relaunch
   (crash-restart / `reset_session`) は意図的に非対象。
3. **因果順の実装分割** (1493eb4)。`WrapperChannel.preflight_inter_agent/2`
   が reject 判定を全部引き受け、`accept_inter_agent/6` 以降は upsert →
   peer push → broadcast → ack だけ、という分割が spec どおりか。
4. **`replay_ia` の pane 注入面**。受信側 pane は peer 名義の envelope を
   持つため `agent_id == topic` 検査を掛けられず、wrapper は自 pane に
   任意の `agent_id` の envelope を注入できる。影響は当該 pane の operator
   表示のみ (ADR の threat model 評価どおり) だが明示確認したい。
5. **`AgentStates` の state 形変更** (1493eb4)。`%{agents, hydration,
   epoch}` へ。`:sys.replace_state` を使う既存 test は追随済みだが、他に
   生の state 形へ依存する箇所が無いか。
6. **送信側 sidecar の記録契機** (186f542)。ack 到着時のみなので
   reject / timeout / ack 喪失では記録されない (D7 (e) 受容)。stamp 無し
   ack (旧 server) も記録せず stderr warn。
7. **dashboard `liveSinceJoin` の窓** (150b3a2)。join → `history` push の
   間だけを覆い、push 処理後に空にする。この窓の定義が D4 step 1 の意図と
   合っているか。

補足: hydration tracker が cap (1000) に達したときも verdict は
`replay_required: true` を返す (4f26cda)。`:not_required` は「投影は無事」
という嘘になり timeline が永久に空になるため。記録なしでも transcript
replay は成立し、`replay_ia` は stale で弾かれ、complete の CAS も外れる
ので次の join で再要求される。

## 30-10 must-fix 対応 (あお、2026-08-08)

1 巡目 must-fix 5 + should 2 を修正済み。差分再レビュー用の要点。

| 項目 | commit | 修正の要 |
|---|---|---|
| M1 | c8ceec8 | `liveSinceJoin` の窓を「接続 generation の join → その接続の history push」へ。`onJoined` (lobby join 応答) で generation を進めて buffer を捨て、`awaitingHistory` の間だけ積む。`history_reset` / `history_cleared` / `agent_deleted` を buffer へ mirror。replay marker に generation を持たせ、epoch 破棄では旧世代のみ落とす |
| M2 | 2428304 / c8ceec8 | 復元行を `history_replay_envelope {pane_agent_id, envelope}` (operator 限定) で broadcast。pane は channel assign 由来。client は指定 pane にのみ注入し fan-out しない |
| M3 | c2f8a2a | sidecar `read()` を `ingress_stamp` 昇順 sort + 同 stamp dedupe の後に newest 200 |
| M4 | c2f8a2a | `sendReplayIa` を JSON 実 byte 長 1MB で chunk。同一 `replay_id` の複数 push を complete 前に送る |
| M5 | c2f8a2a | `ServerLink#sendInterAgent` が acceptance を Promise で返し、`send_to_agent` が await。reject = error result、timeout/ack 喪失 = 配送不明、いずれも reply waiter を解除 |
| S1 | 2428304 | reject 5 種に sender/receiver 両 pane 不変の assert |
| S2 | 2428304 | (a) を partial 残渣が次 attempt の全量で置換されるところまで pin |

test の作り直し (M1/M3 の「前提を手渡ししていた」型への対応):

- `dashboard/test/projectionEpochWindow.integration.test.ts` — App.svelte を
  mount し、`connectKaoiro` だけ差し替えて **実 handler 列**を駆動する。
  「旧 live → disconnect → 新 live → epoch 不一致 history」を含む 6 本 +
  M2 の pane 限定 2 本。各 fix を 1 つずつ戻す mutation で落ちることを確認済み。
- `dashboard/test/replayEnvelopeWire.integration.test.ts` — 実 phoenix client
  で join 応答 → `onJoined`、`history_replay_envelope` → 専用 handler の
  結線を pin。
- `wrapper/agent-common/test/ia_sidecar.test.ts` — stamp 2..201 append 後に
  stamp 1 を追いつかせる逆順 fixture。
- `wrapper/core/test/transport.test.ts` — 200 行 × 60KB で分割前が 8MB を
  超えることを前提 assert した上で、各 chunk が 8MB 未満・全行保持を確認。

S3 (既知の制約、対応不要): sidecar は replay のたびに全量を同期 read する。
長期 session では read コストが線形に伸びる。将来課題として記録のみ。

未対応で ふじ の判断を仰ぎたい点: `InterAgentTool#invoke` は送信**前**に
`#pendingInjections.delete(conversationId)` している。M5 で reject が可視化
された今、拒否されたのに「返信した」扱いで #131 のエラー通知が抑止される
経路が残る。今回の must-fix 範囲外と判断して触っていない。

## Dogfood 検証シナリオ (30-11)

0. deploy: ADR D6 の maintenance 手順(全 agent 停止 → server /
   wrapper / dashboard 同時更新 → 全タブ reload)。
1. 稼働中: 端末 2 台で同一 agent を表示 → 双方 F5 → 同一表示。
2. live IA: agent 間で数往復 → **再起動せず** F5 → 両 pane 一致。
3. 再起動: 片方のタブを開いたまま server container を再起動 →
   wrapper 再接続後、開きっぱなしタブ・新規タブとも現 session 分が
   同一表示(亡霊なし)。
4. IA 復元: IA 往復後に再起動 → IA バブルが両 pane で復元され、
   peer に重複メッセージが届いていない。
5. clear: IA を含む session を `/clear` → 再起動 → clear 済み IA が
   復活しない。
6. offline: wrapper を停止した agent は再起動後 offline tile +
   空 timeline → resume 操作で履歴復元(既存経路の回帰確認)。

## See Also

- ADR: [0051](../adr/0051-history-restart-resilience.md)
- 前提 ADR: [0014](../adr/0014-session-resume-and-restore.md),
  [0030](../adr/0030-agent-directory-and-explicit-restore.md),
  [0036](../adr/0036-session-lifecycle-commands.md)
- Specs: [protocol](../specs/protocol.md),
  [protocol-inter-agent](../specs/protocol-inter-agent.md),
  [deployment](../specs/deployment.md)
