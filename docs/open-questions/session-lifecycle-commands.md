---
title: /new・/clear の session lifecycle コマンド対応 (仮 D9)
description: kaoiro Composer から /new・/clear を送ると通常のユーザメッセージ
  として engine へ素通しされ、会話コンテキストも task/session ID も切り替わら
  ない。表示履歴・コンテキスト・session の切替を kaoiro の第一級操作として
  設計する。マスター依頼 (2026-07-11、もも経由)。
status: open
urgency: medium
blocks: []
opened: 2026-07-12
decided: null
---

## 背景

- kaoiro の Composer に slash command 処理は存在しない (`server/assets/src`
  を 2026-07-12 に grep 確認、`/new`・`/clear`・`startsWith("/")` いずれも
  該当なし)。`/new` は user_message として wrapper → engine へ渡り、Codex
  では `codex exec` の 1 ターン入力として扱われるだけで、thread ID も会話
  コンテキストも切り替わらない (もも実測、2026-07-11)。
- Codex CLI 本体には `/new` (表示を残して新しい会話/task) と `/clear`
  (表示と会話コンテキストをリセットして新しい task) がある。kaoiro は SDK
  経由 (Claude: `query()` / Codex: `codex exec`) のため、CLI の slash
  command はどの engine でも解釈されない。
- operator が「同じ agent で新しい会話を始める」手段は現状 agent の削除 →
  再 spawn のみで、UX として重い。

## 論点 (マスター指定の検討 6 点)

1. **インターセプト層**: (A) client の Composer で検出し専用 envelope
   (`session_control` 等) を送出 / (B) wrapper が user_message の先頭一致で
   判定 / (C) A を第一級としつつ B を防御的に併設。いずれでも engine への
   素通しは廃止する。
2. **新 session 生成**: Claude = `resume` なしで新規 session 開始、Codex =
   `startThread()`。旧履歴を新 task に混入させない。
3. **UI 表示差**: `/new` = client のログ表示を維持し区切り marker を挿入、
   `/clear` = client 表示もクリア。dashboard の logs store の扱いを含む。
4. **旧 session の resume 可能性**: `SessionPointers` は最新 pointer のみ
   保持 (`agent_id => %{session_id, cwd}`、ADR-0014 F1)。switch 後も旧
   session はディスク上に残り [ADR-0014](../adr/0014-session-resume-and-restore.md)
   F6 の cwd 列挙で発見可能だが、「直前の session に戻る」UX を第一級で
   持つか (pointer 履歴化) は要判断。
5. **共通化 vs capability**: 両 engine 共通の envelope + [ADR-0034](../adr/0034-session-capabilities-advertisement.md)
   の session capability (`supports_session_reset` 等) で advertise する形が
   自然 (F3「engine 名判定禁止」の原則に整合)。
6. **実行中の挙動**: task 実行中にコマンドされた場合、拒否 (busy) /
   interrupt 後適用 / キュー待機のいずれか。

## 選択肢 (phase 位置付け)

| 案 | 内容 | メリット | デメリット |
|----|------|----------|-----------|
| A | 独立 phase-17 として OQ → ADR → plan (phase-16 と同じ流儀) | phase-15/16 を乱さない。envelope + 両 wrapper + client 横断の規模に見合う | phase が 1 本増える |
| B | phase-16 に統合 | Codex session 関連でまとまる | phase-16 は Codex model switch 専用で、D9 は cross-engine。混ぜると focus が濁る |
| C | phase-15 の next scope に D9 として追加 | plan が 1 本で済む | 実装中 phase の mid-flight scope 拡大 (回避方針と矛盾) |

## 影響

- envelope schema 追加 (`@kaoiro/protocol`)、wrapper 両 engine、client
  (Composer / logs store)、server 中継の全層に跨る。ADR 1 本 + 独立 phase
  相当の規模。

## 判断材料

- phase-15 は実装中 (scope 拡大しない方針)、phase-16 は設計確定済で Codex
  model switch 専用。
- operator の利用頻度 (「同じ agent で会話を仕切り直す」需要は日常操作)。

## 暫定方針

**案 A (独立 phase-17) で確定** (マスター決定 2026-07-12)。設計はふじ主導・
もも協働 (director 割当)。ADR 起こしと phase-17 plan 起票をもって本 OQ を
昇格・削除する。実装着手は phase-15 initial 完了後 (phase-16 実装との順序は
その時点でマスターが判断)。

## 解決時のアクション

- [ ] 位置付け決定後、ADR を起こし本 OQ を昇格 (削除)
- [ ] phase plan を起票 (位置付けに応じて)
- [ ] README index から本行を削除
