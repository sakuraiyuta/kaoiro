---
title: persona pack (zip) スキーマ
description: サーバ集約型ペルソナ配布 (ADR-0029) の配布単位 zip 「persona pack」の内部構造と manifest.json スキーマ。
status: accepted
related: [personas, persona-personality-injection, protocol]
---

# persona pack (zip) スキーマ

## Purpose

[ADR-0029](../adr/0029-persona-server-sot-and-pack-distribution.md) で
定めた「ペルソナは server 集約 SoT、zip pack で配布」の配布単位 zip
「persona pack」の内部構造とスキーマを定める。作成者・server 実装
(取り込み・展開・検証)・build スクリプトの共通契約。

## Definition

### 配置

zip ファイル 1 個 = 1 persona pack = 1 persona。

```text
<pack-name>.zip
├── manifest.json
├── personality.md
└── sprites/
    ├── idle.png
    ├── thinking.png
    ├── tool_running.png
    ├── waiting_input.png
    ├── waiting_permission.png
    ├── done.png
    └── error.png
```

zip ファイル名は任意(推奨: `<id>-<version>.zip`。例:
`fuji-1.0.0.zip`)。id は zip 名ではなく `manifest.json` の `id`
フィールドが正本。

### manifest.json スキーマ

| フィールド | 型 | 必須 | 意味 |
|---|---|---|---|
| `id` | string | 必須 | persona 一意識別子。`^[A-Za-z0-9._-]+$` / 1-256 文字。[ADR-0003](../adr/0003-persona-identity-persistence.md)。ファイルシステム上のディレクトリ名にもなる |
| `name` | string | 必須 | pack が定義する persona の固有名(日本語可、canonical — issue #219 D19)。1-64 文字、制御文字禁止(`Principal.display_name` と同一ドメイン、D24) |
| `sprite_set` | string | 必須 | スプライトセット識別子。通常は `id` と同一。1-256 文字 |
| `version` | string | 必須 | semver(例 `1.0.0`)。作成者が pack を更新するたびに bump する |
| `license` | string | 必須 | ライセンス識別子(SPDX 準拠推奨。例 `CC0-1.0`, `CC-BY-4.0`, `MIT`, `proprietary`)。AI 生成物には著作権が発生しない場合があるため、ライセンス表示が実態と矛盾しないか確認する。使用モデルの条件は Outputs に及ぶ範囲を別途確認する |
| `min_kaoiro_version` | string | 必須 | 動作に必要な server バージョンの下限 semver。server が下回れば取り込み拒否 |
| `states` | string[] | 必須 | sprites/ に含まれる状態 id の列挙。順序不問、7 状態必須 |
| `description` | string | 任意 | pack の 1 行説明。表示 UI に流す |
| `author` | string | 任意 | 作成者名 |
| `homepage` | string | 任意 | 作成元プロジェクト URL |

`states` の必須値(順序不問、全 7 状態):

```json
["idle", "thinking", "tool_running", "waiting_input",
 "waiting_permission", "done", "error"]
```

例(fuji ペルソナ):

```json
{
  "id": "fuji",
  "name": "ふじ",
  "sprite_set": "fuji",
  "version": "1.0.1",
  "license": "CC0-1.0",
  "min_kaoiro_version": "0.1.0",
  "states": ["idle", "thinking", "tool_running", "waiting_input",
             "waiting_permission", "done", "error"],
  "description": "お嬢様知的マウント才媛型ペルソナ",
  "author": "sakurai.yuta@gmail.com"
}
```

### personality.md

**プレーンな markdown 本文**。frontmatter は付けない(メタデータは
manifest.json 側)。長さは 200〜1000 字を SHOULD 目安とする(hard
上限なし)。

server は取り込み時にこの本文をそのまま保持する。wrapper への配送時、
`KAOIRO_FOOTER_DIR` 設定時は同ディレクトリの `system-footer.md` と
`user-footer.md` を末尾に concat して push する。未設定時は内蔵既定の
system footer だけを concat する。結合が server 側の責務である点は
[ADR-0029](../adr/0029-persona-server-sot-and-pack-distribution.md) F5。

### sprites/

各状態の PNG。**512x512 透過 PNG** を推奨する(既存 4 体の実装ライン)。
`manifest.states[]` に列挙された 7 状態すべてが揃っている MUST。

生成レシピ(ComfyUI モデル / seed / rembg 手順)は
[personas](personas.md) を参照。pack として配布する時点では PNG のみが
必要。

### provenance/(作業ツリーのみ、zip 非同梱)

`persona-packs/<id>/provenance/<state>.json` は `sprites/<state>.png`
と 1:1 対応する生成 provenance(再現用パラメータ)。
`scripts/import-anima-provenance.sh` が Anima dir(生成元 ComfyUI の
出力ディレクトリ)から sha256 照合で state → 生成ジョブを一意に決定し、
sanitize して取り込む(所在の背景は [personas](personas.md) 「生成
実績」参照)。

zip には含まれない。`scripts/build-persona-pack.sh` は
`manifest.json` / `personality.md` / `sprites` の 3 エントリのみを
明示列挙するため、`provenance/` を置いても配布物には影響しない
(開発リポジトリの資産として扱う)。

保持フィールド(allowlist 方式、fail-closed — 未知フィールドは
取り込み時に警告して落とす): `mode` / `prompt` / `negative` /
`model` / `architecture` / `seed` / `steps` / `width` / `height` /
`cfg` / `denoise` / `generated_at` / `job_id` / `source_job_id`。
`account`(メールアドレス)や `image_url`(署名付き URL、credential
性)など個人情報・機微情報を含み得るフィールドは取り込み時に除外する。

## Constraints

- **MUST**: zip の直下に `manifest.json` / `personality.md` / `sprites/`
  の 3 エントリが揃う。他のエントリは無視される(将来 forward-
  compatible)。
- **MUST**: `manifest.json` の必須フィールドがすべて揃う。欠落 or 型
  誤りは取り込み拒否。
- **MUST**: `sprites/` に 7 状態(idle / thinking / tool_running /
  waiting_input / waiting_permission / done / error)すべての PNG が
  存在する。
- **MUST**: `id` の unique 性(既登録との衝突がない)。衝突は取り込み
  拒否。**判定は先勝ち**で、取り込みディレクトリの zip はファイル名順に
  読まれる。したがって同じ `id` の旧 version を残したまま新 version を
  置くと、ファイル名順で先に来る側が採用される(`kohaku-1.0.0.zip` <
  `kohaku-1.1.0.zip` なので**旧版が勝つ**)。version を上げるときは旧
  zip を取り除くこと。実装は
  `server/lib/kaoiro_server/persona_assets.ex` の `drop_duplicate_ids/1`
  (後続を warning 付きで捨てる)。
- **MUST**: `min_kaoiro_version` が server の runtime バージョンより
  高い場合は取り込み拒否。
- **MUST NOT**: `personality.md` に frontmatter を付けない
  (メタデータ二重管理防止)。
- **SHOULD**: `personality.md` は 200〜1000 字目安
  ([ADR-0026](../adr/0026-persona-personality-injection.md) 継承)。
- **SHOULD**: PNG は 512x512 透過。より高解像度は許容するが配信量が
  増える。
- **MAY**: pack に将来追加フィールドが増えることを見越し、`manifest.
  json` は未知キーを無視する forward-compatible スタンス。
- **NOT ENFORCED**: hash / 署名検証は phase-2 以降の拡張
  ([ADR-0029](../adr/0029-persona-server-sot-and-pack-distribution.md)
  F4)。

## Open Questions

なし。ADR-0029 で決定。

## See Also

- ADRs: [ADR-0029](../adr/0029-persona-server-sot-and-pack-distribution.md)
  (本 spec を規定する決定)、
  [ADR-0003](../adr/0003-persona-identity-persistence.md)
  (persona.id の同一性・永続化)
- Related specs: [personas](personas.md)(生成レシピと立ち絵設計方針)、
  [persona-personality-injection](persona-personality-injection.md)
  (人格プロンプトの配送・注入)、
  [protocol](protocol.md)(`/api/personas` レスポンス形式)
- Plan: [phase-10-persona-server-sot](../plans/phase-10-persona-server-sot.md)
