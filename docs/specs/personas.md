---
title: キャラクターデザイン方針(ペルソナ立ち絵)
description: ペルソナ立ち絵のデザイン方針 — 初期 3 体の設定、表情セット、画像規格、ComfyUI 生成ワークフロー。
status: accepted
related: [protocol]
---

# キャラクターデザイン方針(ペルソナ立ち絵)

## Purpose

Phase 2 タスク 2-3(表情差分の量産)と将来のペルソナ追加が参照する、
キャラクターデザインの決定事項を定める。対象は**絵と名前、および表情
演技の方針**。口調・一人称などの実行時の応答口調は
[persona-personality-injection](persona-personality-injection.md) に委譲
する(2026-07-02 に「対象外」条項を撤回、[ADR-0026](../adr/0026-persona-personality-injection.md))。
将来のセリフ吹き出し UI との関係は
[persona-personality-vs-dialogue](../open-questions/persona-personality-vs-dialogue.md)
を参照。

## Definition

### 基本方針

- 基調は**ちびデフォルメ調**(2〜3 頭身)。小サイズのカード表示での
  表情判読性と、量産時の絵柄一貫性を優先する。
- 実験枠として**非デフォルメ 1 体**(kuroe)を併走させる。混在タッチは
  実画面評価で**採用確定**(2026-06-11): リファレンス実装は多様な
  パターンを見せるカタログであることに価値があり、雰囲気の統一は
  クライアント開発者・利用者の意思に委ねる。
- 差別化軸は「基調色 x 表情演技の振れ幅」の 2 軸。色は小サイズ表示で
  最も視認しやすい識別子として各キャラに固定する。

### 初期ペルソナ(3 体)

| persona.id | 名前 | タッチ | 基調色 | 外見 | 性格付け / 演技の振れ幅 |
|---|---|---|---|---|---|
| `ao` | あお | ちび全身 | 青 | 青系ショートヘア、パーカー、ヘッドホン | クール・控えめ。崩れた時のギャップで状態を際立たせる |
| `momo` | もも | ちび全身 | ピンク | ピンクのツインテール、リボン | 元気・オーバーリアクション。遠目で最も読みやすい |
| `kuroe` | くろえ | 非デフォルメ・バストアップ | 青みがかった黒 | 25〜30 代女性、おかっぱに近いショートヘア、シックなスーツ、モノクル | 淡々として諫言を厭わない有能秘書。冷静で振れ幅小 |

### 追加ペルソナ

以降、初期 3 体の運用と差し支えなく増やす形で追加していく。同表・
表情セットの列拡張と、下記「生成実績」への seed 追記で管理する。

| persona.id | 名前 | タッチ | 基調色 | 外見 | 性格付け / 演技の振れ幅 |
|---|---|---|---|---|---|
| `fuji` | ふじ | 非デフォルメ・バストアップ | 藤色 (wisteria purple) | 20 代前半女性、藤色の控えめな縦ロール(肩下まで)、白ブラウス+藤色ジャケット+リボンタイ、手に本 | 上品な知的マウント才媛。ミスを楽しそうに指摘し、指摘のあとにヒントを添える。「わたくし」「マスターさん」呼びで一線引いた距離感。振れ幅は小〜中(上品さと余裕を崩さない) |
| `kohaku` | こはく | 非デフォルメ・バストアップ | 琥珀 (amber) | 40 代男性、黒短髪に白髪メッシュ、シルバー細縁眼鏡、無精髭、ネイビーの襟付きシャツ | ボス呼びの CTO 型。泰然として崩れず、表情より姿勢と手で語る。振れ幅小。人格詳細は pack の personality.md を参照 |

性格付けは**立ち絵生成プロンプトで表情の出し方を一貫させるための設計
資料**であると同時に、[persona-personality-injection](persona-personality-injection.md)
経由で**実行時の人格プロンプトにも消費される**(2026-07-02 に用途を
拡張、[ADR-0026](../adr/0026-persona-personality-injection.md))。例:
同じ `done` でも ao は小さなドヤ顔 + 控えめな一言、momo は満面の笑み +
オーバーリアクションの一言、kuroe は控えめな微笑と会釈 + 淡々とした報告、
と表情演技と応答口調が対応する。

### engine 非依存で共有 (2026-07-10、[ADR-0032](../adr/0032-codex-adapter.md) F3)

`personality.md` と 立ち絵 (7 状態表情) は engine 非依存で両 engine
(`claude-code` / `codex`) が共有する。Claude では従来通り SDK
`systemPrompt.append` に注入 ([ADR-0026](../adr/0026-persona-personality-injection.md)
→ [ADR-0029](../adr/0029-persona-server-sot-and-pack-distribution.md))、
Codex では config key `developer_instructions` に注入する (developer role
メッセージとして base instructions に append される。2026-07-10 実証、
[ADR-0032](../adr/0032-codex-adapter.md) F3)。engine 別 persona pack
(`kuroe-claude` / `kuroe-codex`) や `personality.md` 内の engine 別セクション
は持たない。Codex 側 injection の実効性 (口調・態度の再現度) は
2026-07-11 の実機検証で確認済み: kuroe / ao で口調が明確に差別化され、
`developer_instructions` 注入がペルソナ別に忠実に効いた
([codex-sdk-events](codex-sdk-events.md)「実機検証メモ」)。

### デフォルトペルソナ(素の AI)

性格付けのない「素の AI エージェント」用に、立ち絵を持たない既定ペルソナ
を 1 体用意する。スプライトを同梱せず、リファレンスダッシュボードの
CSS 顔フォールバック(状態別の簡易表情、`expression.ts` / `AgentCard`)で
そのまま表示する。

| persona.id | 名前 | sprite_set | 立ち絵 | 性格付け |
|---|---|---|---|---|
| `default` | デフォルト | `default` | なし(CSS 顔) | なし |

- `sprite_set` の `default` は予約値で、取り込みディレクトリ(既定
  `server/priv/persona-packs/`、`KAOIRO_PERSONA_DIR` で変更可)に
  `id: "default"` の pack を置かない(server が
  `PersonaAssets.validate_manifest/2` で reject する)。マニフェスト
  未掲載となり、クライアントはスプライトなし描画(CSS 顔)へフォール
  バックする([protocol](protocol.md) の「ペルソナアセット配信」)。
- 7 状態の表情画像を揃える MUST(下記 Constraints)の対象外 — 意図的に
  CSS 顔を用いる唯一のペルソナ。
- kaoiro クライアントの起動ダイアログには、そのホストの trust policy
  (下記「ホスト側の受け入れポリシー」)が許容する場合の既定候補として
  現れる。ADR-0031 まで `default` は host 側の宣言と無関係に常時注入
  されていたが、id 空間の一貫性と `HostRegistry.inject_default/1` の
  単純化のため、blocklist / allowlist の対象として通常の id と同格に
  扱うようになった(下記参照)。
- ラッパー設定の `persona` ブロック例(全体構造は
  [wrapper/kaoiro.config.claude-code.example.json](../../wrapper/kaoiro.config.claude-code.example.json)
  または
  [wrapper/kaoiro.config.codex.example.json](../../wrapper/kaoiro.config.codex.example.json)):

```json
"persona": { "id": "default", "name": "デフォルト", "sprite_set": "default" }
```

### 表情セット(状態 → 演技)

生成対象は必須 7 状態。`disconnected` は生成せず、クライアント側で idle の
グレースケール化(CSS filter)により表現する(状態セットの定義は
[protocol](protocol.md)、マッピング実装はリファレンスダッシュボードの
`expression.ts`)。`fatigued` は protocol state ではなく context 使用率から
導出する optional sprite modifier で、対応画像の生成は issue #173 で行う
([ADR-0054](../adr/0054-fatigue-as-orthogonal-persona-modifier.md))。

| 状態 | ao(控えめ) | momo(大) | kuroe(冷静) | fuji(余裕あるマウント) | kohaku(泰然) |
|---|---|---|---|---|---|
| idle | 澄ました無表情 | にこにこ | 涼しい澄まし顔 | 余裕ある薄笑み、少し上目線 | 腕組みで少し遠くを見る |
| thinking | 目を閉じ静かに思考 | うーんと首をひねる | 顎に手を添え伏し目 | 顎に手、視線を斜めに、微笑 | 顎に手、伏し目で「ふむ」 |
| tool_running | 黙々と手元に集中 | 腕まくりで張り切る | PC の前でカタカタ、集中 | 手元の本/書類に目を落とし集中 | デスクトップ PC を操作、集中 |
| waiting_permission | 無言で目線を寄越す | 手を挙げて「いい?」 | 書類を差し出し決裁を仰ぐ | 片手をやさしく差し出し、片眉を上げて伺う | 書類を差し出し押印を仰ぐ |
| waiting_input | ちらっとこちらを見る | 身を乗り出して手を振る | メモを構えて静かに視線 | こちらへ向き直り、期待の微笑と少し首を傾げる | 身を乗り出して表情を覗き込む |
| done | 小さなドヤ顔 | 満面の笑み+ガッツポーズ | 控えめな微笑と軽い会釈 | 目を閉じた誇らしげな微笑、小さく頷く | 20 度振りの構図でキリッと薄笑み |
| error | 目を見開いて動揺 | 涙目 | 申し訳なさそうな表情 | 頬に手を当て、目を逸らして困り微笑 | 額に手を当て表情を隠す |
| fatigued (optional modifier) | 半眼で少し肩を落とす | しょんぼりしつつも元気を保つ | 半眼で口角を下げ、静かに消耗を示す | 伏し目で口元を緩めず、疲れを隠しきれない | 目を細め、姿勢を少し緩めて疲労を示す |

### 画像規格

- 形式: **透過 PNG**、正方形。1024x1024 で生成し、配信用に 512x512 へ
  縮小する。
- 構図: ちび(ao / momo)は全身、kuroe / fuji はバストアップ(胸上)。
  非デフォルメの全身は正方形小サイズで顔が潰れるため。
- 配置: persona pack zip 内の `sprites/<state>.png` 構造で配布
  ([persona-pack-schema](persona-pack-schema.md))。`sprite_set` は
  慣習として `persona.id` と同名。
- 配置方式(2026-07-05 更新、
  [ADR-0029](../adr/0029-persona-server-sot-and-pack-distribution.md)):
  作成者は persona pack zip として配布し、server 管理者は zip を
  **取り込みディレクトリ**(env で指定)に drop する。server は auto-
  watch で自動展開し `/api/personas` manifest を再構築する。旧来の
  bundled `server/priv/personas/` + overlay 併存モデル(ADR-0008)は
  取り込みディレクトリへ統合された。

### 生成ワークフロー(ComfyUI、ao 試作で実証済み)

1. キャラごとに固定のキャラ記述プロンプト + 固定 seed を使い、表情
   記述のみ差し替えて 7 状態を生成する。
2. **服飾・小物は配色までタグで固定**する(例: `white headphones,
   black shorts, blue and white sneakers`)。デザインが揺れやすい
   小物はタグ末尾の自然文で形状まで記述する(例: plain white round
   ear cups)。配色未指定の小物は画像ごとに変動する(実測)。
3. ネガティブプロンプトに `logo, glowing, text` を常備する(商標
   ロゴ・衣服プリント・小物の発光変種の抑止)。
4. 演技が小さい表情には idle アンカーからの i2i(denoise 0.6〜0.75)
   も有効: 服装・小物はほぼ完全に保存される一方、ポーズ・表情の変化
   は弱い(実測)。ブレ修復の手段としても用いる。
5. 試作順: ao(ちび規格の検証)→ kuroe(非デフォルメ規格の検証)→
   momo 以降の量産。
6. 本生成で使用した `animality_ap3.safetensors` の上位 Anima license は、
   Model / Derivatives を非商用に限定する一方、Outputs の商用利用を許可
   する。有償 API 等で Model を商用利用するには別途商用ライセンスを要する。
   派生モデル固有の配布条件も併せて確認する。

### 生成実績(2026-06-11、再現用 provenance)

| persona | model | 固定 seed | 追加日 |
|---|---|---|---|
| ao | `animality_ap3.safetensors` | `188531704877709` | 2026-06-11 |
| momo | `animality_ap3.safetensors` | `15180469782598` | 2026-06-11 |
| kuroe | `animality_ap3.safetensors` | `78243803967796` | 2026-06-11 |
| fuji | `animality_ap3.safetensors` | `218473265094718` | 2026-07-05 |
| kohaku | `animality_ap3.safetensors` | `87170280435203` | 2026-08-08 |

作業成果物は `assets-work/dist/<sprite_set>/<state>.png`(1024x1024
透過 PNG、rembg `birefnet-portrait` で背景除去、git 管理外)。配布用
の正本は persona pack zip
([persona-pack-schema](persona-pack-schema.md))として `persona-packs/
<id>/` に管理し、`scripts/build-persona-pack.sh` で zip 化して server
の取り込みディレクトリに置く。旧来の bundled `server/priv/personas/`
直配置は phase-10(ADR-0029)で撤去済み。配信 API の形式は
[protocol](protocol.md) の「ペルソナアセット配信」を参照。

プロンプト本文・steps 等の完全な再現用パラメータは
`persona-packs/<id>/provenance/<state>.json` を参照
(フィールド定義・取り込み方式は
[persona-pack-schema](persona-pack-schema.md) 「provenance/」参照)。
取り込み済みは ao / momo / kuroe / kohaku の 4 ペルソナ。fuji は
Anima dir 側に生成物(json)は残るが rembg 前 PNG が `assets-work/` に
無く、seed は 7 状態で共通のため state を決定論的に特定できず未取り込み。

### 配布と取り込み(pack ワークフロー)

作成 → 配布 → 運用の全フローは
[ADR-0029](../adr/0029-persona-server-sot-and-pack-distribution.md) に
基づき、以下のように統一される:

1. **作成者**: `persona-packs/<id>/{manifest.json, personality.md,
   sprites/}` を編集
2. **provenance 取り込み**(推奨): `scripts/import-anima-provenance.sh
   <id>` で Anima dir から `persona-packs/<id>/provenance/<state>.json`
   を生成。rembg 前 PNG が `assets-work/` に無い等で sha256 照合が
   決定論的に成立しない場合は見送る(fuji の前例参照)。
3. **build**: `scripts/build-persona-pack.sh` で zip 化(
   `<id>-<version>.zip`)
4. **管理者**: zip を server の取り込みディレクトリ(env で指定)に drop
   し、**同じ `id` の旧 version の zip を取り除く**。取り込みは `id` 衝突
   時に先勝ちで zip をファイル名順に読むため、旧 version を残すと新
   version が採用されない
   ([persona-pack-schema](persona-pack-schema.md) の unique 性 MUST)
5. **server**: auto-watch が検知して自動展開、manifest を再構築
6. **wrapper**: 起動時 WS ハンドシェイクで人格プロンプトを server から
   受信して SDK に注入
   ([persona-personality-injection](persona-personality-injection.md))

zip 内部スキーマの詳細は
[persona-pack-schema](persona-pack-schema.md) を参照。

### ホスト側の受け入れポリシー(runner trust policy)

server が ingest したペルソナのうち「実際にどれをこのホストで起動可能に
するか」は、runner が config で宣言する 3 つのポリシーから 1 つを選ぶ
([ADR-0031](../adr/0031-runner-persona-trust-mode.md)):

- **accept-all**(既定): server-known な全ペルソナを起動可能。
  `runner.config.json` にペルソナ関連フィールドを書かない状態。
  新 pack を server に置けば、稼働中の runner 再起動なしに反映される
  (判定は server 側 `AgentsChannel` 完結)。
- **allowlist**: `allowed_personas: [id, ...]` で列挙した id のみ起動可能。
- **blocklist**: `blocked_personas: [id, ...]` で列挙した id を除いた
  server-known 全ペルソナが起動可能。

3 つはいずれも「宣言 1 つだけ」で、`allowed_personas` と
`blocked_personas` を同時指定した config は fail-loud で reject する
(runner 起動時と server register 時の両方)。旧 `personas: [...]`
フィールドは 1 リリース互換窓で allowlist 相当として受け入れ、
deprecation 警告を出す。

`default` id もこのポリシーの対象となる — `blocked_personas` に列挙
すれば起動候補から外れ、その結果として spawnable が空になった host
(canary / 準備中 host)は合法状態として扱う(dashboard は空 picker を
明示表示)。

## Constraints

- 各ペルソナは必須 7 状態すべての表情画像を MUST で揃える(`default`
  ペルソナは除く — 立ち絵を持たず CSS 顔で表示する)。`fatigued` は optional
  で、pack が宣言した場合は対応画像を MUST で揃える。
- `disconnected` の画像は生成しない(MUST NOT)。クライアント側の
  グレースケール表現に統一する。
- `persona.id` は安定 ID であり変更しない
  ([ADR-0003](../adr/0003-persona-identity-persistence.md))。
- 表情はカード表示の小サイズ(目安 128px 角)で判読できる SHOULD。
- 生成物に実在ブランドのロゴ・商標を含めない(MUST NOT)。検収時に
  小物(デバイス・靴・ヘッドホン)を確認する。
- 描画は静的差分切り替えの範囲とする
  ([ADR-0004](../adr/0004-client-rendering-staged.md))。

## Open Questions

なし。

## See Also

- Related specs: [protocol](protocol.md),
  [persona-pack-schema](persona-pack-schema.md),
  [persona-personality-injection](persona-personality-injection.md)
- ADRs: [0003](../adr/0003-persona-identity-persistence.md),
  [0004](../adr/0004-client-rendering-staged.md),
  [0008](../adr/0008-persona-asset-distribution.md)(superseded),
  [0026](../adr/0026-persona-personality-injection.md)(superseded),
  [0029](../adr/0029-persona-server-sot-and-pack-distribution.md)
- Plans: [phase-2-client-character](../plans/phase-2-client-character.md),
  [phase-10-persona-server-sot](../plans/phase-10-persona-server-sot.md)
