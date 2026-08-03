---
title: ペルソナは server 集約 SoT、zip pack で配布し auto-watch で反映
status: accepted
date: 2026-07-05
opened: 2026-07-05
supersedes: [8, 26]
superseded_by: null
related_specs: [personas, persona-pack-schema, persona-personality-injection, setup-wizards, protocol, threat-model]
related_adrs: [2, 3, 8, 24, 26, 31, 44, 45, 46]
---

# ADR-0029 — ペルソナは server 集約 SoT、zip pack で配布し auto-watch で反映

## Status

Accepted。[ADR-0008](0008-persona-asset-distribution.md)(アセット配信)
と [ADR-0026](0026-persona-personality-injection.md)(人格プロンプト注入)
の両方を supersede する。

## Context

現状ペルソナに関するデータは 3 層に分散している:

- `wrapper/personas/<id>.md` — 人格プロンプト(wrapper が自ロード、
  [ADR-0026](0026-persona-personality-injection.md))
- `server/priv/personas/<id>/*.png` — 立ち絵(server が `/api/personas` で
  配信、[ADR-0008](0008-persona-asset-distribution.md))
- `runner/runner.config.json` の `personas[]` — spawn 可能 id の allowlist

この分散は 3 つの実務問題を生む:

1. **作成 → 配布 → 運用の摩擦**: 1 ペルソナ追加のたびに wrapper repo と
   server repo と runner config を人手で揃える。fuji ペルソナ追加時
   (2026-07-05)にも、`runner.config.json` の personas 配列を触り忘れて
   起動ダイアログに出てこない、という取りこぼしが発生した。
2. **SoT の欠如**: どれが「正本」か曖昧。作成者が md を編集しても、
   server / runner が知らなければ効かない。管理者が spawn 制御したくても
   握るべきレイヤーが複数ある。
3. **野良 persona を封じられない**: 手元で任意の `persona.id` を書いた
   wrapper を起動すれば、server はそれをそのまま受け入れて画像だけ
   fallback する。管理者が把握していない persona が野に出うる。

これら 3 点を同時に解決するには、**server にペルソナデータを集約して
唯一の SoT** とし、作成者は 1 単位(zip pack)で配布・管理者は所定
ディレクトリに置くだけで有効化される仕組みが要る。

これは server の「愚直にデータを届ける」設計思想(ADR-0003 系、
threat-model)に対しては、**人格プロンプト(テキスト)の配送および
common footer の結合という限定的な組成を許す例外**となる。純粋な静的
配信を守るために SoT の欠如を放置するより、SoT を優先する。

## Decision

### F1: persona pack (zip) 内部スキーマ

zip 内部は `manifest.json` + `personality.md` + `sprites/<state>.png` の
サブディレクトリ構造とする。

```text
<pack-name>.zip
├── manifest.json         # id / name / sprite_set / version / license /
│                          #  min_kaoiro_version / states[] / …
├── personality.md        # 人格プロンプト本文
└── sprites/
    ├── idle.png
    ├── thinking.png
    ├── tool_running.png
    ├── waiting_input.png
    ├── waiting_permission.png
    ├── done.png
    └── error.png
```

詳細スキーマは [persona-pack-schema](../specs/persona-pack-schema.md) に
分離。

### F2: 取り込みディレクトリの env 統合

現行の overlay 機構(env `KAOIRO_PERSONA_DIR` で外部ディレクトリを優先)
と zip 取り込み先を統合する。**env 一つで指定する取り込みディレクトリ
が唯一の SoT**。bundled `server/priv/personas/` は空にする(既存 4 体
も pack として取り込みディレクトリへ移送)。

### F3: server 到達不能時の wrapper spawn = fail-closed

server から人格プロンプトを受信できない場合、wrapper spawn は明示的に
失敗する。default persona へのフォールバックも、wrapper 側キャッシュ
の温存もしない。dev/local でも server は必須(下記 F10)。

### F4: zip 検証はスキーマ + 完全性の基本

server は zip 展開時に以下だけ検証する:

- `manifest.json` の必須フィールド(id/name/sprite_set/version/…)の
  存在と型
- `sprites/` に 7 状態(idle/thinking/tool_running/waiting_input/
  waiting_permission/done/error)すべての PNG がある
- `manifest.id` の unique 性(既登録との衝突がない)

hash 検証・作成者署名は将来拡張(下記 Follow-ups)。

### F5: common footer は server 側で結合

wrapper に渡す最終 prompt は **`personality + common footer` を server
側で結合して配送**する。wrapper は受け取った文字列をそのまま SDK に
注入するだけで、結合ロジックを持たない。common footer 自体の中身は
本 ADR の付録節 D5 で確定する(旧 open-question `persona-common-footer`
を吸収)。

**[ADR-0045](0045-footer-file-externalization.md) による改訂(accepted・
実装済み)**: 結合対象を `personality + system-footer + user-footer` とする。
footer 文面の SoT は footer 設置ディレクトリ(`KAOIRO_FOOTER_DIR`)直下の
`system-footer.md` / `user-footer.md` である。未設定時は内蔵既定を使い、
user footer は加えない。いずれにせよ
「結合は server 側の責務、wrapper は受領文字列をそのまま注入」という本節の
帰属は変わらない。

### F6: auto-watch は Elixir FileSystem library

extraction cache の物理位置は
[ADR-0046](0046-persona-cache-relocation.md) で persona dir 外へ移設
(accepted)。

取り込みディレクトリの watch は Elixir の `FileSystem` library
(fs.notify wrapper。Linux inotify / macOS FSEvents / Windows
ReadDirectoryChangesW を抽象化)で event-driven に行う。polling は
使わない。手動 restart なしで manifest 再構築が走る。

### F7: schema versioning は semver + `min_kaoiro_version`

`manifest.version` は semver。`min_kaoiro_version` で server 側の下限
バージョンを宣言する(下回れば取り込み拒否)。初期は緩めの運用で
始め、必要になった時点で strict な API version 分岐を検討する。

### F8: zip / persona 削除の意味論 = persona 廃止(fail-closed 準拠)

取り込みディレクトリから zip 相当が消えた場合、manifest からも消え、
以降その id での spawn は不可。接続中の wrapper は次回接続時に fail-
closed で失敗する(archive 扱いはしない、F3 と一貫)。

### F9: 接続中 wrapper への concurrent update = 次回接続時のみ反映

zip が更新されても接続中 wrapper には影響しない(接続時にスナップ
ショットで確定した prompt を session 中固定)。hot-swap は phase-1 以降
の拡張。

### F10: dev/local は minimal server を常に前提

fail-closed の帰結として、dev/local でも server を立てる運用を確立する
(scripts/dev.sh 等で自動起動)。[ADR-0002](0002-local-wrapper-websocket-topology.md)
の「wrapper はローカルでも動く」は「local + local server」の意味に読み
替える。

### F11: 作業ツリーは wrapper 外、`wrapper/personas/*.md` は完全撤廃

作成者は wrapper repo の外(初期案: `persona-packs/<id>/{manifest.json,
personality.md, sprites/}`)で編集し、build スクリプトで zip 化する。
`wrapper/personas/*.md` は完全に撤去して wrapper の責務を「動かす側」
に絞る。

### D5 付録: common footer の暫定内容

旧 open-question `persona-common-footer` の暫定方針(案 B = 環境認識
1 文)をそのまま採用し、本 ADR で確定する(open-question 自体は本 ADR
に merge され `git rm` 済):

- 中身:「このエージェントは kaoiro クライアント越しに操作されて
  います」相当の 1 文。
- 合成順:`preset(claude_code) + personality + common footer`
  (personality が上、footer が下)。
- 結合は server 側で実施(F5)。dogfooding で不足が見えたら別 ADR で
  拡張する。

**現行**: [ADR-0045](0045-footer-file-externalization.md) の実装により、
文面の SoT は footer 設置ディレクトリ(`KAOIRO_FOOTER_DIR`)直下の
`system-footer.md` / `user-footer.md` へ移った。D5 の暫定文面は内蔵既定の
内容としてのみ残る。運用者の上書きはファイル編集だけで反映でき、server
実装の変更を伴わない。

## Consequences

### Positive

- ペルソナ SoT が唯一(取り込みディレクトリ)になり、作成 → 配布 →
  運用のフローが単純化する(zip drop 1 手)。
- 「野良 persona」は自然に不可能になる(server の manifest にない id
  で spawn した wrapper は接続時に reject される)。
- 4 体の追加ごとに 3 層を触る運用(fuji で顕在化した取りこぼし)が
  なくなる。
- 作成者は wrapper repo に触らずに persona pack を作れる。作成物を
  丸ごと配布物として扱えるので、外部作成者への配布ハードルが下がる。

### Negative

- server が「テキスト組成」に踏み込むため、[ADR-0003](0003-persona-identity-persistence.md)
  の「サーバは agent 非依存」原則にわずかに反する。組成は `personality
  - common footer` の concat のみで、意思決定は含まないが、境界を跨ぐ
  ことは明示的な例外扱いにする。
- fail-closed により dev/local で server を立てる必要が常態化する。
  dev 手順が「wrapper 単体で動く」から「minimal server も同時に立てる」
  に変わる。
- 既存 4 体(ao/kuroe/momo/fuji)を pack 化して移行する初期コスト。
- 接続中 wrapper への hot-swap は phase-1 まで先送り。zip を更新して
  すぐに反映させたい dev フローで手数が増える(接続断→再接続)。

### Neutral

- runner の `runner.config.json` の `personas[]` は「per-host 制限」の
  allowlist として存続する(廃止しない)。目的は「野良禁止」ではなく
  「このホストで使わせる persona を絞る」の運用ポリシー。server SoT
  との差分は運用時警告で示す。
- persona pack schema には将来的な拡張余地(license / provenance /
  attribution 等のメタデータ)がある。初期は最小 keys で開始。

## Alternatives Considered

### F1: zip 内部スキーマ

| Option | Why rejected |
|---|---|
| フラット root 配置(root に全ファイル並置) | 将来ファイル追加で汚くなる。sprites/ が肥大する意匠変更に耐えない |
| YAML frontmatter に集約(manifest.json 廃止) | personality.md が「本文 + メタ」の二役になり tooling とリーダビリティが両方悪化 |

### F2: overlay 統合 vs 二層存続

| Option | Why rejected |
|---|---|
| bundled + overlay の二層存続 | SoT 純度が下がる(どちらが正本か曖昧) |
| overlay 撤廃し bundled のみ | bundled は release 内 read-only。docker で writable ディレクトリを確保できない |

### F3: server 到達不能時の挙動

| Option | Why rejected |
|---|---|
| default persona で起動(素の AI) | 純粋 SoT に穴を作る。dev/local を保護できるが、user は SoT 純度を優先 |
| wrapper 側キャッシュを fallback に使う | 「一度キャッシュされた古い prompt が生き続ける」現象で SoT が侵害される |

### F4: zip 検証レベル

| Option | Why rejected |
|---|---|
| hash 検証を追加(transit 破損検知) | 内輪プロジェクトには過剰。ネット越し配布が定着した時点で拡張 |
| 作成者署名を要求 | 鍵管理・運用負荷が enterprise 用途向け。内輪の信頼域では不要 |

### F5: common footer の帰属

| Option | Why rejected |
|---|---|
| wrapper 側で結合(現行踏襲) | server SoT を損なう。「wrapper に人格ロジックが残る」→ SoT が二重管理化 |
| footer 廃止し personality に埋込 | 共通仕様変更のたびに全 pack を作り直す。運用負荷大 |

### F6: watch 実装

| Option | Why rejected |
|---|---|
| polling(5〜30 秒間隔) | レイテンシとリソースの trade-off。event-driven が既に成熟している以上、選ぶ理由なし |

### F7: schema versioning

| Option | Why rejected |
|---|---|
| 最初から strict API version 分岐(v1/v2) | 内輪では過剰。breaking change 発生時に拡張すればよい |

### F8: 削除の意味論

| Option | Why rejected |
|---|---|
| 削除 = archive 扱い(接続中は継続) | F3(fail-closed)と不整合。「消えた persona で会話が続く」状態は SoT の意味を薄める |

### F9: concurrent update

| Option | Why rejected |
|---|---|
| WS メッセージで live push(hot-swap) | 実装・デバッグ困難。会話中に persona が変わる挙動は不確実性大。将来必要になった時点で拡張(phase-1) |

### F10: dev/local

| Option | Why rejected |
|---|---|
| wrapper に `--dev-mode`(dummy prompt 注入) | F3(fail-closed)に例外の穴を作る。dev だけとはいえ SoT 純度が下がる |

### F11: 作業ツリー

| Option | Why rejected |
|---|---|
| `wrapper/personas/*.md` を作業ツリーとして残す | wrapper の責務が「動かす + 作る」に肥大。sprites を別位置に置く必要も残る |

## Follow-ups

- 実装計画は [phase-10-persona-server-sot](../plans/phase-10-persona-server-sot.md)
  参照。
- 既存 4 体(ao / kuroe / momo / fuji)を pack 化して移行する作業は
  phase-10 の完了条件に含まれる。
- 旧 ADR-0008 / ADR-0026 は本 ADR にて supersede。retire 対応は phase-
  10 完了時に確定。
- Phase-1(将来): hot-swap(F9)、concurrent update 挙動の精緻化、watch
  debounce チューニング。
- Phase-2(deferred): hash / 署名検証(F4)、schema strict API
  versioning(F7)、multi-host 間の zip 同期。

## See Also

- Related specs: [personas](../specs/personas.md),
  [persona-pack-schema](../specs/persona-pack-schema.md),
  [persona-personality-injection](../specs/persona-personality-injection.md),
  [setup-wizards](../specs/setup-wizards.md),
  [protocol](../specs/protocol.md), [threat-model](../specs/threat-model.md)
- ADRs: [ADR-0002](0002-local-wrapper-websocket-topology.md)(WS 経路),
  [ADR-0003](0003-persona-identity-persistence.md)(persona 同一性),
  [ADR-0008](0008-persona-asset-distribution.md)(supersedes),
  [ADR-0024](0024-agent-instance-identity-and-spawn-auth.md)(spawn 認証),
  [ADR-0026](0026-persona-personality-injection.md)(supersedes)
- Plan: [phase-10-persona-server-sot](../plans/phase-10-persona-server-sot.md)
