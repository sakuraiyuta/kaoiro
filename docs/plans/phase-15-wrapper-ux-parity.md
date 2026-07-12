---
title: Phase 15 — wrapper UX parity (Claude Code と Codex の使い勝手対称化)
description: phase-14 完了後の実運用検証で顕在化した Claude / Codex 間の UX 非対称の解消。model 解決経路の対称化と source 明示、権限二軸 UI 拡張、engine 別 config field の loud warn 化、session capabilities による engine 中立化、resume 時の設定差分検出、docs 整備を含む。
status: completed
phase: 15
depends_on: [phase-14-codex-adapter]
last_updated: 2026-07-12
---

# Phase 15 — wrapper UX parity (Claude Code と Codex の使い勝手対称化)

## Goal

[ADR-0032](../adr/0032-codex-adapter.md) F4bc 追補 + [ADR-0033](../adr/0033-permission-model-dual-axis.md) F4 追補 + [ADR-0034](../adr/0034-session-capabilities-advertisement.md) F1-F5 の実装 phase。もも (Codex agent) 実運用視点で明らかになった非対称項目を、engine 中立な envelope schema (`ext.model_source` / `ext.session_capabilities` / resume 差分 snapshot) と UI 拡張で解消し、「Claude Code と同じノリで Codex を使える」状態を目標とする。

phase-14 の acceptance は engine としての稼働が主眼だった。本 phase は稼働後の「日常運用で気になる非対称」の解消 phase。

## 背景 (非対称の実感)

もも (Codex agent) と ao (Claude agent) の 2026-07-11 実運用検証で顕在化した非対称項目 (D1-D8):

- **D1 model 解決の非対称**: `KAOIRO_WRAPPER_DEFAULT_MODEL` が Claude CLI にのみ effect、Codex CLI では無視。envelope / UI / log に model source が出ず、operator が「config 指定 / env / account 既定 / 解決不能」を区別できない。共有 env は `dev.sh` の `claude-opus-4-7` が Codex spawn に流れて ChatGPT-auth 経路で 400/404 を踏む事故源
- **D2 権限 UX の非対称**: Claude 単軸 mode の実効値と Codex 二軸 (sandbox × approval=never 固定) の host-fixed 制約が UI で見えない。承認ダイアログが出る前提の Claude UX と、範囲外は質問せず失敗する Codex UX の gap
- **D3 config field silently ignored**: Codex に `permission_mode`/`allowed_tools` を書いても、Claude に `sandbox`/`network_access` を書いても黙って無視される設定事故源
- **D4 Attachment 非対称の不可視化**: Codex は attach_open を wholesale reject するが、Composer 側で事前 hint なし。判定を engine 名で分岐すると将来 Codex 進化 (画像入力等) で false negative
- **D5 質問 dialog 可用性の判定軸**: Free/Go plan で `ask_user_question` が使えない可能性など、session 単位の可用性差を engine 名で表現不能
- **D6 docs 非分離**: `kaoiro.config.example.json` は engine=claude-code の例のみ。engine × config field / env 対応表がない
- **D7 起動時の実効設定不可視**: resolved config が operator に見えず、config / env / SpawnMessage のどれが効いているか把握不能
- **D8 resume 時の設定差分**: resume 前後で model / 権限が変わる事故 (別 spawn からの復帰) を検知する経路がない

## Acceptance Criteria

- [ ] D1: 両 CLI が engine 別 env (`KAOIRO_CLAUDE_CODE_DEFAULT_MODEL` / `KAOIRO_CODEX_DEFAULT_MODEL`) を読み、解決優先度 `launch > env > config > default` を CLI 内部で明示的に実装。旧 `KAOIRO_WRAPPER_DEFAULT_MODEL` は Claude CLI のみで 1 リリース窓 deprecation warn、Codex CLI は無視 (ADR-0032 F4bc 追補)
- [ ] D1: envelope に `ext.model_source: "launch" | "env" | "config" | "default"` を stamp。両 engine 実装。AgentDetail の「アカウント既定」ラベル判定が engine 名分岐から `model_source === "default"` 判定へ置換 (Codex 特例撤去)
- [ ] D2: AgentDetail の Claude switcher が選択後の実効値 (書込 sandbox / 承認 approval) をラベル併記。Codex 側は「承認: never (host-fixed, upstream 制約)」バッジを常設表示 (ADR-0033 F4 追補)
- [ ] D2: LaunchDialog に engine=claude-code 選択時の permission_mode セレクトを新設 (6 値、二軸 tooltip 併記)。SpawnMessage.permission_mode をサーバから wrapper に relay、起動時 mode に反映
- [ ] D2: AgentDetail 権限枠を「作業意図 (mode)」と「実効書込範囲 (sandbox)」の 2 枠並列表示
- [ ] D3: Codex CLI 起動時、`permission_mode` / `allowed_tools` の指定を検出したら stderr に `config warn: <field> is claude-code-only, ignored on codex` を 1 行出力
- [ ] D3: Claude CLI 起動時、`sandbox` / `network_access` の指定を検出したら stderr に `config warn: <field> is codex-only, ignored on claude-code` を 1 行出力
- [ ] D7: 両 CLI 起動時に stderr へ `[wrapper resolved] engine=<id> model=<name>(source=<launch|env|config|default>) effort=<v>(source=..)? sandbox=<v>(source=..) network_access=<b> approval=<v>(host-fixed?) permission_mode=<v>(ignored?) allowed_tools=<n>(ignored?) persona=<id>` を 1 行出力 (**effort は明示指定時のみ含める、未指定なら省略**)。runner tee 経路で operator log にも露出
- [ ] D8: envelope に `ext.resume_snapshot`(session 開始前の resolved 値) と `ext.effective` (今回強制した値) を stamp、差があれば `ext.resume_drift: {field, prev, now}[]` を並置。stderr warn + AgentDetail バッジで露出。resume 経路のみ発動、fresh spawn では出さない
- [ ] envelope に `ext.session_capabilities` を stamp (両 engine 実装、ADR-0034 F1/F4)。フィールド: `supports_attachments` / `supports_user_input_dialog` / optional `user_input_modes`。**stamp タイミングは spawn 直後の最初の state_change から** (session_init 相当のイベントを待たない。Codex は `thread.started` が初ターンまで遅延するため、待つと fail-closed default で誤表示になる。ADR-0034 F1)
- [ ] Composer の添付ボタンが `ext.session_capabilities.supports_attachments === true` のときのみ enabled、それ以外は disabled + tooltip「このセッションでは未対応」 (ADR-0034 F3)。engine 名判定は削除
- [ ] AgentDetail の質問 UI 系が `supports_user_input_dialog` を見る (`user_input_modes` 指定時は現在 mode との照合で条件付き未対応表示)。engine 名判定は削除
- [ ] `wrapper/kaoiro.config.example.json` を engine 別に分割し、engine × config field / env の対応表を `wrapper/README.md` に追加。`scripts/dev.sh` の env export を engine 別に書き換え、コメントで対応を明記
- [ ] **起動直後から resolved model / effort / mode が dashboard に表示** される (Claude / Codex 両 engine): wrapper が起動時に config / launch 由来の resolved 値を `ext` に**楽観 stamp** し、SDK 報告受信時に**値のみ**上書きする。**source 意味論に注意**:
  - **明示指定時 (launch / env / config)**: 起動直後から `model` + `model_source=launch|env|config` を stamp。SDK 確認後も **source は launch/env/config を維持** (値の由来を伝える field なので、SDK 確認で `default` に書き換えると「アカウント既定を使った」と嘘をつく)。値のみ SDK 報告で更新される可能性はある (Claude が alias を正規名に展開する等)。
  - **未指定時**: 起動直後は `model` / `model_source` とも stamp なし。SDK 報告受信時に `model` + `model_source="default"` が初出現する。
  - **例外: effort は起動時に明示指定 (config.effort / launch.effort) が無い場合、wrapper が SDK 既定値を知らないため stamp しない** (明示指定時のみ即表示、未指定は SDK 報告待ちが正確な仕様)。`effort_source` も同 semantics。
- [ ] wrapper 全パッケージ (core / agent-common / claude-code / codex) のテスト全通過。dashboard / server / runner の regression テスト全通過。protocol の envelope 型追加が両 engine と dashboard を通してエンドツーエンドで検証されている

## Tasks

初回スコープ (今すぐ): D1 + D8 (envelope schema 面) → D7 (起動時ログ) → D3 (silently ignored warn) → D2 (UI 拡張) の順。次スコープ: D4 (session capability advertise + Composer 差替え) + D6 (docs 整備) を D1-D8 が固まった後に着手。将来: D5 (Free plan での `ask_user_question` 不可検証)。

| # | Task | Priority | Status | Notes |
|---|------|----------|--------|-------|
| 15-1 | `@kaoiro/protocol` の envelope 型に `ext.model_source` / `ext.effort_source` / `ext.session_capabilities` / `ext.resume_snapshot` / `ext.effective` / `ext.resume_drift` を追加 | initial | ✅ | 型追加のみ、stamp 実装は各 adapter task。実施 `f299f4b` (2026-07-11、あお)。全 5 パッケージ typecheck 通過確認済 |
| 15-1b | 追補 specs の反映 (phase-14 の 14-17 相当): `docs/specs/protocol.md` に上記 ext 新 field 群と source 意味論 (明示指定は維持 / 未指定は default 初出現)、`docs/specs/plugin-model.md` に `EngineAdapter` から見た capability advertise の path、`docs/specs/codex-sdk-events.md` に `thread.started` を待たず spawn 直後 stamp の注記、`docs/specs/agent-sdk-events.md` に楽観 stamp の Claude 側実装位置と `SDKSystemMessage(init)` との関係を反映 | initial | ✅ | phase-14 で保持していた spec 追補 task の復活 (status drift 再発防止、project CLAUDE.md workflow rule)。ADR-0032/0033/0034 の追補内容と cross-link、ADR-0035 F4 (将来 field) への forward pointer も含む。実施 `a77e190` (2026-07-11、あお) |
| 15-2 | Claude CLI (`wrapper/claude-code/src/cli.ts`) の env 解決を engine 別 env `KAOIRO_CLAUDE_CODE_DEFAULT_MODEL` に切替、旧 `KAOIRO_WRAPPER_DEFAULT_MODEL` は deprecation warn 経路で読む (D1) | initial | ✅ | ADR-0032 F4bc 追補、旧 env は 1 リリース窓、次リリースで撤去。あお着手分をクロエが引き継ぎ完成 (2026-07-11、`envDefaultModel` 宣言 + warn + TODO(#103)) |
| 15-3 | Codex CLI (`wrapper/codex/src/cli.ts`) の env 解決に `KAOIRO_CODEX_DEFAULT_MODEL` を新設配線。旧 `KAOIRO_WRAPPER_DEFAULT_MODEL` は完全無視 (D1) | initial | ✅ | ChatGPT-auth 経路の 400/404 事故を構造的に防ぐ。実施 `4ab0658` (2026-07-12、あお)。5 パッケージ typecheck + Codex test 22/22 pass |
| 15-4 | 両 CLI で `ext.model_source` を stamp。AgentDetail の「アカウント既定」ラベル判定を engine 名分岐 (e89fa98) から `model_source === "default"` 判定へ置換 (D1) | initial | ✅ | adapter 側 stamp は `c44b89d` (2026-07-12、あお) で実装、AgentDetail の Codex 特例撤去 (`isCodexAgent` → `isAccountDefault = modelSource === "default"`) は `7f3c880` (2026-07-12、あお、chunk B-1) で完了。protocol.ts に `modelSourceFrom` helper を追加、行 1220 の判定を engine 名分岐から model_source 判定へ置換。行 1323 の `isCodexAgent` は permission UI (ADR-0033 F3 明示例外) で意図的保持。svelte-check clean、trivial tier my-review findings 0 |
| 15-4b | `wrapper/claude-code/src/host.ts` の `#statusExt` (host.ts:842-852) の null ガードを **明示指定時のみ外して** 起動時に config / launch 由来の resolved 値を楽観 stamp、`model_source` を launch/env/config で同時 stamp。**未指定時は null ガード維持** (SDK 報告受信で model + model_source="default" が初出現するまで stamp しない)。SDK 受信時は**値のみ上書き**し `model_source` は変えない (launch/env/config は SDK 確認後も維持)。`permission_mode` / `fast_mode` は Claude engine 唯一の場所なので同様に楽観 stamp + 上書き。**effort のみ例外**: 明示指定時のみ stamp、未指定は SDK 報告待ち | initial | ✅ | 追加受入条件「起動直後表示」の実装。**UI 差別化 (subtle hint) は行わない (director 判断確定、2026-07-11)** — 値の由来は `model_source` ラベルが伝えるため、二重の視覚表現は不要。実施 `c44b89d` (2026-07-12、あお)。constructor で楽観 stamp、`#applyInitMeta` と `#refreshContextUsage` に source semantics guard 追加 (review-cycle advisory)。unit test 3 件追加 (config 維持 / env 維持 / 未指定 default 初出現) 全 pass |
| 15-4c | `wrapper/codex/src/host.ts` の `#statusExt` も同じ原則で対称化。現状 `#model` は初期化時に `config.model or null` を保持する。**明示指定時**は起動時 stamp + `model_source` を launch/config で。**null (未指定)** のとき account default 委任なので stamp しない (D1 と整合、model_source も未 stamp)。SDK 報告受信時に model + `model_source="default"` が初出現。effort も明示指定時のみ stamp | initial | ✅ | source semantics (明示は維持、未指定は default 初出現) の統一と effort 例外の明文化。実施 `c44b89d` (2026-07-12、あお)。CodexHostOptions に modelSource / effortSource 追加、#statusExt に stamp。unit test 2 件追加 (config で stamp / 未指定は stamp なし) 全 pass |
| 15-5 | 両 CLI 起動時 stderr に `[wrapper resolved] ...` の 1 行を出力 (D7) | initial | ✅ | ADR-0032 F4bc 追補、fields は Acceptance Criteria 参照。実施 `8ff9feb` (2026-07-12、あお)。engine-relevant field を engine 側で完全形、engine-mismatch field は ignored flag 付き。effort は明示指定時のみ、approval=never(host-fixed) は Codex のみ |
| 15-6 | Codex CLI で `permission_mode` / `allowed_tools` 検出時 stderr warn (D3) | initial | ✅ | `wrapper/core/src/persona.ts` の parseConfig は既に両 field を受理するので、CLI 側で engine 別 warn を追加。実施 `8ff9feb` (2026-07-12、あお) |
| 15-7 | Claude CLI で `sandbox` / `network_access` 検出時 stderr warn (D3) | initial | ✅ | 上と対称。実施 `8ff9feb` (2026-07-12、あお) |
| 15-8 | resume 経路で前回 session の resolved snapshot を復元し `ext.resume_snapshot` に stamp、今回強制値を `ext.effective` に stamp、差分を `ext.resume_drift` へ (D8) | initial | ✅ | snapshot 復元経路は director 判断で **server 側 `SessionPointers` 拡張** を lean とする ([ADR-0014](../adr/0014-session-resume-and-restore.md) F1 追補、agent-scoped snapshot semantics を明文化、DETS 5-tuple 拡張)。snapshot semantics は「session 中に最後に実効だった値」で mid-session 切替を反映、director 明確化 2026-07-11。実施 `a658086` (server schema + snapshot semantics test 5) → `482d254` (end-to-end relay: server / runner / wrapper) → `7840cc4` (post-review Finding 1: helper を build_restore_payload に移動、非 live resume 経路の dead letter 修正) → `40e185e` (post-review Finding 2: live-agent switch_session の resume_snapshot relay、server + runner)。post-commit review-cycle `wf_27beb483-bd1` (medium, 2/2 verify) で HIGH 2 件検出 → 全 fix、`.claude/from-review.md` に audit 記録 |
| 15-9 | AgentDetail に `ext.resume_drift` バッジ表示 (D8) | initial | ✅ | 差がある field ごとに (prev → now) を明示。wrapper 側の ext.resume_drift stamp は 15-8 `482d254` で完了 (両 host の `#statusExt` に `computeResumeDrift` の結果を並記)。AgentDetail の consumer 描画は `4623799` (2026-07-12、あお、chunk B-1) で完了 — protocol.ts に `ResumeDriftEntry` 型 + `resumeDriftFrom` helper (modelSourceFrom / permissionFrom と同型 defensive parse) を追加、fresh spawn (undefined) と clean resume (empty array) を UI で区別しない設計 (どちらも badge 非表示)、`fmtDriftValue` で undefined を「(未設定)」明示。unit test 5 件追加 |
| 15-10 | ADR-0033 F4 追補: AgentDetail の Claude 現行 mode label に実効値バッジ (書込 / 承認) 常設 (D2) | initial | ✅ | 既存 `.axes-hint` (候補側) を選択後 label にも展開。実施 `4623799` (2026-07-12、あお、chunk B-1)。`displayPermLabel = permLabel ?? "default"` 経由で init 前 (permLabel null) のフレームでも default の実効値を露出 (post-review advisory 反映) |
| 15-11 | AgentDetail の Codex agent 権限枠に「承認: never (host-fixed, upstream 制約)」バッジを常設 (D2) | initial | ✅ | link は codex-exec-approval-upstream。実施 `4623799` (2026-07-12、あお、chunk B-1)。実効書込範囲 badge の 承認 側に `.axes-hostfixed` span で (host-fixed) を常設、title tooltip に「upstream 制約 (codex-exec-approval-upstream)」 |
| 15-12 | LaunchDialog に engine=claude-code 選択時の permission_mode セレクト新設 (二軸 tooltip 併記)、SpawnMessage.permission_mode の relay (D2) | initial | ✅ | `SpawnRequest` / `SpawnMessage` に `permission_mode` を追加 (`@kaoiro/protocol` 型追加)。実施 `77504ad` (2026-07-12、あお、chunk B-3、破壊窓第 2 号)。**priority「SpawnMessage 明示 > store 永続値」実装**: build_spawn_payload で有効 enum 値を relay と同時に `KaoiroServer.PermissionModes.record` することで store も同期、後続 after_join push が SpawnMessage 経由の値を「上書き」ではなく「一致 reinforcement」化。restore 経路 (build_restore_payload) は piped せず store 値へ自然に落ちて継続。runner は PERMISSION_MODE_VALUES whitelist + fail-loud null、resolveWrapperConfig 経由で wrapper config.permission_mode に passthrough。wrapper 変更不要 (config.permission_mode を既に run() で受理、クロエ preflight 確認済) |
| 15-13 | AgentDetail 権限枠を「作業意図 (mode)」と「実効書込範囲 (sandbox)」の 2 枠並列表示に再構成 (D2) | initial | ✅ | ADR-0033 F4 追補。実施 `4623799` (2026-07-12、あお、chunk B-1)。dt を「作業意図」「実効書込範囲」に相対配置 (意図 → 実効の narrative order)、Codex は F3 (launch-fixed) により作業意図側は switcher 非表示 (既存 branch を保持) |
| 15-14 | 両 adapter の `#statusExt` に `ext.session_capabilities` を stamp (ADR-0034 F1/F4) | initial | ✅ | Claude: attachments true / dialog true。Codex: attachments false / dialog true。実施 `cc8aa7c` (2026-07-12、あお)。static literal で始め、SDK 側で条件が付いたら field 化で分岐する形。unit test 2 件追加、Claude 152 / Codex 25 全 pass。review-cycle trivial tier で advisory 2 (comment 精度) 反映、advisory 1 (result envelope へ session_capabilities 伝播) は既存 Codex pattern 由来で報告のみ |
| 15-15 | Composer の添付ボタン enable/disable を `ext.session_capabilities.supports_attachments` で判定 (engine 名判定を削除) | next | ✅ | D4 の中核。実施 `1522b7a` (2026-07-12、あお、chunk B-2)。fail-closed (caps 未 stamp / false → disabled + tooltip「このセッションでは未対応」)、`addStagedFiles` の choke point で picker / drop / paste を一括 gate、attach button に `disabled` + tooltip 切替。engine 名判定は Composer 経路に存在しなかったので `agentEngine === "codex"` 参照は増やさず、capability advertise 経由のみで挙動が分岐 |
| 15-16 | AgentDetail 質問 UI 系を `supports_user_input_dialog` / `user_input_modes` で判定 (engine 名判定を削除) | next | ✅ | D5 準備、現状は無条件 true なので UI 挙動は変わらない。実施 `1522b7a` (2026-07-12、あお、chunk B-2)。judge `userInputDialogAvailability(caps, currentMode) → "unsupported" | "conditional-off" | "on"` を導入 (fail-closed default: caps null → unsupported)。unsupported の質問 dock は defensive に非描画、conditional-off は composer 上の `.caps-hint` で proactive 表示。両 adapter は現状 unconditional true advertise なので現状 UI 挙動不変 (D5 側の adapter 変更に UI 側追加改修不要) |
| 15-17 | `wrapper/kaoiro.config.example.json` を `kaoiro.config.claude-code.example.json` と `kaoiro.config.codex.example.json` に分割 (D6) | next | ✅ | 各 engine で効く field のみ含む。実施 (2026-07-12、あお)。Claude 例は `model` + `permission_mode`、Codex 例は `sandbox` + `network_access` (Codex は catalog なしで account default 委任のため `model` は含めない)。docs/adr/0031、docs/specs/personas.md の cross-ref も新ファイル名へ更新 |
| 15-18 | `wrapper/README.md` に engine × config field / env 対応表を追加 (D6) | next | ✅ | Markdown table、engine 別 field を明示。実施 (2026-07-12、あお)。共通フィールド / engine × field / env × engine の 3 表構成、「無視」欄は D3 の loud warn 対象を示す。旧 env 撤去 (#103) と ADR-0032 F4bc 解決順への forward pointer 含む |
| 15-19 | `scripts/dev.sh` の env export を engine 別 (`KAOIRO_CLAUDE_CODE_DEFAULT_MODEL`) に書き換え、コメントで新旧対応を明記 (D6) | initial | ✅ | **initial 前倒し (director 判断、2026-07-11)** — 15-2 実装直後の dev 環境で旧 env の deprecation warn が毎起動で鳴り続ける事故を避けるため。15-2 引き継ぎとセットでクロエ実施 (2026-07-11) |
| 15-20 | wrapper 全パッケージ / dashboard / server / runner の regression テスト全通過確認 | initial | ✅ | endpoint-to-endpoint (envelope 追加 field が両 engine → dashboard を通る)。実施 (2026-07-12、あお)。全パッケージ regression: protocol / runner typecheck、runner vitest / wrapper 4 pkg (core/agent-common/claude-code/codex) test 全 pass、server/assets svelte-check 331 files 0 err + vitest 87 pass、mix format clean + mix test 315 pass。audit 3 観点判定: **(a1)** Codex `#emitResult` の session_capabilities 伝播は redesign 不要 (Claude host も同じ pattern、ext は full status snapshot として envelope 種別横断で一貫、downstream consumer は envelope 種別非依存で無害); **(a2)** chunk 2 (`482d254`) end-to-end 経路は server (build_spawn_payload/build_restore_payload の `maybe_put_resume_snapshot` / wrapper_channel の `record_snapshot`) → runner (ParsedSpawn/parseSpawn/resolveWrapperConfig の resumeSnapshot 経路) → wrapper (両 host の `#resumeSnapshot` + `computeResumeDrift`) → dashboard (`resumeDriftFrom` + AgentDetail バッジ、15-9 で完了) まで全通過確認、post-review fix `7840cc4`+`40e185e` も反映済; **(b)** 15-14 negative test は両 adapter (`wrapper/claude-code/test/host.test.ts:248` + `wrapper/codex/test/host.test.ts:327`) で「session_capabilities が envs[0] で unconditional に stamp される (init 到達待たず)」を `toEqual({...})` で断言、field 欠落 (undefined) や partial は toEqual mismatch で検出; **(c)** protocol 新 field 群 (`ext.model_source` / `effort_source` / `session_capabilities` / `resume_snapshot` / `effective` / `resume_drift`) の E2E 検証は「shared `@kaoiro/protocol` 型 + 各 layer 独立テスト」の既存モデルで達成 — wrapper 側 stamp テスト・dashboard 側 defensive-parse テスト (`modelSourceFrom` / `resumeDriftFrom` / `sessionCapabilitiesFrom` / `userInputDialogAvailability`)・server 側 relay テスト (spawn permission_mode 2 case) が層ごとに揃い、shared 型がレイヤ間契約を保証 |

Status legend: ⏳ not started, 🟡 mostly done, ⚠ partial, ✅ done, ⛔ blocked.

Priority legend: **initial** = 今すぐ (D1/D2/D3/D7/D8)、**next** = 次スコープ (D4/D6)、**future** = 将来 (D5)。

## Followups (次スコープ / 将来対応)

- **D5 Free/Go plan での `ask_user_question` 不可検証**: 現状は `supports_user_input_dialog: true` 無条件 advertise。Free / Go 認証環境で実挙動を確認し、`user_input_modes` として制約を advertise する対応は future。session_capabilities の判定軸自体 (ADR-0034 F1/F2) は本 phase で完成しているため、追加は adapter 実装のみ。
- **旧 env `KAOIRO_WRAPPER_DEFAULT_MODEL` 撤去 sunset**: 本 phase で 1 リリース窓 deprecation warn を実装、**次リリース窓で撤去**。追跡 issue [#103](https://gitea.example.invalid/sakurai.yuta/kaoiro/issues/103) (chore / priority-low / deferred、着手条件は D1 リリースの次リリース)。コード内では 15-2 (Claude CLI 側の deprecation 読み経路) に短い TODO コメントを補助で残し、#103 と cross-link する。
- **engine 名判定の機械検出 (lint)**: [ADR-0034](../adr/0034-session-capabilities-advertisement.md) F3 の「UI は engine 名で機能可用性を判定しない」原則は本 phase のレビュー禁則 + 既存 `/my-code-review-cycle` で当面担保する。**phase-15 スコープ外を維持**、機械検出 (custom lint rule / ripgrep hook 等) は違反が review をすり抜けた事例が出た時点で chore issue として再検討する。
- **[codex-exec-approval-upstream](../open-questions/codex-exec-approval-upstream.md)**: Codex の対話的承認は upstream の `exec_permission_approvals` stable 化待ち。本 phase は起動時固定二軸 (ADR-0033 F3) を保持。
- **[codex-cwd-extraction](../open-questions/codex-cwd-extraction.md)**: 本 phase のスコープ外、既存判定を維持。
- **Codex model catalog復活**: [ADR-0035](../adr/0035-codex-model-catalog-and-mid-session-switch.md) / [phase-16](phase-16-codex-model-switch.md) へ昇格。phase-15 initial完了後に着手し、15-4のmodel_source化・Codex label特例撤去と15-8のsnapshot基盤を再実装しない。
- **[issue #102](https://gitea.example.invalid/sakurai.yuta/kaoiro/issues/102)** — list_agents の peer 情報充実 (engine / model / effort): phase-8 の「directory は名前解決の最小限」判断の見直し、着手は本 phase の envelope schema 確定後。[ADR-0034](../adr/0034-session-capabilities-advertisement.md) の session capability advertise パターンと親和的なので、`state stamp = SoT` 原則を継承する見込み (director 判断で確定)。

## Open Questions Blocking This Phase

なし。ADR-0032 F4bc / ADR-0033 F4 の追補、ADR-0034 F1-F5 は全て決定済 (2026-07-11、もも協働・クロエ経由でマスター意思決定完了)。

## See Also

- Specs covered: [protocol](../specs/protocol.md) (envelope `ext.model_source` / `ext.session_capabilities` / `ext.resume_snapshot` / `ext.effective` / `ext.resume_drift` 追補)、[plugin-model](../specs/plugin-model.md) (EngineAdapter との関係)、[codex-model-catalog](../specs/codex-model-catalog.md) (D1 env 分離の根拠)、[codex-sdk-events](../specs/codex-sdk-events.md) / [agent-sdk-events](../specs/agent-sdk-events.md) (両 engine の session_init タイミング)
- 関連 ADR: [ADR-0032](../adr/0032-codex-adapter.md) F4bc 追補 (本 phase の由来 D1)、[ADR-0033](../adr/0033-permission-model-dual-axis.md) F4 追補 (本 phase の由来 D2)、[ADR-0034](../adr/0034-session-capabilities-advertisement.md) (本 phase の由来 D4/D5)、[ADR-0031](../adr/0031-runner-persona-trust-mode.md) (env deprecation 窓のパターン)、[ADR-0022](../adr/0022-pending-permission-authoritative-source.md) (state_change.ext = SoT パターン踏襲)
- Previous phase: [phase-14-codex-adapter](phase-14-codex-adapter.md)
