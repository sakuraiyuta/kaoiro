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

性格付けは**立ち絵生成プロンプトで表情の出し方を一貫させるための設計
資料**であると同時に、[persona-personality-injection](persona-personality-injection.md)
経由で**実行時の人格プロンプトにも消費される**(2026-07-02 に用途を
拡張、[ADR-0026](../adr/0026-persona-personality-injection.md))。例:
同じ `done` でも ao は小さなドヤ顔 + 控えめな一言、momo は満面の笑み +
オーバーリアクションの一言、kuroe は控えめな微笑と会釈 + 淡々とした報告、
と表情演技と応答口調が対応する。

### デフォルトペルソナ(素の AI)

性格付けのない「素の AI エージェント」用に、立ち絵を持たない既定ペルソナ
を 1 体用意する。スプライトを同梱せず、リファレンスダッシュボードの
CSS 顔フォールバック(状態別の簡易表情、`expression.ts` / `AgentCard`)で
そのまま表示する。

| persona.id | 名前 | sprite_set | 立ち絵 | 性格付け |
|---|---|---|---|---|
| `default` | デフォルト | `default` | なし(CSS 顔) | なし |

- `sprite_set` の `default` は予約値で、`server/priv/personas/` に同名
  パックを置かない。マニフェスト未掲載となり、クライアントはスプライト
  なし描画(CSS 顔)へフォールバックする([protocol](protocol.md) の
  「ペルソナアセット配信」)。
- 7 状態の表情画像を揃える MUST(下記 Constraints)の対象外 — 意図的に
  CSS 顔を用いる唯一のペルソナ。
- 将来、kaoiro クライアントからエージェントを追加起動する際の既定の
  選択肢として常に提示する(起動機能の実装に依存)。
- ラッパー設定の `persona` ブロック例(全体構造は
  [wrapper/kaoiro.config.example.json](../../wrapper/kaoiro.config.example.json)):

```json
"persona": { "id": "default", "name": "デフォルト", "sprite_set": "default" }
```

### 表情セット(状態 → 演技)

生成対象は 7 状態。`disconnected` は生成せず、クライアント側で idle の
グレースケール化(CSS filter)により表現する(状態セットの定義は
[protocol](protocol.md)、マッピング実装はリファレンスダッシュボードの
`expression.ts`)。

| 状態 | ao(控えめ) | momo(大) | kuroe(冷静) |
|---|---|---|---|
| idle | 澄ました無表情 | にこにこ | 涼しい澄まし顔 |
| thinking | 目を閉じ静かに思考 | うーんと首をひねる | 顎に手を添え伏し目 |
| tool_running | 黙々と手元に集中 | 腕まくりで張り切る | PC の前でカタカタ、集中 |
| waiting_permission | 無言で目線を寄越す | 手を挙げて「いい?」 | 書類を差し出し決裁を仰ぐ |
| waiting_input | ちらっとこちらを見る | 身を乗り出して手を振る | メモを構えて静かに視線 |
| done | 小さなドヤ顔 | 満面の笑み+ガッツポーズ | 控えめな微笑と軽い会釈 |
| error | 目を見開いて動揺 | 涙目 | 申し訳なさそうな表情 |

### 画像規格

- 形式: **透過 PNG**、正方形。1024x1024 で生成し、配信用に 512x512 へ
  縮小する。
- 構図: ちび(ao / momo)は全身、kuroe はバストアップ(胸上)。
  非デフォルメの全身は正方形小サイズで顔が潰れるため。
- 配置: `<sprite_set>/<state>.png` 構造で配置
  ([ADR-0008](../adr/0008-persona-asset-distribution.md) 第 1 段階)。
  `sprite_set` は persona.id と同名とする。
- 配置方式(2026-06-11 決定): **同梱 + オーバーレイ**。リファレンス
  パックとして `server/priv/personas/` に同梱(git 管理)し、env 変数
  `KAOIRO_PERSONA_DIR` 指定時は外部ディレクトリを優先走査・同名なしは
  同梱分へフォールバックしてマニフェストを生成する。第 1 段階の
  マニフェストはファイル走査で生成し、SQLite はアップロード API
  導入時に検討する。

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

### 生成実績(2026-06-11、再現用 provenance)

| persona | model | 固定 seed |
|---|---|---|
| ao | `animality_ap3.safetensors` | `188531704877709` |
| momo | `animality_ap3.safetensors` | `15180469782598` |
| kuroe | `animality_ap3.safetensors` | `78243803967796` |

全 3 ペルソナ x 7 状態 = 21 枚。作業成果物は
`assets-work/dist/<sprite_set>/<state>.png`(512x512 透過 PNG、
isnet-anime で背景除去、git 管理外)。正式配置済みの git 管理コピーは
`server/priv/personas/`(2026-06-11、
[ADR-0008](../adr/0008-persona-asset-distribution.md) 第 1 段階の
配信実装と同時)。配信 API の形式は [protocol](protocol.md) の
「ペルソナアセット配信」を参照。

## Constraints

- 各ペルソナは 7 状態すべての表情画像を MUST で揃える(`default`
  ペルソナは除く — 立ち絵を持たず CSS 顔で表示する)。
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
  [persona-personality-injection](persona-personality-injection.md)
- ADRs: [0003](../adr/0003-persona-identity-persistence.md),
  [0004](../adr/0004-client-rendering-staged.md),
  [0008](../adr/0008-persona-asset-distribution.md),
  [0026](../adr/0026-persona-personality-injection.md)
- Plans: [phase-2-client-character](../plans/phase-2-client-character.md),
  [persona-personality-injection](../plans/persona-personality-injection.md)
