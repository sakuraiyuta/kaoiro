---
title: Phase 30 — 表示履歴の再起動耐性 (ADR-0051)
description: hydration handshake による reconnect 時 replay・IA sidecar と replay 専用 ingress による DETS 撤廃・projection epoch による client 再同期を実装する。
status: draft
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
| 30-1 | ADR-0051 仕様レビュー | ふじ | 🟡 | 1 巡目完了 (must-fix 5 / should 7、反映済み)。改訂版の再レビュー中 |
| 30-2 | ADR 確定 + specs 改訂 | クロエ | ⏳ | protocol.md (ADR D8 の 4 点: `request_history_replay` / replay 専用 IA ingress / ingress stamp / projection epoch)、protocol-inter-agent.md (sidecar schema・pending journal・generation)、architecture.md |
| 30-3 | 既存文書 amendment sweep | もも | ⏳ | ADR D8 の対象一覧: ADR-0014 A4 / ADR-0036 F3 / ADR-0030 D6 store 数 / protocol.md `preserve_inter_agent`・purge store 数 / deployment.md DETS 8 種 → 7 種 |
| 30-4 | wrapper: IA sidecar 記録 | あお | ⏳ | agent-common 共通化、両 engine。受信=注入前 append / 送信=ack 後 append、pending journal → session bind、/new・/clear generation 切替 (ADR D3-1/D3-4) |
| 30-5 | wrapper: hydration handshake + IA replay 送出 | あお | ⏳ | `request_history_replay` 受け口、startup resume replay との single-flight、fresh session の empty-complete、sidecar → `replay_ia` 送出 (ADR D2/D3-2) |
| 30-6 | server: hydration 状態管理 + replay 専用 ingress | あお | ⏳ | AgentStates に hydration state、join 時要求・complete 遷移・切断時巻戻し、`replay_ia` の pane 所有権検証 + 投影のみ upsert、ingress stamp 付与 (配信 + send ack)、clear watermark 比較 (ADR D2/D3-2/D3-3) |
| 30-7 | server: IA DETS 撤廃 + pane 合算 cap | あお | ⏳ | InterAgentHistory と purge 経路の除去、最終投影 newest 200 cap (ADR D6) |
| 30-8 | dashboard: projection epoch 再同期 | あお | ⏳ | 新接続 buffer の分離、epoch 不一致時の baseline 破棄 (logs / clearWatermarks / replay marker / 未読 state) + history と新接続 buffer のみ merge、epoch absent fallback (ADR D4) |
| 30-9 | docs 整合 sweep | もも | ⏳ | 実装後の README / specs 齟齬確認 |
| 30-10 | 実装レビュー | ふじ | ⏳ | must-fix ループ |
| 30-11 | dogfood 検証 | デフォルトくん + マスター | ⏳ | 検証シナリオは下記 |

Status legend: ✅ done, 🟡 in progress, ⚠ partial, ⏳ not started,
⛔ blocked.

## Acceptance Criteria

基本要件:

- [ ] server 再起動後、live wrapper の agent timeline が operator
      操作なしで現 session 分復元される(claude-code / codex 両方)
- [ ] IA バブルが sidecar + `replay_ia` 経由で復元され、replay が
      IA の再配送(peer への再 push・SDK 再注入)を一切起こさない
- [ ] `InterAgentHistory` DETS がコードベース・deployment doc から
      消えている
- [ ] 再起動前から開いていたタブが再起動前ログを表示し続けない。
      複数端末で同一表示になる
- [ ] server 稼働中の F5 全復元・端末間一致が従来どおり成立する
      (回帰なし)
- [ ] 全テスト green(server `mix test` / wrapper `pnpm test` /
      dashboard `pnpm test`)

failure matrix(ふじ 1 巡目 should-7。テストまたは dogfood で
カバーし、対応を明記する):

- [ ] (a) replay 途中(reset 後 partial)で wrapper 切断 → 再接続で
      再要求され完全な timeline に到達する
- [ ] (b) startup resume replay と server 要求 replay の競合が
      single-flight で 1 本に合流する
- [ ] (c) server 生存中の wrapper 再接続では無駄 replay が走らない
- [ ] (d) fresh session(session_id nil / transcript 無し)は
      empty-complete で hydrated になる
- [ ] (e) `/new`・`/clear`・rollback・旧 session resume・
      `clear_history` の各操作後に clear 済み IA が復活しない
      (ingress stamp 比較)
- [ ] (f) sender / receiver の片方 offline でも他方の pane が独立に
      復元される
- [ ] (g) server 合成 IA(エラー直送通知)が受信側 sidecar 経由で
      復元される
- [ ] (h) transcript + IA 合算で 200 件超のとき最終投影が newest 200
      に cap される(201 件・400 件境界)
- [ ] (i) epoch 不一致 + history 到着前の live envelope 到着で、
      live 行を失わず亡霊だけ消える
- [ ] (j) rolling upgrade 4 象限(新旧 server × 新旧 wrapper/client)
      が ADR D6 rollout matrix どおり degrade する
- [ ] (k) sidecar の途中切れ・破損行が skip され replay が
      継続する

## Dogfood 検証シナリオ (30-11)

1. 稼働中: 端末 2 台で同一 agent を表示 → 双方 F5 → 同一表示。
2. 再起動: 片方のタブを開いたまま server container を再起動 →
   wrapper 再接続後、開きっぱなしタブ・新規タブとも現 session 分が
   同一表示(亡霊なし)。
3. IA: agent 間で数往復させてから再起動 → IA バブルが両 pane で
   復元され、peer に重複メッセージが届いていない。
4. clear: IA を含む session を `/clear` → 再起動 → clear 済み IA が
   復活しない。
5. offline: wrapper を停止した agent は再起動後 offline tile +
   空 timeline → resume 操作で履歴復元(既存経路の回帰確認)。

## See Also

- ADR: [0051](../adr/0051-history-restart-resilience.md)
- 前提 ADR: [0014](../adr/0014-session-resume-and-restore.md),
  [0030](../adr/0030-agent-directory-and-explicit-restore.md),
  [0036](../adr/0036-session-lifecycle-commands.md)
- Specs: [protocol](../specs/protocol.md),
  [protocol-inter-agent](../specs/protocol-inter-agent.md),
  [deployment](../specs/deployment.md)
