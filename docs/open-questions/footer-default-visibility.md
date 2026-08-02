---
title: 既定フッター文面の実物をどう運用者に見せるか
description: 内蔵デフォルトを採る (ADR-0045 F1) 結果、運用者は既定文面の実物をリポジトリ上で見られない。上書き前に中身を確認する経路を決める。
status: open
urgency: medium
blocks: [persona-personality-injection]
opened: 2026-08-02
decided: null
---

## 背景

[ADR-0045](../adr/0045-footer-file-externalization.md) F1 は「内蔵
デフォルト + ファイル優先」を採った。`system-footer.md` を置けば内蔵版
を完全に置き換えるが、置くまで運用者は**既定文面の実物を手元で見られ
ない**。上書きは全エージェントの system prompt を書き換える操作なので、
「今は何が入っているか」を確認できないまま編集させるのは筋が悪い。

## 選択肢

| 案 | 内容 | メリット | デメリット |
|----|------|----------|-----------|
| A | `system-footer.md.example` を配布物に含める | ファイルをコピーして編集するだけ。他の `.example` 慣習 (`server/.env.example`) と揃う | 内蔵版と example の二重管理。同期が切れると誤解を生む |
| B | docs 側に全文を掲載し、ファイルは配らない | 単一の掲載場所。docs の drift check に載る | コピー元が md 本文中のコードブロックになり、そのまま貼ると整形崩れが起きうる |
| C | `mix` タスクで現在の既定文面をダンプ | 常に実物と一致する (内蔵版そのものを出力) | 実行環境が要る。コンテナ運用だと `docker exec` 前提になる |

## 影響

ADR-0045 の実装範囲(配布物に何を含めるか)と、運用者向けドキュメント
の書き方に波及する。機構本体の実装は本件と独立に進められる。

## 判断材料

- 内蔵デフォルトの物理的な置き場所(モジュール属性のまま / `priv/` の
  md を `@external_resource` で読む)。後者なら案 A の二重管理は消える
- [coordination-footer-scope](coordination-footer-scope.md) の決着後、
  既定文面がどの程度の頻度で更新されるか

## 暫定方針

なし(未決)。内蔵デフォルトを `priv/` の md として持つ実装を採るなら、
その同一ファイルを `.example` として配る案 A が自然。

## 解決時のアクション

- [ ] 提示方法を確定し、ADR-0045 の Consequences (Neutral) を更新する
- [ ] `docs/specs/persona-personality-injection.md` に手順を追記する
- [ ] 本 open-question を close (削除)
