---
title: Live2D ライクな OSS 描画の調査(立ち絵に動きをつける)
description: 立ち絵に idle モーションをつける Live2D 類似 OSS の候補比較(ライセンス・成熟度・Web 組込み・一枚絵流用可否)と採否提案。導入決定は別途(issue #20)。
status: open
urgency: low
blocks: []
opened: 2026-06-15
decided: null
---

## 背景

現行のペルソナ描画は静的な表情差分の切り替え([ADR-0004](../adr/0004-client-rendering-staged.md))。
立ち絵に動きをつけたい(低優先)ため、次段の選択肢として Live2D 類似の
OSS を調査する。ADR-0004 がこの調査自体を将来課題として記録しており、
本ファイルがその回答。導入の決定は調査結果を見て別途判断(issue #20)。

調査スコープ(ユーザ確認済み 2026-06-15):

- 動きの範囲: **idle モーション主軸**(まばたき・呼吸・軽い揺れ)。
  リップシンク・状態連動の表情変化は「将来拡張余地」として各候補の
  対応可否のみ評価。
- 素材: **既存の一枚絵 PNG を流用優先**([personas.md](../specs/personas.md) の
  透過 PNG・パーツ非分割)。パーツ分割の作り直しが必須な候補は
  「素材作成コスト高」として明示。

## 選択肢(候補比較)

| 候補 | ライセンス | 成熟度 | Web 組込み | 一枚絵流用 | idle | リップシンク(将来) |
|------|-----------|--------|-----------|-----------|------|---------------------|
| 1. PixiJS メッシュワープ(自前) | MIT(純 OSS) | PixiJS は成熟。自前実装は新規 | ◎ | ◎ | ◎ | ✕ |
| 2. Inochi2D / Inox2D | BSD-2(純 OSS) | 本体は実用域。Web 版 Inox2D は**プロトタイプ「本番非推奨」** | △(WebGL/WASM 例あり・実験段階) | ✕(INP/INX パーツ分割リグ必須) | ◎ | ◎ |
| 3. Rive | ランタイム/レンダラ MIT | 成熟(Spotify/Duolingo 等で採用) | ◎(.riv はオフライン永続動作) | △(画像取込→手動リグ要) | ◎ | ◎ |
| 4. Live2D Cubism (+ pixi-live2d-display) | **非 OSS**(Cubism Core 専有。ラッパは MIT) | 最成熟・エコシステム最大 | ◎ | ✕(PSD パーツ分割リグ必須) | ◎ | ◎ |
| 5. AI 単画像アニメ化の事前生成 | パイプライン OSS(ComfyUI 等) | 品質ばらつき・顔中心 | ◎(事前生成 webm/スプライト再生) | ◎ | ◯(事前ループ) | △ |

補足(検討のうえ除外):

- **Synfig / Enve**: 汎用 2D アニメ制作。リアルタイム Web パペット用途では
  ない。
- **Spine**: 高品質だが商用・非 OSS のため要件外。
- **DragonBones**: かつて無償だがメンテが停滞しており新規採用は非推奨。

## 影響

- ADR-0004 は「技術的に可能ならペルソナごとに静的差分/アニメ/3D を選択
  可能にする」と決定済み。採用しても**ペルソナ単位の段階導入**が可能で、
  既存の静的差分描画と共存できる(persona に描画種別フィールドが必要 —
  [ADR-0003](../adr/0003-persona-identity-persistence.md) / ADR-0004)。
- [non-goals.md](../specs/non-goals.md) は「アニメ/3D の高度な描画」を非
  スコープとする。本件は**その即時解除ではなく**、軽量 idle に限定した
  次段選択肢の評価(issue #20 スコープ外に「非ゴールの即時解除」を明記)。
- 一枚絵流用を優先する場合、本格リグエンジン(候補 2/4)は各ペルソナを
  レイヤ分割・リグし直す素材コストが発生する。現行 21 枚(3 体 x 7 状態)を
  作り直す規模になり、低優先タスクには重い。

## 判断材料

### 候補別の要点(一次情報で確認)

1. **PixiJS メッシュワープ(自前)** — 一枚絵 PNG をグリッドメッシュに分割し、
   頂点を sine 変位させて呼吸・揺れ・微パララックスを表現する軽量手法。
   スコープ(一枚絵+idle)に最も素直に合致。瞬きは一枚絵単体では不可
   (まぶたレイヤがない)だが、**閉眼 idle 差分を 1 枚生成して
   クロスフェード**すれば実現でき、既存の ComfyUI i2i 量産フロー
   ([personas.md](../specs/personas.md))をそのまま流用できる。依存最小・
   OSS 純度最高だが、実装は自前で、表現力は本格リグに劣る(リップシンク不可)。

2. **Inochi2D / Inox2D** — BSD-2-Clause の純 OSS。リアルタイム 2D パペット
   (レイヤ分割アートをメッシュ変形)。Inochi Creator(エディタ)で INP/INX
   パペットを作る前提で、**一枚絵は動かせない**。公式 Rust 版 **Inox2D** が
   WebGL/WASM レンダリング例を持ち Web 化の道はあるが、ドキュメント自身が
   「プロトタイプ状態・本番非推奨」と明記。**純 OSS で本格リグが要る場合の
   将来昇格パスとして監視**する位置づけ。

3. **Rive** — ランタイム/レンダラは MIT で、書き出した `.riv` はオフライン・
   自己ホストで恒久動作(ランタイム料なし)。Web 組込みは Canvas/WebGL/WASM
   で最良。一方**エディタはクラウド専有 SaaS**で、2026 時点で**書き出しが
   有料プラン必須**(Cadet $9/mo〜)。OSS 純度(エディタ非公開)と恒常
   コスト・クラウドオーサリングが減点。画像取込+ボーン/メッシュで idle は
   作れるが手動リグが要る。

4. **Live2D Cubism (+ pixi-live2d-display)** — 品質・エコシステム最大だが
   **非 OSS**。Web 表示の pixi-live2d-display 自体は MIT ラッパだが、専有の
   **Cubism Core** ランタイム同梱が必須。出版ライセンスは年商 1000 万円未満の
   個人/小規模事業者は免除だが、ユーザがコンテンツを追加できる
   「Expandable Application」は**免除対象でも別途審査・契約が必要**で、
   kaoiro(クライアントがペルソナを足せる)は該当の懸念がある。PSD パーツ
   分割リグ前提で素材コストも最大。**OSS 要件により不採用、品質ベンチ
   マークとして参照**。

5. **AI 単画像アニメ化の事前生成**(LivePortrait/Thin-Plate-Spline 等) —
   一枚絵から idle ループを**オフラインで事前生成**し webm/スプライトとして
   再生。手持ちの ComfyUI GPU サーバを活かせ、ライブリグ不要。ただし品質が
   ばらつき顔中心で、素材が肥大しライブ性(状態即応)に欠ける。**自前リグ
   なしでリッチ idle が欲しい場合の中間案**。

### 評価軸の重み

issue #20 のスコープ(idle 主軸 + 一枚絵流用 + 純 OSS + 低優先)では、
「一枚絵流用可否」と「OSS 純度」が支配的。本格リグの表現力(リップシンク等)
は将来拡張の評価項目どまり。この重みでは候補 2/4 の本格リグは素材コストで
脱落し、候補 1 が最有力、候補 5 が中間案、候補 3 はコスト許容時の選択肢。

## 暫定方針

1. **次段の描画ティアの本命は候補 1(PixiJS メッシュワープ自前実装)**。
   一枚絵 PNG をそのまま流用でき、OSS 純度・依存最小・非ゴール(高度
   アニメ/3D)に抵触しない。瞬きは閉眼 idle 差分 1 枚を ComfyUI i2i で生成し
   クロスフェードで補う。
2. **リップシンク/本格表情リグまで要件が伸びた場合の純 OSS 昇格パスとして
   Inochi2D(Inox2D の成熟待ち)を監視**。
3. Rive はコスト($9/mo〜)とクラウドオーサリングを許容できる場合のみ。
   Live2D は OSS 要件で不採用(参照ベンチマーク)。
4. まず ao など 1 体で mesh-warp の PoC を行い、判読性・コストを実画面評価。
   導入の最終決定は本調査を踏まえ別途(issue #20 スコープ通り)。

## 解決時のアクション

- 採用方針が固まれば **ADR 化**(ADR-0004 を補足する新規 ADR、または
  0004 更新)し、persona の**描画種別フィールド**追加を plan へ
  ([ADR-0003](../adr/0003-persona-identity-persistence.md) / ADR-0004)。
- 候補 1 採用時は、瞬き用の**閉眼 idle 差分**の生成を
  [personas.md](../specs/personas.md) の生成ワークフローに追記。
- このファイルを `decided` にして ADR へ昇格(または削除)。

## Sources

調査 2026-06-15。一次情報で確認した主な出典:

- Inochi2D ライセンス(BSD-2): <https://github.com/Inochi2D/inochi2d/wiki/Legal-Info>
- Inox2D(Rust/WASM・プロトタイプ): <https://github.com/Inochi2D/inox2d>,
  <https://docs.inochi2d.com/en/latest/inox2d/about.html>
- Rive ランタイム MIT: <https://rive.app/docs/runtimes/getting-started>
- Rive 価格(書き出し有料): <https://rive.app/pricing>,
  <https://rive.app/blog/rive-s-new-9-mo-plan>
- pixi-live2d-display(Cubism Core 必須): <https://github.com/guansss/pixi-live2d-display>
- Live2D SDK 出版ライセンス/免除条件: <https://www.live2d.com/en/sdk/license/>,
  <https://help.live2d.com/en/sdk/sdk_007/>
