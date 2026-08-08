---
title: Phase 31 — dashboard の 3 サイズ対等レスポンシブ化 (ADR-0052)
description: timeline track 変更と breakpoint / シート機構の基盤を敷き、lobby / AgentDetail / 周辺 UI を PC / tablet / smartphone の 3 サイズで成立させる。
status: in_progress
phase: 31
depends_on: []
last_updated: 2026-08-09
---

# Phase 31 — dashboard の 3 サイズ対等レスポンシブ化 (ADR-0052)

## Goal

[ADR-0052](../adr/0052-responsive-three-tier-layout.md) を実装する:
dashboard を PC / tablet / smartphone のどの画面サイズでも実用に足る UI に
し、smartphone からでも 確認 / 指示送信 / permission 承認 まで行えるように
する。寸法と規則の正本は
[responsive-layout.md](../specs/responsive-layout.md)、要素ごとの表示条件と
到達経路は [responsive-reachability.md](../specs/responsive-reachability.md)。

本フェーズは 4 段階で進める。段階は本ファイル内の Stage として持ち、
`plans/` のファイルは分割しない。

## Acceptance Criteria

- [ ] responsive-reachability.md の全要素が、表示条件成立時に 3 サイズから
      到達可能 (Tasklist float の行は #188 実装後に適用のため対象外)
- [ ] 「常時」と記された要素が、表示条件成立中はスクロール位置によらず視界にある
- [ ] lobby grid の列が role と timeline 配置に従う (viewer と offline は
      常に `auto-fill`、固定列は timeline 横並び時の operator のみ)
- [ ] smartphone で 確認 / 指示送信 / permission 承認 が行える
- [ ] ソフトウェアキーボード表示中も composer の入力欄と送信操作へ到達できる
- [ ] シート展開中も pending permission / question に気づけ、handle の
      attention バッジから一覧へ戻れる (ADR-0012 F8 の操作を維持)
- [ ] ページの主縦スクロール領域が入れ子にならない。シートは wrapper と
      content のどちらか一方のみが縦スクロール所有者
- [ ] 画面回転で composer の入力途中テキストとログのスクロール位置が保持される
- [ ] PWA standalone 起動時に、header / composer / シート / handle /
      dialog / drawer がセーフエリアを侵さない
- [ ] `short` (高さ 500px 以下) で縦圧縮の override が効き、低背でも
      dialog / drawer / dock が切れない
- [ ] iOS/iPadOS Safari と Android Chrome (Pixel 6a) の実機で確認済み
- [ ] `design.md` のデザイントークンに変更が入っていない

## Tasks

### Stage A — 基盤 + lobby

| # | Task | Owner | Status | Notes |
|---|------|-------|--------|-------|
| 31-1 | timeline track を `22rem` 固定へ変更し、breakpoint トークンを定義 | こはく | ✅ | desktop 1199px / tablet 940px / short 500px。内訳は responsive-layout.md の表が正本。`1rem = 16px` 前提。トークン一覧は `app.css` 冒頭コメント |
| 31-2 | viewport meta に `viewport-fit=cover` を追加し、セーフエリアを織り込む | こはく | ✅ | 対象は header / composer / シート / handle / fixed dialog / drawer。inset は加算でなく floor 扱いで、floor 値は要素ごとの既存 edge padding (`max(<既存 padding>, env(...))`)。本体 inline なら `max(2rem, env(...))` |
| 31-3 | ボトムシート機構の共通コンポーネント化 | こはく | ✅ | 契約 (開閉手段・最大高 60%・単一 scroll owner・フォーカス・breakpoint 跨ぎ・重なり順) は responsive-layout.md が正本。実装は `BottomSheet.svelte` (非シートサイズでは display:contents) |
| 31-4 | lobby (AgentGridShell + ResponseTimeline) の 3 サイズ適用 | こはく | ✅ | smartphone で timeline をシートへ退避。列の固定は operator かつ timeline 横並び時のみ (smartphone 帯は `.three-cols` を auto-fill へ上書き) |

**Stage A 完了判定**: 3 サイズで lobby が成立し timeline へ到達できる /
viewer と offline が `auto-fill` のまま / viewport meta が反映され standalone
でセーフエリアを侵さない / handle がシート化されるサイズでのみ表示される。

### Stage B — AgentDetail

| # | Task | Owner | Status | Notes |
|---|------|-------|--------|-------|
| 31-5 | `.status` のシート化と二重スクロール解消 | こはく | ✅ | tablet 幅以下が対象。シート内は `.status` 自身を単一 scroll owner とし、identity header ごとスクロールさせる (pinned head + `.status-scroll` 分割は landscape 帯で実効高 0 になる — 外部レビュー実測)。desktop は従来どおり `.status-scroll` が owner。sheet panel は `overflow: hidden` の wrapper、portrait は 8rem にキャップ |
| 31-6 | シートと in-flow dock 類の重なり解決、attention バッジの操作化 | こはく | ✅ | バッジは `button.blindspot` と同じ「一覧へ戻す」を実行する (ADR-0052 F3)。handle はコンテナとし、開閉トグルとバッジを兄弟の `button` にする (interactive 要素の入れ子を避ける)。加えて handle に現 agent の pending lamp を出す |

**Stage B 完了判定**: status の全情報・全操作へ到達できる / 二重スクロールが
ない / シート展開中も pending に気づけ、バッジから一覧へ戻れる。

### Stage C — 周辺 UI と short

| # | Task | Owner | Status | Notes |
|---|------|-------|--------|-------|
| 31-7 | header / SettingsDrawer / LaunchDialog / offline 一覧の 3 サイズ対応 | こはく | ✅ | smartphone ではログアウトを SettingsDrawer へ移した (drawer 側の行は全サイズで表示、header 側を CSS で隠す — DOM 共通維持)。層尺度は backdrop 40 / panel 41 に共通化 (`app.css` の z-index scale コメント) |
| 31-8 | `short` の縦圧縮 override を適用 | こはく | ✅ | header の縦 padding / composer の初期高 (1 行、focus で拡張) / dock 類の高さ上限 45% + 内部スクロール (permission dock は question dock と同じ shell+scroll 構造へ変更) / dialog・drawer の `max-block-size` と scroll owner。横方向のレイアウト・シート最大高・dock の展開状態は変更しない。`main` の block padding は 0.5rem/2.6rem へ縮退 (bottom は handle の逃げ幅を確保) |

**Stage C 完了判定**: header / drawer / dialog / offline の挙動が
responsive-reachability.md の表と一致する / 低背で dialog・drawer・dock が
切れず内部スクロールする / 高さ 390px で、展開状態の permission dock と選択肢の
多い question dock、1 行 composer、handle が共存し、ログの表示高が 0 にならず
スクロールできる / dock の最小化操作と composer の送信が handle に覆われない。

### Stage D — 検証

| # | Task | Owner | Status | Notes |
|---|------|-------|--------|-------|
| 31-9 | 実機確認 (iOS/iPadOS Safari + Android Chrome) | | ⏳ | Android は Pixel 6a。ソフトウェアキーボード表示中の composer 到達を必ず確認する。[#208](https://gitea.example.invalid/sakurai.yuta/kaoiro/issues/208) |
| 31-10 | Playwright による viewport 回帰の固定 | こはく | ✅ | 下記シナリオ。`dashboard/e2e/` (fixture ハーネス + `pnpm exec playwright test`、Phoenix 不要)。T1-T10 + landscape 到達回帰の 26 テスト green |

**テストシナリオ** (31-10)。軸の直積ではなく、成立する組のみを列挙する。

| # | シナリオ | 固定する内容 |
|---|---|---|
| T1 | operator / lobby / 939 と 940 | timeline が sheet ⇔ 横並びで切り替わり、grid の列が追随する |
| T2 | operator / lobby / 1198 と 1199 | 2 列 ⇔ 3 列が切り替わり tile が 240px を下回らない |
| T3 | viewer / lobby / 全帯 | 常に `auto-fill` で timeline も handle も出ない |
| T4 | operator / detail / 1198 と 1199 | status が sheet ⇔ sidebar で切り替わる (tablet 以下は常に sheet) |
| T5 | operator / detail / sheet open | 背景がスクロールせず、scroll owner が 1 つ |
| T6 | operator / detail / permission 到着 (sheet open / closed) | 応答導線へ到達できる |
| T7 | operator / detail / question 到着 (sheet open / closed) | 同上 |
| T8 | operator / detail / 他エージェント要対応 + sheet open | handle バッジから一覧へ戻れる |
| T9 | 高さ 500 と 501 | header 縦 padding / composer 初期高 / dock 高さ上限 / dialog・drawer の `max-block-size` が切り替わる (シート最大高と横レイアウトは不変) |
| T10 | 低背 + dialog / drawer 展開 | 上下が切れず内部スクロールする |

Status legend: ✅ done, 🟡 mostly done, ⚠ partial, ⏳ not started, ⛔ blocked.

## Followups (in-phase but unfinished)

- Tasklist float の狭幅挙動は当面 desktop と同一 (ADR-0052 F4 の暫定決定)。
  [#188](https://gitea.example.invalid/sakurai.yuta/kaoiro/issues/188) が
  未実装のため本フェーズの検収対象外。実装後に実挙動を見て見直す
- timeline track を `22rem` 固定にしたことで広い画面の表示密度が下がる。
  実運用で不足を感じた場合、desktop 帯の上端でのみ上限を戻す案を検討する
- breakpoint を px で持つため、ブラウザの既定フォントサイズ変更に追随しない。
  破綻が観測されたら rem 表記へ移す

## Open Questions Blocking This Phase

なし。

## See Also

- Specs covered: [responsive-layout](../specs/responsive-layout.md),
  [responsive-reachability](../specs/responsive-reachability.md),
  [design](../specs/design.md)
- ADR: [0052-responsive-three-tier-layout](../adr/0052-responsive-three-tier-layout.md)
- 実装 issue: [#207](https://gitea.example.invalid/sakurai.yuta/kaoiro/issues/207)
  (Stage A-C + 31-10 Playwright)
- 実機検証 issue: [#208](https://gitea.example.invalid/sakurai.yuta/kaoiro/issues/208)
  (Stage D 31-9、運用者作業)
- Previous phase: [phase-30-history-restart-resilience](phase-30-history-restart-resilience.md)
