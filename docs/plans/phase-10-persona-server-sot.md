---
title: Phase 10 — ペルソナ server 集約 SoT + zip pack 配布
description: ペルソナデータを server 集約 SoT にし、zip pack で配布、auto-watch で自動反映、野良 persona を封じる (ADR-0029)。既存 4 体 (ao/kuroe/momo/fuji) の pack 化移行も同 phase に含む。
status: done
phase: 10
depends_on: [phase-4-host-runner]
last_updated: 2026-07-06
---

# Phase 10 — ペルソナ server 集約 SoT + zip pack 配布

[ADR-0029](../adr/0029-persona-server-sot-and-pack-distribution.md) で
決定した「サーバ集約型ペルソナ配布モデル」の実装 phase。分散型モデル
(wrapper 側 md + server 側 PNG + runner 側 allowlist)を server 集約
モデルに完全置換する。

方針・背景は ADR-0029 と [persona-pack-schema](../specs/persona-pack-schema.md)
参照。本 plan は実装タスクの列挙。

## 完了条件 (Stage 0)

**分散モデル残渣ゼロ**が完了条件。中途半端な二重存在は SoT を壊すため、
以下すべてが揃って初めてマージ可。

### server 側

- [x] 取り込みディレクトリを env(`KAOIRO_PERSONA_DIR` 据え置き、未設定
      時は `server/priv/persona-packs/` へフォールバック)で指定に統合
- [x] bundled `server/priv/personas/` を完全撤去(既存 4 体は取り込み
      ディレクトリへ zip として移送)
- [x] zip 展開ロジック(当時は取り込みディレクトリ内のコンテンツ
      ハッシュ済み `.cache/<hash>/` に冪等展開)。現行は
      ADR-0046 により persona dir 外の extraction cache へ移設済み
- [x] Elixir `file_system` library による auto-watch + 300ms debounce
- [x] manifest 再構築(取り込みディレクトリの走査 → 全 pack を対象に
      manifest 集約)
- [x] zip 検証(スキーマ / sprite 7 枚 / id 一意 / min_kaoiro_version /
      manifest.id "default" reserve)
- [x] `/api/personas` を新スキーマで返す(name / pack_version /
      description を各 persona entry に転記。personality.md 本文は API
      では返さない)
- [x] WS ハンドシェイクの拡張: `join params.persona_id` を受け取り、
      `after_join` で `personality + common footer` を結合して
      `persona_prompt` push
- [x] 未知 persona.id を名乗る wrapper 接続を reject
      (`missing_persona_id` / `unknown_persona`)
- [x] common footer 定義(ADR-0029 D5 の 1 文を PersonaAssets に
      ハードコード)

### wrapper 側

- [x] ローカル md ロード撤去(`wrapper/personas/*.md` 削除、
      `resolvePersonaAppend` / `COMMON_FOOTER` 撤去)
- [x] WS ハンドシェイクで受信した prompt を SDK に注入する経路
      (`onPersonaPrompt` → Promise → `host.run()`)
- [x] server 到達不能時は fail-closed(spawn 失敗、10s タイムアウト
      で明示的エラー)
- [x] `Persona` 型から `personality_prompt_file` / `language` フィールド
      を撤去(protocol Persona は WirePersona の type alias に降格)
- [x] `server_url` を required に(local-only モード撤廃)

### runner 側

- [x] `runner.config.json` の `personas[]` は「per-host 制限」の
      allowlist として存続(廃止せず)
- [x] server の manifest との整合チェック — 起動 3s 後に
      `GET /api/personas` を叩き、allowlist にあり server が知らない
      id があれば `console.warn`(spawn は許容、警告のみ)

### 作成者ワークフロー

- [x] `persona-packs/<id>/` 作業ツリーを kaoiro repo トップレベルに
      設置(`manifest.json` + `personality.md` + `sprites/`)
- [x] `scripts/build-persona-pack.sh` build スクリプト(bash + jq +
      zip。作業ツリー → zip 化 → 検証)
- [x] 既存 4 体(ao / kuroe / momo / fuji)を `persona-packs/` へ移送
      (license: CC-BY-4.0、version: 1.0.0、min_kaoiro_version: 0.1.0)
- [x] 4 体を build して zip 化、取り込みディレクトリ
      (`server/priv/persona-packs/`)に配置
- [x] 旧位置(`wrapper/personas/*.md`、`server/priv/personas/{ao,kuroe,
      momo,fuji}/`)を完全撤去

### docs 側

- [x] 新 spec [persona-pack-schema](../specs/persona-pack-schema.md) の
      status を `provisional` → `accepted` に更新
- [x] [personas](../specs/personas.md) を「作成 = zip 化ワークフロー」
      に更新済(本 phase 着手前に済)
- [x] [persona-personality-injection](../specs/persona-personality-injection.md)
      を新モデルに更新済(本 phase 着手前に済)
- [x] [setup-wizards](../specs/setup-wizards.md) の wrapper config
      節から `personality_prompt_file` / `language` を撤去済(本 phase
      着手前に済)
- [x] [protocol](../specs/protocol.md) に人格プロンプト push
      メッセージ・reject 仕様を追記済(本 phase 着手前に済)

### dev 手順

- [x] `scripts/dev.sh` の runner config デフォルトを fuji 含む 4 体に
      拡張(server auto-watch により自動反映)
- [x] wrapper 単体起動は `server_url` 必須化により config 段階で
      弾かれる(local-only 分岐撤廃)

## スコープ外(Stage 1 以降で扱う)

以下は本 phase では扱わない。ADR-0029 の Follow-ups に紐づく。

- **Hot-swap**: 接続中 wrapper への live update push
- **Concurrent update 精緻化**: 途中書き込み中の zip の扱い
- **watch debounce チューニング**: 大量 zip drop 時の負荷特性
- **hash / 署名検証**: pack の integrity / provenance 検証
- **schema strict API versioning**: API v1/v2 分岐
- **multi-host sync**: 複数 server 運用時の zip 同期

## リスクとロールバック

- **リスク**: fail-closed により dev フローで「wrapper 単体起動」が
  できなくなる。既存の dogfooding 手順・スクリプトの見直しが必要。
- **リスク**: 既存 4 体の移送で pack 内 personality.md と旧 md の
  細部が食い違い、応答トーンに揺らぎ発生。移送時に差分を目視確認する
  ステップを含める。
- **ロールバック**: 分散モデル残渣ゼロを達成する前(移送作業中)は、
  ADR-0029 supersession は暫定として旧 ADR-0008 / ADR-0026 も並行有効
  扱いにする。マージ後(Stage 0 完了時点)は不可逆。

## See Also

- ADR: [ADR-0029](../adr/0029-persona-server-sot-and-pack-distribution.md)
- Specs: [persona-pack-schema](../specs/persona-pack-schema.md),
  [personas](../specs/personas.md),
  [persona-personality-injection](../specs/persona-personality-injection.md),
  [setup-wizards](../specs/setup-wizards.md),
  [protocol](../specs/protocol.md)
- Superseded ADRs: [ADR-0008](../adr/0008-persona-asset-distribution.md),
  [ADR-0026](../adr/0026-persona-personality-injection.md)
