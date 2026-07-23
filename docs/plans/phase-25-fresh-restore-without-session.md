---
title: Phase 25 — session_id なし offline agent の fresh-restore
description: /clear 直後・未発話のまま全再起動 (dogfood.sh) したエージェントが offline 復元候補に出るのに restore が :no_session で弾かれ ⚠ になる問題を解消。SessionPointer に session_id が無くても cwd/engine/persona/snapshot から fresh spawn + resume snapshot 再適用で「同じ model/effort/engine/permission 設定」のエージェントとして復元する。
status: in-progress
phase: 25
depends_on: [22, 23]
last_updated: 2026-07-23
---

# Phase 25 — session_id なし offline agent の fresh-restore

## Goal

dogfood.sh 等で runner/wrapper/server/client を全再起動した際、`/clear`
直後または未発話のまま (session_id 未報告のまま) だったエージェントも、
dashboard の復元操作で **前回と同じ model / effort / engine /
permission 設定の fresh session として復元できる**ようにする。

## 症状と根本原因 (2026-07-23 調査確定)

症状: 全再起動後、`/clear` 等で新規セッションを立ち上げただけの
エージェントが offline 復元候補に表示されるが、復元ボタンを押しても
⚠ (spawn_error sticky icon) が出て復元できない。

原因連鎖:

1. `/clear` は ADR-0036 F3 追補どおり `SessionPointers.detach_session`
   で session_id を **明示 nil** にする (cwd / engine / snapshot は保持)。
   また未発話セッションは SDK が init を出さないため session_id が
   一度も報告されない (ADR-0014 Q-A4)。どちらも pointer は
   `%{session_id: nil, cwd, engine, snapshot}` の形になる。
2. 全再起動後、当該 agent は AgentDirectory 由来の offline tile として
   表示され、復元ボタンは ADR-0030 D8 どおり無条件表示される。
3. server の restore handler が使う `session_pointer/1`
   (`agents_channel.ex`) が `is_binary(session_id)` を要求するため
   `{:error, :no_session}` で reject → `spawn_result` error → ⚠。
   復元手段が delete + 手動再 launch しかない。

復元に必要な情報は全て永続済み: persona (AgentDirectory)、cwd / engine
(SessionPointers)、model / model_source / effort / effort_source /
permission_mode / sandbox / network_access (pointer の resolved
snapshot — wrapper は初回 state_change から `ext.effective` を
optimistic stamp する (phase-15 15-4b) ため未発話でも記録される)。
欠けているのは「session_id なしの pointer を fresh spawn + snapshot
再適用で復元する経路」のみ。

## Decision (design)

**fresh-restore**: restore 対象の pointer が `session_id: nil` かつ
cwd を持つ場合、`resume_session_id` を積まない spawn payload に新規
optional flag `apply_resume_snapshot: true` を立てて runner へ relay
する。runner は flag が立った fresh spawn に限り、resume 経路と同一の
`applyResumeSnapshot` (5-case pair rule 含む) を ParsedSpawn に適用して
launch する。

- **snapshot apply の SSOT は runner のまま** (ADR-0014 F1 追補
  phase-22「server は relay のみ、top-level 二重表現禁止」を維持)。
  server 側で snapshot を top-level launch picks に展開する案は、
  5-case pair rule の Elixir 重複実装 + `*_source` の嘘 stamp を招く
  ため不採用。
- **T3 / F4 は不要**: session file を読まないので existence check も
  same-session lock も対象外。`#launchSpawn` へ直行する。
- **LaunchDialog の fresh spawn は不変**: flag なし fresh spawn は
  従来どおり snapshot を apply しない (藤 D1、operator の launch 選択
  を黙って上書きしない原則)。
- **後方互換**: 旧 runner は未知 field を無視 → engine default の
  fresh spawn に degrade (復元自体は成功、設定は default)。旧 server
  + 新 runner は flag が来ないので完全不変。
- snapshot が nil の pointer (きわめて古い record 等) は
  `resume_snapshot` 自体が payload に乗らず、runner apply は no-op →
  engine default で fresh 復元 (fail-soft、復元不能よりよい)。

## Scope / タスク

| # | task | file | status |
|---|------|------|--------|
| 25-1 | protocol: `SpawnMessage.apply_resume_snapshot?: boolean` 追加、`resume_snapshot` の doc comment を「resume_session_id または apply_resume_snapshot と併走」に更新 | `protocol/src/index.ts` | done |
| 25-2 | server: `session_pointer/1` を「cwd 必須・session_id は nil 許容」の形に緩和 (返値 `{:ok, session_id_or_nil, cwd, engine}`)。pointer 不在 / cwd なしは従来どおり `:no_session` | `server/lib/kaoiro_server_web/channels/agents_channel.ex` | done |
| 25-3 | server: `build_restore_payload` — session_id nil のとき `resume_session_id` を omit し `"apply_resume_snapshot" => true` を put (binary のときは現行どおり) | 同上 | done |
| 25-4 | server: `resume_disconnected` (operator 明示 session pick) は cwd/engine のみ pointer から取るよう修正 — pointer session_id が nil でも explicit resume が通るように | 同上 | done (session_pointer/1 の緩和で自動的に通るようになったため個別修正なし) |
| 25-5 | server tests: (a) nil-session pointer への restore が resume_session_id なし + apply_resume_snapshot + resume_snapshot 付き spawn を broadcast する (b) pointer 不在 / cwd なしは :no_session 維持 (c) resume_disconnected が nil-session pointer + explicit sid で通る | `server/test/kaoiro_server_web/channels/agents_channel_test.exs` | done (5 case 追加、server 全 433 tests 全緑) |
| 25-6 | runner: `parseSpawn` に optional boolean `apply_resume_snapshot` → `ParsedSpawn.applyResumeSnapshot`。`handleSpawn` の fresh 分岐で flag 時のみ `applyResumeSnapshot(parsed, parsed.resumeSnapshot, engine)` 適用後 `#launchSpawn` (T3/F4 なし) | `runner/src/supervisor.ts` | done |
| 25-7 | runner tests: (a) flag + snapshot 付き fresh spawn で model/effort/permission_mode/sandbox/network_access が snapshot 由来で launch される (b) flag なし fresh spawn は従来どおり apply されない regression pin (c) flag + snapshot なしは engine default | `runner/test/supervisor.test.ts` | done (4 case 追加、runner 全 236 tests 全緑) |
| 25-8 | docs: `docs/specs/protocol.md` spawn message に field 追記、ADR-0030 (D8) / ADR-0014 (F1 追補) に fresh-restore 追補 | docs | done |
| 25-9 | 手動 dogfood 検証 (下記) | — | pending (マスター環境で実施予定) |

**scope 外**:
- client 変更なし (復元ボタンは既に無条件表示、成功すれば ⚠ は既存
  ロジックで消える)。
- 「session_id はあるが JSONL が消えている」T3 失敗時の fresh-restore
  fallback (今回の repro には含まれない。必要になったら別 phase)。
- host runner が offline のままの復元失敗 (既存挙動のまま)。

## 検証 (25-9 dogfood)

1. Claude agent を明示 model/effort/permission で launch → 未発話のまま
   dogfood.sh 全再起動 → 復元 → 同設定で live になること (dashboard の
   model / effort / permission 表示と `ext.effective` を確認)。
2. 会話済み agent に `/clear` → 未発話のまま全再起動 → 復元 → `/clear`
   前と同じ実効設定 (snapshot は detach を跨いで保持) で live に
   なること。
3. Codex agent でも 1 を実施 (sandbox / network_access が snapshot
   どおり)。
4. 回帰: session_id ありの通常 restore、LaunchDialog fresh spawn、
   reset (/new, /clear)、switch_session が不変であること
   (test suite + 目視)。

## Risks

- wrapper が初回 state_change で stamp する `ext.effective` の内容が
  engine / タイミングにより sparse な場合、fresh-restore は sparse な
  分だけ engine default に落ちる (安全側)。25-5/25-7 のテストで
  「snapshot に入っている値は必ず復元される」ことのみ保証する。
- `apply_resume_snapshot` を悪用しても snapshot は server 側 write-side
  + runner 側 read-side の二重 sanitize 済みで、既存の resume 経路と
  同じ trust boundary (ADR-0014 F1 追補) の内側。新規の権限昇格面は
  増えない。
