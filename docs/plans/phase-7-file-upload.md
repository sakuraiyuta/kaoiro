---
title: ファイルアップロード(添付の取り込み)
description: ダッシュボードから画像/テキスト/PDF/Office を Claude Code に渡せるようにする — pre-spike + 単一画像 E2E + feature complete MVP の3段階。
status: planned
phase: 7
depends_on: [phase-3.5-response-display, phase-4-host-runner]
last_updated: 2026-06-27
---

# Phase 7 — ファイルアップロード(添付の取り込み)

[file-upload spec](../specs/file-upload.md) と
[ADR-0025](../adr/0025-file-upload-wire-and-wrapper-rendering.md) を実装に
落とす。 3 サブステージ(Stage A → B → C)で進める。

## Stage A — pre-spike(着手前確証)

| 項目 | 目的 | アウトプット |
|--|--|--|
| IN1 | Phoenix V2 binary frame の wire 形式 / phoenix.js ArrayBuffer push API / `max_frame_size` 既定値 | spike ノート(本ファイル下部)、 wire 細部確定(header 形式: u32 vs varint 等) |
| IN2 | Claude API の image_block / document_block 正確な上限 | fit-to-SDK 閾値の確定 |
| IN3 | fit-to-SDK ライブラリ選定(image: sharp 候補 / PDF: pdf-lib 候補 / Office: markitdown CLI 連携) | 採用ライブラリ確定、 ライセンス・依存サイズ確認 |

完了基準: 上記 3 項目の結論を本ファイルの「Spike 結果」に記録、 spec /
ADR-0025 の数値・ wire 細部を必要に応じて更新。

## Stage B — phase-0: 単一画像 end-to-end(最小 demonstrable slice)

最小コードパスで wire / 認可 / 透過 relay / wrapper の pending_uploads /
SDK content blocks 変換 の骨格を実証する。

### IN(含む)

- 画像 1 ファイル / instruction(PNG / JPEG / WebP / GIF、 5 MB 上限・
  Stage A 確証後に数値調整)
- 全 wire op 実装: `attach_open` / `attach_chunk`(binary)/ `attach_close`
  / `instruction` 拡張(`attachment_ids`)/ `attach_rejected` /
  `instruction_rejected`
- wrapper: pending_uploads(純メモリ)、 image → image_block 直送、 reject
  reason は `size_over` / `mime_denied` / `sdk_error` のみ
- server: binary 透過 relay、 operator 認可ガード、 frame 上限(8 MB)、
  in-flight cap(20)
- client: 簡易 file picker(1 枚)、 送信ボタンで upload → instruction、
  reject トースト表示
- E2E 確認: dashboard 1 枚送信 → wrapper の SDK が image_block 受理 →
  ターン応答が出る

### OUT(明示的に外す)

- 複数ファイル、 PDF / text / code / Office
- fit-to-SDK(downsize / page-extract / truncate)
- 128 MB 一律 cap(MVP までの暫定)
- `interrupt` 拡張(uploads drop)
- TTL 5 分 GC
- progress UI / 遅延 upload tray / 複数選択 UX
- reject reason 全 enum

### 層別スライス(順序)

| 順 | 層 | 内容 |
|--|--|--|
| A | docs | spec / ADR / non-goals / 索引(本セッションで完了) |
| B | wrapper | pending_uploads + image → image_block 変換 + reject 発火 |
| C | server | binary 透過 relay + operator 認可 + transport 安全弁 |
| D | client | file picker(1 枚)+ chunker + ArrayBuffer push + reject 表示 |
| 検収 | E2E | dashboard 1 枚送信 → SDK 応答 確認 |

## Stage C — phase-1: feature complete MVP

Stage B の wire を据え置きで機能を全面展開。

### IN(含む)

- 複数ファイル(10 / instruction、 in-flight 20)、 multi-select picker
- 全種別: image + text / code + PDF + Office(docx / xlsx / pptx via
  markitdown 連携)
- 128 MB 一律上限(個別)、 合計 cap なし
- wrapper の fit-to-SDK:
  - 画像 = API 上限超は downsize、 不能は `unfittable_image` reject
  - PDF = 上限超は先頭 N ページ抽出 or `unfittable_pdf` reject
  - text/code = 1 MB 超は `truncated` 印付き切り詰め
  - Office = markitdown → text 経路へ
- reject reason 全 enum(`size_over` / `mime_denied` / `count_over` /
  `timeout` / `interrupted` / `unfittable_image` / `unfittable_pdf` /
  `text_too_large` / `sdk_error`)
- `interrupt` 拡張: pending_uploads drop + staged attachment drop +
  `attach_rejected{reason="interrupted"}` 発火
- TTL 5 分 GC(未参照 + chunk 不完全 upload)
- per-upload progress UI
- 遅延 upload tray UX(✕ で除去可)

### OUT(Followups 候補)

- Q1 ([file-upload-fs-read-fallback](../open-questions/file-upload-fs-read-fallback.md)):
  (1) でメモリ/速度に問題が出たら切替判断
- Q2 ([file-upload-capability-publish](../open-questions/file-upload-capability-publish.md)):
  client UX 改善が欲しくなったら
- Q3 ([file-upload-json-fallback](../open-questions/file-upload-json-fallback.md)):
  simple-client 要望が出たら
- Q5 ([file-upload-spill-storage](../open-questions/file-upload-spill-storage.md)):
  並列 upload で RSS が問題化したら
- Q6 ([file-upload-exif-stripping](../open-questions/file-upload-exif-stripping.md)):
  機微画像運用が出たら
- Q8 ([file-upload-name-collision](../open-questions/file-upload-name-collision.md)):
  client disambiguate 要望が出たら

### 層別スライス

Stage B と同じ A→B→C→D の順、 機能を漸進的に追加。 1 機能 1 PR を目安に
小スライスで進める。

## Spike 結果(Stage A 完了時に追記)

(空欄、 Stage A 完了時に埋める)

## Followups

各 OQ の起票判断: Stage C 完了時にユーザと確認、 必要分のみ個別 issue 化。
