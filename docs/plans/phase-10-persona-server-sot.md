---
title: Phase 10 — ペルソナ server 集約 SoT + zip pack 配布
description: ペルソナデータを server 集約 SoT にし、zip pack で配布、auto-watch で自動反映、野良 persona を封じる (ADR-0029)。既存 4 体 (ao/kuroe/momo/fuji) の pack 化移行も同 phase に含む。
status: planned
phase: 10
depends_on: [phase-4-host-runner]
last_updated: 2026-07-05
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

- [ ] 取り込みディレクトリを env(現行 `KAOIRO_PERSONA_DIR` の役割拡張、
      名前は据え置きまたは改名)で指定に統合
- [ ] bundled `server/priv/personas/` を空にする(既存 4 体は取り込み
      ディレクトリへ移送)
- [ ] zip 展開ロジック(取り込みディレクトリ内の zip を検知して同名
      ディレクトリに展開)
- [ ] Elixir `FileSystem` library による auto-watch + debounce
- [ ] manifest 再構築(取り込みディレクトリの走査 → 全 pack を対象に
      manifest 集約)
- [ ] zip 検証(スキーマ / sprite 7 枚 / id 一意 / min_kaoiro_version)
- [ ] `/api/personas` を新スキーマで返す(name / sprite_set /
      version / description のみ返す形。personality.md 本文は API
      では返さない)
- [ ] WS ハンドシェイクの拡張: 接続 wrapper へ `personality + common
      footer` を結合して push
- [ ] 未知 persona.id を名乗る wrapper 接続を reject
- [ ] common footer 定義(ADR-0029 D5 の 1 文を server 側でハードコード)

### wrapper 側

- [ ] ローカル md ロード撤去(`wrapper/personas/*.md` および
      `personality_prompt_file` 解決ロジックを削除)
- [ ] WS ハンドシェイクで受信した prompt を SDK に注入する経路
- [ ] server 到達不能時は fail-closed(spawn 失敗、明示的エラー)
- [ ] `Persona` 型から `personality_prompt_file` / `language` フィールド
      を撤去(または non-consumer に降格)

### runner 側

- [ ] `runner.config.json` の `personas[]` は「per-host 制限」の
      allowlist として存続(廃止しない)
- [ ] server の manifest との整合チェック — allowlist 内に server が
      知らない id があれば起動時警告(spawn は許容、警告のみ)

### 作成者ワークフロー

- [ ] `persona-packs/<id>/` 作業ツリー構造をリポジトリ (もしくは
      wrapper とは別リポジトリ) に設置
      (`manifest.json` + `personality.md` + `sprites/`)
- [ ] `scripts/build-persona-pack.sh` build スクリプト(作業ツリー →
      zip 化 → 検証)
- [ ] 既存 4 体(ao / kuroe / momo / fuji)を `persona-packs/` へ移送
- [ ] 4 体を build して zip 化、取り込みディレクトリに配置
- [ ] 旧位置(`wrapper/personas/*.md`、`server/priv/personas/{ao,kuroe,
      momo,fuji}/`)を完全撤去

### docs 側

- [ ] 新 spec [persona-pack-schema](../specs/persona-pack-schema.md) の
      status を `provisional` → `accepted` に更新(実装確定時)
- [ ] [personas](../specs/personas.md) を「作成 = zip 化ワークフロー」
      に更新済(本 phase 着手前に済)
- [ ] [persona-personality-injection](../specs/persona-personality-injection.md)
      を新モデルに更新済(本 phase 着手前に済)
- [ ] [setup-wizards](../specs/setup-wizards.md) の wrapper config
      節から `personality_prompt_file` / `language` を撤去済(本 phase
      着手前に済)
- [ ] [protocol](../specs/protocol.md) に人格プロンプト push
      メッセージ・reject 仕様を追記済(本 phase 着手前に済)

### dev 手順

- [ ] `scripts/dev.sh` 等で minimal server を自動起動する運用を確立
      (fail-closed の帰結)
- [ ] wrapper 単体起動での動作説明を「local + local server 起動が前提」
      に更新

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
