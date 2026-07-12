---
title: runner の persona 受け入れは allowlist/blacklist の 2 モードから選択
status: accepted
date: 2026-07-07
opened: 2026-07-07
supersedes: []
superseded_by: null
related_specs: [personas, persona-pack-schema, protocol]
related_adrs: [23, 29]
---

# ADR-0031 — runner の persona 受け入れは allowlist/blacklist の 2 モードから選択

## Status

Accepted(実装完了 2026-07-07 — [phase-12](../plans/phase-12-runner-persona-trust-mode.md)、
`/my-code-review-cycle` 1 round clean 収束、dev dogfooding で 2 件の
副次バグ(Jason encode / setPermissionMode race)を検出・修正済)。

## Context

[ADR-0029](0029-persona-server-sot-and-pack-distribution.md) でペルソナは
server SoT + zip pack 配布に統合されたが、「そのホストで起動できる
persona」の最終判定は `runner/runner.config.json` の `personas[]`
(allowlist)が握る構造が残った。運用でこれが 2 種類の摩擦を生む:

1. **allowlist 同期漏れ**: 新 pack を server に置いても、稼働ホストの
   `runner.config.json` に手で追記しないと dashboard「+ 起動」に出ない。
   fuji 追加直後(2026-07-05)にも、pack が ingest 済みなのに runner の
   allowlist に fuji が無いため起動不可、という同じ形の papercut が再発。
   `scripts/dev.sh` は「初回のみ生成」で以後は上書きしない gitignored
   ファイルのため、`git pull` でも解消しない。
2. **モードが固定**: allowlist しか選べないため、ラボ規模のように
   「server に置いたものは基本すべて使ってよい」用途では冗長な二重管理。
   一方で研究室外への配布や共有 server で「特定ホストではこの pack を
   使わせない」ような opt-out はそもそも表現手段が無い(pack 削除しか
   ない)。

これらは「runner が server の persona カタログをどこまで信じるか」の
トラスト方針が単一値でしか表現できないことに起因する。**信頼軸を config
で明示的に選べる**ようにすれば、小規模運用の摩擦解消と、大規模運用に
向けた表現力の下地が同時に得られる。

**信頼軸のスコープ**: 本 ADR が扱うのは **runner → server 方向の信頼**
(runner が server の persona 集合をどこまで受け入れるか)の 1 軸のみ。
逆方向(server が runner の申告をどこまで信じるか、per-token に spawn
可能 persona を制限するなど)は WS 認証・cwd_allowlist の server 側
検証・per-token persona ACL 等の別レイヤに属し、本 ADR のスコープ外。
実運用でその表現力が要求された時点で別 ADR として扱う(Non-Goals 参照)。

## Decision

### F1: 2 モードから選択、両モード相互排他

`runner/runner.config.json` に **`allowed_personas` または
`blocked_personas` のいずれか一方**を書ける。両方を書いた config は
起動時に fail-loud で reject する(意味論の曖昧さを残さない)。

- **`allowed_personas: string[]`** — allowlist モード。列挙された id
  のみを spawn 可能とする(現行 `personas[]` 相当)。
- **`blocked_personas: string[]`** — blacklist モード。server の
  persona 集合(`PersonaAssets` に ingest されたもの + 予約 `default`)
  から、列挙された id を除いたものが spawn 可能となる。
- **両フィールド省略** — accept-all(空 blacklist と同義)。**小規模
  運用の既定**として、新規 host は persona 宣言ゼロで全 persona を
  受け入れる。

id は persona pack の `manifest.json` の id と完全一致。versioning
(`fuji@1.0.0` など)、ワイルドカード、名前空間の類はサポートしない
(将来必要になった段階で拡張)。

### F2: `default` persona を特別扱いしない

予約 persona id `default`(ADR-0029, #35, HostRegistry.inject_default/1)
も他の id と同様に `allowed_personas` / `blocked_personas` に列挙可能
とする。`HostRegistry.inject_default/1` の「必ず注入」ロジックは撤去し、
「宣言セットに default が含まれる(allowlist)/含まれない(blacklist)
場合のみ注入」に変更する。

結果として `default` を blocked し他 pack も列挙外/未 ingest の場合、
spawnable セットが空になる host が発生しうるが、これを canary/準備中
host として合法状態とする。dashboard 側は空 picker を明示的に UX で
表示する(例外扱いはしない)。

この採用理由は主に **id 空間の一貫性**と **`inject_default/1` の
分岐撤去による HostRegistry 単純化**。副次的に、将来 default が固有の
personality pack を持つ方向に振ったときの「default 固有のインジェク
ション対策」の下地としても機能する(ただし現状の default は common
footer のみを持ち personality を持たないため、footer 由来のインジェク
ションへの緩和にはならない — 全 persona に共通適用のため。footer 側の
lever が必要になった場合は別 ADR で扱う)。

### F3: 判定は server 側で完結

blacklist モードのときは、runner が register 時に `blocked_personas` を
申告 → server の `AgentsChannel.resolve_persona/2` は `PersonaAssets` の
集合(+ default 予約)から blocked を除いたセットで判定する。この設計に
より、稼働中の server に新 pack が ingest されても runner の再登録は
不要となり、ADR-0029 の watcher による live 反映がホスト側にも自然に
波及する。

allowlist モードは現行どおり `HostRegistry` の personas 参照で継続。
分岐が入るのは `AgentsChannel.resolve_persona/2` の判定元と、
`HostRegistry` の `attrs` 保持形式のみ。

### F4: 既存 `personas[]` フィールドの後方互換

既存 `runner.config.json` が `personas: [{id, name, sprite_set}, ...]`
形式を持つ場合、次の 1 リリースサイクルは **allowlist モードとして
受理**し、deprecation 警告を stderr に出す。id のみを利用し、name /
sprite_set は server 側 manifest を優先する(host ローカルの表示名
上書きは撤去、ADR-0029 の SoT 方針と整合)。

移行完了(次期 major)の時点で `personas` フィールドは撤去し、
`allowed_personas: string[]` に完全置換する。

### F5: 起動時 fetch と cli 突合の撤去

現行の `scheduleAllowlistCheck`(runner/src/cli.ts、起動 3s 後に
`/api/personas` を叩いて config との差分を warn)は blacklist モードで
は不要(判定が server 側完結のため)、allowlist モードでは deprecation
警告と重複するため、本 ADR で撤去する。

## Consequences

### 正の帰結

- 新 pack 追加時、blacklist モード host では config 変更不要で自動
  反映される(fuji 追加時の papercut が構造的に消滅)
- runner の初期セットアップから persona 宣言が省略可能となり、ラボ
  規模の初期セットアップコストが下がる
- `runner.config.json` のスキーマから persona display metadata(name /
  sprite_set)が消え、SoT が manifest.json に完全集約される

### 負の帰結・トレードオフ

- **信頼委譲の方向転換**: blacklist モードでは「server に ingest された
  pack = ホスト上で実行される system prompt」となる。単一 operator =
  server admin のラボ用途では実質劣化なしだが、複数 operator / 共有
  server の場合は、operator は自分のマシンで走る persona prompt を
  事前レビューする明示的な手段を失う(pack は WrapperChannel が
  persona_prompt として wrapper に push、personality.md 由来のプロンプト
  インジェクションリスクは allowed_tools の範囲で顕在化しうる)。この
  トレードオフは config でモードを選べる(乙方針)ことで operator に
  委ねる。
- allowlist / blacklist 2 モード分岐のテストサーフェスは増える
  (`AgentsChannel.resolve_persona/2` の判定分岐、HostRegistry の
  attrs 形式、dashboard 側の空 picker UX)
- `default` を block した host で spawnable ゼロになる状態は許容する
  ため、dashboard は空 picker を意図した空状態として表示する必要が
  ある(エラーではなく)

### 変更影響領域

- `runner/src/cli.ts` — config parse に mode 判定を追加、
  `scheduleAllowlistCheck` 撤去、blacklist モード時は
  `blocked_personas` を register payload に含める
- `server/lib/kaoiro_server/host_registry.ex` — attrs に mode と
  blocked/allowed セットを保持、`inject_default/1` 撤去
- `server/lib/kaoiro_server_web/channels/runner_channel.ex` —
  `parse_register/1` を新フィールド対応に拡張、旧 `personas` の
  deprecation 警告
- `server/lib/kaoiro_server_web/channels/agents_channel.ex` —
  `resolve_persona/2` を mode 別分岐
- `scripts/dev.sh` — 生成テンプレートを新スキーマ(mode 省略で
  accept-all)へ更新
- `docs/specs/personas.md` — runner 側の persona 受け入れ仕様を
  2 モード対応で書き換え
- `wrapper/kaoiro.config.{claude-code,codex}.example.json` — 影響なし
  (persona は server から降ってくる、ADR-0029 F3。ファイル名は phase-15
  15-17 で engine 別に分割)

## Non-Goals

以下は本 ADR のスコープ外とし、必要性が実運用で顕在化した時点で
別 ADR として扱う:

1. **per-token persona ACL(server → runner 方向の信頼)** — server が
   「このトークンではこの persona しか起動不可」という制限を持つ機構。
   組織/共有 server 運用で必要になるが、本 ADR は runner → server 方向
   の信頼のみを扱う。
2. **id の versioning / ワイルドカード / 名前空間** — `fuji@1.0.0` 単位
   の許可、`sakurai/*` のような author 単位の制限など。id 完全一致の
   ミニマルな意味論から始める。
3. **common footer 側の lever** — footer 由来のプロンプトインジェクション
   への緩和(footer 版別選択、footer 無効化オプションなど)。本 ADR の
   `default` 扱いはこの問題を解決しない。
4. **動的なモード切替** — 運用中に allowlist ↔ blacklist を切り替える
   ような UX / API。config 編集 + runner 再起動で足りるため対象外。
5. **spawnable ゼロ host に対する明示的なアラート** — canary/準備中の
   合法状態として扱うため、warning を出さない(気になれば別途 issue
   化)。

## Migration

1. **既存 lab の `runner.config.json`**(`personas: [...]` を持つ):
   次期リリースまでは deprecation 警告つきで allowlist モードとして
   動作。lab admin は都合の良いタイミングで:
   - blacklist 志向にする場合 → `personas` を削除して起動、または
     `blocked_personas: []` を明示
   - allowlist 志向を維持する場合 → `personas: [...]` を
     `allowed_personas: ["<id>", ...]`(id のみの string 配列)へ
     書き換え(name/sprite_set は server 側 SoT に委ねる)
2. **`scripts/dev.sh` の生成テンプレート**: 新規生成は accept-all
   (両フィールド省略、`blocked_personas: []` をコメントヒントとして
   例示)に更新。既存 lab の生成済み config は上書きしない現行挙動を
   維持。
3. **次期 major**: `personas` フィールドと deprecation 警告を撤去。
   `HostRegistry` の attrs 形式も 2 モード前提に統一。

## 未確認 / 参考

- footer 版別選択 / 無効化 lever は未検討。footer 由来の injection
  リスクが顕在化した時点で別 ADR として扱う。
- server 側で pack manifest の署名検証(誰が pack を作ったか)は
  本 ADR とは独立の課題。ingest 時点でのハッシュチェック
  (`server/priv/persona-packs/.cache/`)は ADR-0029 で既に導入済み。
