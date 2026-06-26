---
title: 複数 wrapper エンジンの spawn 時選択
description: capabilities を起点に LaunchDialog / SpawnMessage / server spawn / runner launcher を engine 対応へ配線する未決の論点。model/effort・persona もエンジン依存になる。
status: open
urgency: low
blocks: []
opened: 2026-06-26
decided: null
---

## 背景

[ADR-0017](../adr/0017-wrapper-multientity-packages.md) は wrapper を
`claude-code` / `codex` 等のアダプタへ分割する構造を、
[ADR-0023](../adr/0023-host-runner-architecture.md) は「当面 Claude Code CLI 版
のみ、将来 codex 版」「リネームは codex 版追加時まで先送り」を規定している。

エンジン種別の足場として `capabilities`(`register` payload、例 `["claude"]`、
[phase-4 plan](../plans/phase-4-host-runner.md) / [protocol](../specs/protocol.md))
は宣言・伝搬・クライアントへの配信(`HostInfo.capabilities`)まで通っている。
しかし**実際の消費が無く**、spawn 経路は単一エンジン前提のまま:

- runner の launcher が `@kaoiro/wrapper`(claude)へハードコード
  (`runner/src/spawn.ts`)。エンジン分岐なし。
- `SpawnMessage`([protocol/index.ts](../specs/protocol.md))にエンジン指定
  フィールドが無い。
- `LaunchDialog`(同梱ダッシュボード)は `capabilities` を未使用
  (host / persona / cwd / name / initial_prompt のみ)。

第二エンジンが実在した時点で、現在の起動ダイアログと spawn 経路では選択しきれない。

## 選択肢

| 論点 | 案 |
|------|-----|
| ダイアログの選択肢ソース | (a) クライアント静的リスト / (b) `capabilities` を host が申告→ダイアログが読む(推奨、足場が既にある) |
| engine フィールドの位置 | `SpawnRequest`(client)→ `SpawnMessage`(server→runner)に `engine`(capability 値)を追加。server は `capabilities` 照合で検証 |
| launcher の解決 | runner で `engine → wrapper パッケージ` を解決(現在のハードコードを置換) |
| 単一エンジン時のUX | `capabilities` が1種なら engine セレクトを出さず現行どおり(後方互換) |

## 影響

第二エンジン追加時に概ね4層へ波及: LaunchDialog / `SpawnRequest`・
`SpawnMessage` / server spawn ハンドラ / runner launcher。加えて
**model/effort([ADR-0020](../adr/0020-dashboard-battery-included-client.md) /
# 54)と persona・スプライトがエンジン依存**になる(codex は Opus/Sonnet を持た
ない等)。論理順は「engine 選択 → その engine の model/effort」。

## 判断材料

- 対象エンジン(codex 等)がまだ存在しない = 選ぶ対象が無い(YAGNI)。
- `capabilities` は既に register→hosts まで配線済みの唯一の足場。再設計ではなく
  「配線するだけ」で拡張できる見込み。
- ADR-0023 が codex 追加までの先送りを明言済み。
- リスク: `capabilities` が「実装済みに見えて不活性」なため、配線箇所を記録しない
  と第二エンジン追加時に取りこぼす。

## 暫定方針

第二エンジン(codex 等)が実在するまで**実装は先送り**。`capabilities` を唯一の
足場として維持し、追加時に上記4層 + model/effort・persona のエンジン依存を一括
配線する。本ファイルがその配線チェックリストを兼ねる。

## 解決時のアクション

- [ ] `SpawnRequest` / `SpawnMessage` に `engine` を追加(server は `capabilities`
      照合で検証)
- [ ] runner launcher を `engine → wrapper パッケージ` 解決へ変更
- [ ] LaunchDialog に engine セレクト(`capabilities` が2種以上のときのみ)
- [ ] model/effort・persona の選択肢を選択エンジン基準に切替
- [ ] ADR へ昇格し、本ファイルを削除
