---
title: レスポンシブ時の到達経路インベントリ
description: 3 サイズ対等の要件「全機能・全情報へ到達可能」を検証可能にするため、UI 要素ごとの表示条件・サイズ別到達経路・スクロール所有者を網羅する。
status: provisional
related: [responsive-layout, design]
---

# レスポンシブ時の到達経路インベントリ

## Purpose

[responsive-layout.md](responsive-layout.md) は「全サイズから全機能・全情報へ
到達可能でなければならない」と定めるが、総論のままでは検証できない。本仕様は
UI 要素を列挙し、サイズごとの到達経路を確定させることでこの要件を検証可能に
する。[phase-31](../plans/phase-31-responsive-ui.md) の受け入れ基準は本表を
参照する。

用語:

- **表示条件** — その要素が DOM に存在する条件 (role / view / state /
  capability)。条件を満たさないときは存在しないのが正しく、欠落ではない
- **常時** — 表示条件が成立している間、操作なしで視界にあること
- **到達経路** — その要素を視界に出すまでにユーザが行う操作

## Definition

### app chrome

| 要素 | 表示条件 | desktop / tablet | smartphone |
|---|---|---|---|
| タイトル (`h1`) | 常 (ログイン画面にも在る) | 常時 | 常時 (ロゴのみに縮退可) |
| エージェント一覧チップ (`nav.agent-strip`) | 認証済み かつ detail 表示中 かつ 2 体以上 | 常時 | 常時 (横スクロール) |
| 接続状態 (`p.conn`) | 認証済み | 常時 | 常時 (ドットのみに縮退可) |
| 設定 (`button.settings-toggle`) | 認証済み | 常時 | 常時 |
| 起動 (`button.launch`) | 認証済み かつ operator かつ 接続中 | 常時 | 常時 |
| ログアウト (`button.logout`) | 認証済み | 常時 | SettingsDrawer 内へ移してよい |
| spawn notice (`p.spawn-notice`) | 認証済み かつ notice 発生時 | 常時 | 常時 |
| ログイン画面 | 未認証時 | 常時 | 常時 (縦 1 カラム) |

### lobby

grid の列制御は **role と timeline の配置に従属する**。列を固定するのは
timeline を横並びに置くときだけで、それ以外は `auto-fill` が正となる。

| grid | 表示条件 | 列 |
|---|---|---|
| live grid (timeline 横並び) | operator かつ desktop / tablet 幅 | desktop 3 列 / tablet 2 列 |
| live grid (timeline シート) | operator かつ smartphone 幅 | `auto-fill` |
| live grid | viewer | 全幅で `auto-fill` (timeline を持たない) |
| offline grid (`details.offline` 内) | operator かつ offline 在り | 常に `auto-fill` |

| 要素 | 表示条件 | desktop / tablet | smartphone |
|---|---|---|---|
| カード → detail を開く | directory-only でない (directory-only は `disabled`) | カード本体 | 同左 |
| カードの state 表示 | 常 | 常時 | 常時 |
| カードの attention 表示 | state / pending 依存 | 常時 | 常時 |
| カードの stats 表示 | stats に使える `ext` 値が 1 つ以上 かつ `settings.agentCardStatsEnabled` | 常時 | 常時 |
| カードの stop / restore | agent state + connection | カード上 | 同左 |
| カードの interrupt / delete | agent state + connection | カード上 | 同左 |
| response timeline | operator | 常時 (右ペイン) | handle → シート |
| timeline の既読操作 | operator かつ既読可能エントリ在り | 常時 | シート内 |
| offline 一覧 (`details.offline`) | operator かつ offline 在り | 折りたたみ展開 | 同左 |
| 一括復元 / 一括削除 | 同上 | offline 展開後 | 同左 |

### AgentDetail

| 要素 | 表示条件 | desktop | tablet | smartphone |
|---|---|---|---|---|
| グリッドへ戻る (`button.back`) | 常 | 常時 | 常時 | 常時 |
| 盲点インジケータ (`button.blindspot`) | 他エージェントに要対応在り | 常時 | 常時 | 常時 (下記) |
| 前後エージェント切替 | 2 体以上 | 常時 | 常時 | 常時 |
| status (モデル / effort / permission mode) | 常 | 常時 (左サイドバー) | handle → シート | handle → シート |
| context / rate limit メーター | capability 有り | 常時 (左サイドバー) | シート内 | シート内 |
| resume (セッション再開) | 接続中 | 常時 (左サイドバー) | シート内 | シート内 |
| stop / restore | 接続中 + agent state により排他 | 常時 (左サイドバー) | シート内 | シート内 |
| clear history | 接続中 | 常時 (左サイドバー) | シート内 | シート内 |
| resume セッション候補 (`ul.resume-menu`) | resume 操作時 | サイドバー内 | シート内 | シート内 |
| 会話ログ | 常 | 常時 | 常時 | 常時 |
| ログ内の折りたたみ展開 / load earlier / retry | 該当エントリ在り | ログ内 | 同左 | 同左 |
| interrupt / delete | 接続中 + agent state により排他 | ログと composer の間 | 同左 | 同左 |
| composer | 常 | 常時 (ボトム固定) | 常時 | 常時 |
| 添付 / slash menu | composer から | composer 上 | 同左 | 同左 |
| permission-dock / question-dock | pending 時 | ログと composer の間 | 同左 | 同左 |
| Tasklist float | [#178](https://github.com/sakuraiyuta/kaoiro/issues/178) 実装後 | ログ右上 | 同左 | 同左 |

`interrupt` / `delete` と 2 種の dock は、実装上 `.main` 内でログと composer の
間に置かれた **in-flow 要素**であり、浮遊層ではない。シートはこれらより前面に
来るため、シート展開中は覆われる。

Tasklist float は #178 が未実装のため、本表の行は同 issue 実装後に適用される
条件付きの target であり、phase-31 の検収対象ではない。

### 盲点インジケータの扱い

[ADR-0012](../adr/0012-response-display-and-dashboard-scope.md) F8 は、他
エージェントの要対応を**常時表示**し、**クリックで一覧へ戻す**ところまでを
決定している。シート展開中は `button.blindspot` がシートに覆われるため、
**シートの handle 上に attention バッジを置き、それ自体を「一覧へ戻す」操作
とする**。件数の表示とクリック先は `button.blindspot` と同一にする。

### overlay の層

| 要素 | 表示条件 | 層 |
|---|---|---|
| LaunchDialog / SettingsDrawer (backdrop 含む) | 起動時 | シートより前面 |
| シートの handle | 当該領域がシート化されるサイズでは常時 (閉時も) | dock 類より前面 |
| シートの panel / backdrop | 上記かつ展開時 | handle と同じ層 |
| handle 上の attention バッジ | シート展開中 かつ 他エージェントに要対応在り | handle 内 |
| handle 上の pending lamp | シート展開中 かつ 当該ビューに pending permission / question 在り (detail は当該 agent、lobby はいずれかの agent) | handle 内 (開閉トグル内の非対話表示) |
| slash menu / switch menu (composer 由来) | 起動時 | ページ側 (シートより背面) |
| resume menu (status 由来) | 起動時 | シート content 上 |

handle は閉じている間も表示され続ける (シートを開く導線であるため)。
attention バッジは handle の内側に置くが、**handle 自体を `button` にして
バッジを入れ子にしてはならない** — interactive 要素の入れ子になる。handle は
コンテナとし、開閉トグルとバッジを兄弟の `button` として並べる。

global な overlay は LaunchDialog と SettingsDrawer のみで、その backdrop も
シート全体より前面に置く。アンカー相対のメニューは、それを起動した要素と同じ
層に属する。

### スクロール所有者

| 画面 | desktop | tablet | smartphone |
|---|---|---|---|
| lobby | grid と timeline が各自 | 同左 | grid のみ (timeline はシート内) |
| AgentDetail | status と log が各自 | log のみ (status はシート内) | 同 tablet |
| シート展開中 | — | シート内のみ (背景は固定) | シート内のみ (背景は固定) |

禁止するのは**ページの主縦スクロール領域が入れ子になること**であり、
tool 出力の `pre`、アンカーメニュー、`question-dock` 内スクロールのような
高さ上限を持つ局所スクロールは対象外。

シート自体は、wrapper と content のどちらか一方だけを縦スクロール所有者と
する。両方が持つと即座に二重になる。

`.status` をシートへ入れる場合の採用形は **`.status` 自身を所有者**とし、
identity header (`.head`) ごとスクロールさせる。desktop の分割
(pinned `.head` + `.status-scroll` 所有) をシートへ持ち込んではならない —
panel 高が浅い landscape 帯 (例 844x390 で panel 234px) では pinned head
が所有者の viewport を食い潰し、実効スクロール高が 0 になって status の
全操作へ到達不能になる (phase-31 外部レビュー実測)。

### 常時固定される操作

表示条件が成立している間、スクロール位置によらず到達できなければならない。

- header の 接続状態 / 設定 / 起動
- AgentDetail の グリッドへ戻る / 盲点インジケータ (シート展開中は handle 上)
- composer の入力欄と送信 (ソフトウェアキーボード表示中を含む)
- pending な permission / question への応答導線

## Constraints

- 本表の全要素は、表示条件が成立していれば、どのサイズからも到達可能で
  なければならない (MUST)
- 「常時」と記した要素は、表示条件成立中は操作なしで視界になければ
  ならない (MUST)
- ページの主縦スクロール領域を入れ子にしてはならない (MUST NOT)。高さ上限を
  持つ局所スクロールは対象外
- シートは wrapper と content のどちらか一方のみを縦スクロール所有者と
  しなければならない (MUST)
- ソフトウェアキーボード表示中も composer と送信操作が隠れてはならない
  (MUST NOT)
- 新しい UI 要素を追加する際は本表へ行を足さなければならない (MUST)

## Open Questions

なし。

## See Also

- Related specs: [responsive-layout](responsive-layout.md),
  [design](design.md)
- ADRs: [0052-responsive-three-tier-layout](../adr/0052-responsive-three-tier-layout.md),
  [0012-response-display-and-dashboard-scope](../adr/0012-response-display-and-dashboard-scope.md)
- 実装計画: [phase-31-responsive-ui](../plans/phase-31-responsive-ui.md)
