---
title: Phase 4 — ホスト常駐 runner
description: 各ホストに常駐 runner を置き、wrapper の spawn/監督/再起動とホスト登録・生存通知・session 列挙を担わせる。
status: done
phase: 4
depends_on: [phase-3-server-multiagent]
last_updated: 2026-07-25
---

# Phase 4 — ホスト常駐 runner

## Goal

各ホストに常駐プログラム runner を 1 つ置き、サーバと wrapper の間で**ホスト内
エージェント群のライフサイクル**を担わせる。wrapper の直結トポロジは維持しつつ、
UI からの起動・再起動・取りまとめの主体を導入する(supervisor 専任、
[ADR-0023](../adr/0023-host-runner-architecture.md))。これは UI からのリモート
spawn([#22](https://gitea.example.invalid/sakurai.yuta/kaoiro/issues/22))と
セッション復帰([ADR-0014](../adr/0014-session-resume-and-restore.md))の前提層。

なお [#22](https://gitea.example.invalid/sakurai.yuta/kaoiro/issues/22) 自体は本層の
上に載る **起動指示 UI + client→server 要求**(spawn/resume)へ範囲を限定し、ホスト
概念・spawn 中継・schema・runner 実行は本フェーズのタスク(4-1〜4-6)が担う。

## Acceptance Criteria

- [x] runner がサーバへ常時接続し、自ホストを登録・生存通知する。
- [x] operator 指示で runner がホスト内 wrapper を spawn / stop / restart する。
- [x] 1 wrapper = 1 agent = 1 process を runner が監督し、クラッシュを隔離する。
- [x] wrapper は従来どおりサーバへ直結し、データ経路は runner を通らない。
- [x] 二重起動が server owner フェンシング + runner ローカルロックの二段で防がれる。
- [x] runner / wrapper を**自己完結アーカイブとして配布できる**(解凍 → 設定
      編集 → ワンコマンド実行で稼働し、配布先で pnpm install / build を要さない。
      単一バイナリ化は撤回・延期 —
      [ADR-0018](../adr/0018-runner-distribution.md) 2026-07-25 改訂)。
- [x] operator が起動 UI から (host / persona / 登録済み cwd / 初期プロンプト) を
      指定して新規 spawn でき、同 UI から既存セッションの resume もできる(範囲=中。
      任意 cwd / 任意 repo clone は初版外、
      [#22](https://gitea.example.invalid/sakurai.yuta/kaoiro/issues/22))。

## Tasks

| # | Task | Status | Notes |
|---|------|--------|-------|
| 4-1 | 制御 envelope(spawn/stop/restart/enumerate-sessions)の schema 確定 | ✅ | #66 で確定。[protocol](../specs/protocol.md)「runner 制御メッセージ」へ追補・[ADR-0023](../adr/0023-host-runner-architecture.md) に決定記録。#22 と共有 |
| 4-2 | server: ホスト登録・生存通知の受け口 + spawn 中継経路 | ✅ | #67(03ebca4)。host_registry + runner_channel/socket + AgentsChannel relay |
| 4-3 | server: runner ローカルロックと連携した二重起動防止 | ✅ | #67。server owner フェンシング + spawn デデュプ。runner 側ロックは 4-5 |
| 4-4-0 | TS workspace 化 + 共有 `@kaoiro/protocol` 抽出 + wrapper 型移行(挙動不変) | ✅ | #68 前段。[ADR-0023](../adr/0023-host-runner-architecture.md)「TS パッケージ・トポロジ」。wrapper test/build green で隔離コミット |
| 4-4 | runner: プロセス監督ループ + config 解決 + spawn/stop/restart | ✅ | #68。TS/Node。4-4a(接続+register/heartbeat)+ 4-4b(spawn/stop/restart 監督・config 解決・crash 再起動・cwd allow-list T1)。ライブ verify=実 wrapper spawn→server 接続 |
| 4-5 | runner: session JSONL 列挙 + resume 起動 | ✅ | #68。当該 cwd 配下を列挙、T3 実在検証([ADR-0014](../adr/0014-session-resume-and-restore.md) F2/F6)+ in-memory ローカルロック(F4) |
| 4-6 | wrapper: resume flag(`--resume <session_id>` 等)追加 | ✅ | #69(d073b4e)。args.ts/cli.ts に実装 |
| 4-7 | `kaoiro-runner` の配布物整備 | ✅ | #70。単一バイナリ(bun compile)は 2026-07-25 に撤回・延期し、Node 前提の自己完結 tarball へ([ADR-0018](../adr/0018-runner-distribution.md) 改訂)。生成は `scripts/build-runner-tarball.sh`、対象は darwin-arm64 / linux-x64。release への資産アップロード自動化は #145 |
| 4-8 | dashboard: 起動指示 UI(host/persona/登録済み cwd/初期プロンプト)+ client→server spawn 要求 | ✅ | #22 phase-0(0db7234 系)。範囲=中。案A=サーバ補完([ADR-0024](../adr/0024-agent-instance-identity-and-spawn-auth.md))。`LaunchDialog.svelte` + protocol.ts(spawn/hosts/spawn_result)。operator 判定は `hosts` push で |
| 4-9 | dashboard: 起動 UI に resume(runner 列挙の session_id 候補選択)追加 | ✅ | #22 phase-1。新規/再開タブ + enumerate_sessions → `runner_sessions` で候補表示。resume は fresh agent_id + `resume_session_id`(D1 と整合、runner が T3/F4)|
| 4-10 | server: spawn 補完(`agent_id` 採番 + per-agent token 注入)+ 署名トークン認証 | ✅ | #22 の前提([ADR-0024](../adr/0024-agent-instance-identity-and-spawn-auth.md) D3/D4)。`server_url` は runner 供給に変更。token = Phoenix.Token 署名・無期限(失効=鍵ローテーション、個別 denylist は [#72](https://gitea.example.invalid/sakurai.yuta/kaoiro/issues/72))。D5 二重 live join 拒否は未実装(下記)|
| 4-11 | 常駐化: systemd user unit / launchd LaunchAgent + 導入手順 | ✅ | #141。`runner/deploy/` に起動シム + unit + plist + env 雛形。token は 0600 env ファイル(ユニットに平文を載せない)。user サービス限定([ADR-0023](../adr/0023-host-runner-architecture.md) の資格情報アクセス前提)。単一バイナリ移行はシムの `exec` 行 1 行(4-7)|

Status legend: ✅ done, 🟡 mostly done, ⚠ partial, ⏳ not started, ⛔ blocked.

## 実装方針 (#68 = タスク 4-4-0〜4-5)

# 68 着手にあたり確定した実装方針(2026-06-24)

- **パッケージ / 型共有**: [ADR-0023](../adr/0023-host-runner-architecture.md)
  「TS パッケージ・トポロジ」に従う(最小 pnpm workspace + 共有 `@kaoiro/protocol`、
  Node 側限定、dashboard 据え置き、wrapper リネームは先送り)。
- **runner config**: JSON 設定ファイル(`host_id` / `server_url` / `personas` /
  `cwd_allowlist`)。トークン等の秘匿値はファイルに置かず env(`KAOIRO_RUNNER_TOKEN`
  等)から解決。利用可能エンジン種別(claude / codex 等)は `register` payload の
  `capabilities?` で申告。
- **ローカルロック([ADR-0014](../adr/0014-session-resume-and-restore.md) F4)**:
  in-memory のアクティブ `session_id` レジストリで同一 runner 内の同時 resume を
  物理阻止。インスタンス跨ぎは server owner フェンシングが担う。runner 再起動跨ぎの
  堅牢化(lockfile)は将来必要時に後付け。
- **段階(backend-first、各段 verify + commit)**:
  1. 4-4-0: workspace 化 + `@kaoiro/protocol` 抽出 + wrapper 移行(挙動不変)。
  2. 4-4a: runner 骨格 + server 接続 + `register` / `heartbeat`(host_registry 登録を確認)。
  3. 4-4b: `spawn` / `stop` / `restart` 監督ループ(wrapper 子の接続・stop/restart・クラッシュ隔離)。
  4. 4-5: session JSONL 列挙 + `resume`(`--resume`)+ T3 cwd 実在検証 + ローカルロック。

## 起動 UI スコープ (#22)

- 範囲 = **中**(host+persona 選択 + 初期プロンプト + 登録済み cwd 選択)。
  任意 cwd / 任意 repo clone は RCE 面拡大のため初版外
  ([threat-model](../specs/threat-model.md) T1/T5、却下)。
- 選択可能 cwd の許可リストは **runner config** が保持し、登録時に persona と
  並べて申告(host 側へ複雑性を寄せる、
  [ADR-0023](../adr/0023-host-runner-architecture.md))。schema は 4-1 /
  [protocol](../specs/protocol.md)「runner 制御メッセージ」(#66 確定)。
- **spawn 要求 = 案A(サーバ補完、[ADR-0024](../adr/0024-agent-instance-identity-and-spawn-auth.md))**:
  クライアントは `{ host_id, persona, cwd, initial_prompt?, resume_session_id? }`
  のみ送る。サーバが `agent_id` を採番し `server_url` + per-agent token を補完。
  秘匿値はクライアントへ出さない。**persona = 型 / agent_id = インスタンス**で、
  同性質の複数 spawn は同一 persona × 別 agent_id(D1)。
- spawn 認証は runner 起動経由に一本化(常駐 or ワンショット)。per-agent
  トークンの事前登録は spawn 経路で不要(ADR-0024 D2/D4)。token 発行方式・
  寿命は ADR-0024 の従属点(実装時確定)。
- 新規 / resume は単一の起動導線で「新規 / 既存セッション再開」を切替(暫定)。
- spawn 成否は `spawn_result` 受信で UI(グリッド/トースト)へ反映(暫定)。
- #22 後の dashboard ライフサイクル制御(実装済): **任意エージェント名**
  (spawn `name?` で persona.name 上書き)、**終了**(既存 `stop` 再利用、実行中は
  警告)、**復帰**(`restore` 制御で同一 agent_id を resume 再 spawn)。復帰のため
  spawn 時に cwd を SessionPointers へ seed する([protocol](../specs/protocol.md)
  「クライアント → サーバ 起動制御」)。

## Followups (in-phase but unfinished)

- runner: バックエンド(4-4-0〜4-5)・server 補完(4-10)・dashboard 起動 UI
  (4-8/4-9)・**D5**(二重 live join 拒否)は完了(#22 実装済)。常駐化(4-11、
  #141)・配布物整備(4-7、#70)も完了し、**本フェーズのタスクは全て完了**。
  Gitea release への資産アップロード自動化のみ #145 へ分離した。
- **D5**: wrapper join 経路(`wrapper_channel`)で live owner 済み agent_id を
  **reject-newcomer** で拒否([ADR-0024](../adr/0024-agent-instance-identity-and-spawn-auth.md) D5、
  `AgentStates.connected?/2`)。既存を蹴る案はトークン保持者による敵対的 eviction を
  招くため不採用。異常切断後の正規再接続は socket timeout 窓(既定 ~60s)だけ遅延し、
  その間 client がリトライして通る。join〜初回 envelope の極短窓は未カバー(完全に
  閉じるには Phoenix.Presence 導入=アーキ決定が必要、優先度低)。
  [#74](https://gitea.example.invalid/sakurai.yuta/kaoiro/issues/74) へ分離。
- `SessionMeta.summary` を充填(#73、実装済)。runner が各 session JSONL の先頭を
  バウンド読みして `ai-title` 優先・先頭 user 指示フォールバックで最小露出
  (T2 維持)の summary を返し、再開ダイアログの候補表示に使う。
- supervisor の crash 再起動 cap に時間窓を導入(#73、実装済)。`RESTART_WINDOW_MS`
  より長い無事故期間で budget をリセットし、散発クラッシュでは cap を使い切らない
  (tight な crash-loop のみ down のまま)。
- 上記の低優先ポリッシュは集約していた
  [#73](https://gitea.example.invalid/sakurai.yuta/kaoiro/issues/73) で追跡。
  `SessionMeta.summary` / 再起動 cap 時間窓は実装済、D5 短窓は #74 へ分離。

## Open Questions Blocking This Phase

なし。4-10 の per-agent token 方式は **Phoenix.Token 署名・無期限**(失効=鍵
ローテーション)に決定(2026-06-24、[ADR-0024](../adr/0024-agent-instance-identity-and-spawn-auth.md)
従属点を解消)。個別 revoke の denylist は [#72](https://gitea.example.invalid/sakurai.yuta/kaoiro/issues/72)。

## See Also

- ADR: [0023](../adr/0023-host-runner-architecture.md)(本フェーズの決定)、
  [0024](../adr/0024-agent-instance-identity-and-spawn-auth.md)(spawn 認証 /
  インスタンス同一性)、
  [0014](../adr/0014-session-resume-and-restore.md)(resume の生存単位)、
  [0018](../adr/0018-runner-distribution.md)(配布)。
- Specs: [architecture](../specs/architecture.md),
  [protocol](../specs/protocol.md), [threat-model](../specs/threat-model.md)。
- 関連 issue:
  [#23](https://gitea.example.invalid/sakurai.yuta/kaoiro/issues/23)(本フェーズ)、
  [#22](https://gitea.example.invalid/sakurai.yuta/kaoiro/issues/22)(起動指示 UI +
  要求層。範囲=中、resume 含む)。
- Previous: [phase-3-server-multiagent](phase-3-server-multiagent.md)
