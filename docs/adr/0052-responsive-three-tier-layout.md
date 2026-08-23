---
title: dashboard を 3 サイズ対等のレスポンシブレイアウトへ転換する
status: accepted
date: 2026-08-09
opened: 2026-08-09
supersedes: []
superseded_by: null
related_specs: [design, responsive-layout, responsive-reachability]
related_adrs: [12]
---

# ADR-0052 — dashboard を 3 サイズ対等のレスポンシブレイアウトへ転換する

## Status

Accepted

## Context

[design.md](../specs/design.md) の Responsive 節は「モバイル/狭幅は
first-class ではないが、破綻はしない」と定めていた。実装もこれに沿い、
`@media (max-width: 640px)` が 2 箇所あるだけで、体系的な breakpoint 設計は
存在しなかった。

**この「破綻はしない」は既に事実でない。** 2026-07-24 に response timeline の
wide ゲート (`min-width: 1600px`) が撤廃され、operator セッションでは全幅で
timeline が表示されるようになった。当時の方針は「狭幅ではペインを隠さず、
タイルを小さくして受け入れる」だったが、現行 CSS を Chromium で実測すると
viewport 640px では grid が 136px しか残らず、3 列 tile は約 32.5px になる。
`minmax(15rem, 1fr)` の下限 240px を大きく割り込んでおり、レイアウトとして
成立していない。

あわせて AgentDetail の狭幅挙動も限界に達している。`.status` サイドバーは
15 以上の `cc-row` (モデル切替 / permission モード / context メーター /
rate limit / resume) を持ち `.status-scroll` で内部スクロールするが、現行の
640px media query は `.body` を `column` にするだけなので、外側スクロールと
二重になり会話ログへ到達できない。

さらに dashboard を明示的な PWA として定義する作業
([#196](https://github.com/sakuraiyuta/kaoiro/issues/196)) により、
ホーム画面から起動した実用的なアプリとして 3 サイズで成立させたいという要求が
生じた。「狭幅は first-class ではない」という前提そのものを見直す必要がある。

## Decision

dashboard を **PC / tablet / smartphone の 3 サイズで対等に成立させる**。
design.md の「モバイル/狭幅は first-class ではない」は本 ADR をもって撤回
する。寸法と規則の詳細は
[responsive-layout.md](../specs/responsive-layout.md)、到達経路の網羅表は
[responsive-reachability.md](../specs/responsive-reachability.md) が canonical。

- **F1**: smartphone 幅では lobby の response timeline を同一画面内のボトム
  シートへ退避し、grid を全幅化する
- **F2**: tablet 幅以下では AgentDetail の `.status` をボトムシートへ退避し、
  handle で引き出す
- **F3**: ボトムシートはユーザの明示操作でのみ開き、AgentDetail の dock 類
  より前面に置く (global dialog / drawer よりは背面)。ただし**シート展開中も
  pending permission / question と他エージェントの要対応件数に気づける
  インジケータを出し、かつ handle 上の attention バッジ自体を「一覧へ戻す」
  操作とすることを MUST とする** — ADR-0012 F8 は盲点インジケータの常時表示
  だけでなくクリックで一覧へ戻すことまで決定しており、気づかせるだけでは
  その決定を満たさないため
- **F4**: Tasklist float と question-dock の折りたたみ/詳細表示は、当面
  desktop と同一挙動とする (暫定)
- **F5**: response timeline の track を `minmax(22rem, 26rem)` から
  **`22rem` 固定へ変更**し、breakpoint はフレームワークの慣習値ではなく
  kaoiro の実装寸法から逆算した値を使う (desktop 下限 1199px / tablet 下限
  940px / 低背 500px)
- **F6**: レイアウト切り替えは CSS media query 中心とし、DOM 構造は全サイズ
  共通に保つ。Svelte の状態として持つのはシートの開閉のみ
- **F7**: tablet 幅 (940〜1198px) では lobby の timeline を横並びで残す。
  **iPad 縦 (768px) とスマートフォン横向き (844px) は smartphone 帯に入る** —
  この幅で timeline を横並びにすると tile が 122〜160px となり、sprite 単体の
  128px すら確保できないため
- **F8**: 高さ 500px 以下の `short` は幅トークンと直交する override とし、
  **縦方向の圧縮のみ**を扱う (header の縦 padding / composer の初期高 /
  in-flow dock 類の高さ上限 / dialog・drawer の `max-block-size`)。横方向の
  レイアウト (timeline の配置、status の配置、grid の列数) と、幅によらず
  一定であるシート最大高は変更しない。dock の**展開状態も変えない** — 実装が
  新しい `request_id` ごとに折りたたみを解除する契約 (pending な判断を古い
  折りたたみ状態で隠さない) を持ち、viewport 依存で初期状態を変えると
  F6 に反するため

「対等」とは **全機能・全情報へ到達可能**であることを指し、到達経路がサイズ
ごとに異なることは許容する。smartphone でも 確認 / 指示送信 / permission
承認 まで行えることを要件とし、ソフトウェアキーボード表示中も composer へ
到達できることを含む。

## Consequences

### Positive

- smartphone から実際にエージェントを回せるようになり、PWA 化の動機と実利が
  一致する
- AgentDetail の二重スクロールが解消し、狭幅でも会話ログが主役になる
- breakpoint の値に内訳と根拠が伴い、tile 幅や timeline 幅を変えたときに
  再計算すべき箇所が明示される
- DOM を全サイズ共通に保つ決定 (F6) により、画面回転時に composer の入力途中
  テキストとログのスクロール位置が保持される

### Negative

- timeline track を `22rem` 固定にするため、広い画面での timeline 表示密度が
  従来より下がる (最大 416px → 352px)
- ボトムシート機構が新規実装として必要になり、lobby と AgentDetail の双方が
  これに依存する
- iPad 縦が smartphone 帯に入るため、「tablet」という呼称と実際の端末の
  対応が直感と食い違う
- 検証対象が iOS/iPadOS Safari と Android Chrome の実機 2 系統に増える

### Neutral

- design.md は視覚デザイン (色・タイポグラフィ・モーション) に責務を絞り、
  寸法とレイアウト切り替えは responsive-layout.md が持つ形に分かれる
- design.md は `format: stitch-design-md` で「実装を canonical source として
  追認する」性格を持つが、phase-31 完了までは本 ADR に基づく target 記述に
  なる。実装完了後に実装との同期を取り直す

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
| 狭幅で timeline を grid の下へ縦積み | スクロールしないと到達できず「常時観測」の価値が失われる。エージェント数が多いと事実上到達不能 |
| 狭幅で timeline を出さない (wide ゲート復活) | 「全機能・全情報に到達可能」という前提に正面から反する |
| AgentDetail を会話/ステータスのタブで排他切り替え | log と context メーターを同時に見られない |
| AgentDetail の縦積みを折りたたみ可能にする | 展開時に二重スクロールが残り、畳んでもヘッダ分の高さを消費する |
| breakpoint にフレームワーク慣習値 (768/1024/1280) を採用 | 実寸と一致せず境界で壊れる。実測では 768px の tile が 122px にしかならない |
| timeline track を現行のまま維持し境界を 1263px に置く | desktop 下限が上がりすぎ、1200px 級のウィンドウが tablet に落ちる |
| 幅に加えて入力手段 (`pointer: coarse`) も判定に使う | 判定軸が二重になり、同じ幅で 2 種類のレイアウトが存在しうるため検証コストが倍増する |
| `matchMedia` + `{#if}` でサイズ別に DOM を分岐 | 画面回転時の再マウントで composer の入力とスクロール位置が失われる |
| container query 中心 | viewport 全体で決まる要素 (ヘッダ / シート / セーフエリア) が多く利点が効かない |
| tablet 帯を 940px で 2 分割して 4 段にする | 判定が 4 通りに増え、実装とテストの組み合わせが膨らむ |
| 承認 UI をシートより前面に固定 | シートが明示操作で開くものである以上、直前の操作意図を覆す。インジケータの MUST 化で代替する |
| `short` で lobby timeline をシートへ退避させる | 幅の下限を 940px にしたことで、低背端末 (844×390 等) は幅だけで既に smartphone 帯に入る。desktop / tablet 幅の低背では横並びが成立しており、退避すると逆に最大 300px (500×60%) まで狭める |
| 盲点インジケータをバッジ表示のみで代替 | ADR-0012 F8 はクリックで一覧へ戻す操作までを決定しており、存在を知らせるだけでは決定を満たさない |
