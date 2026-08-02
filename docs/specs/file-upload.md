---
title: ファイルアップロード(添付の取り込み)
description: ダッシュボードからの添付(画像/テキスト/PDF/Office)を wrapper で SDK 用 content blocks へレンダリングして operator が agent に渡す共通仕様。
status: provisional
related: [protocol, architecture, non-goals, threat-model]
---

# ファイルアップロード(添付の取り込み)

## Purpose

operator がダッシュボードから添付ファイルを agent(初期は Claude Code /
Claude Agent SDK)に渡せる機構を定義する。 wire の細部は
[protocol](protocol.md)、 決定の根拠は
[ADR-0025](../adr/0025-file-upload-wire-and-wrapper-rendering.md)。

## Definition

### 用語

| 用語 | 意味 |
|--|--|
| upload | 1 ファイルの転送単位。 `upload_id`(client 採番、 セッション内一意)で識別 |
| chunk | 1 binary frame で運ぶ upload の部分。 サイズ・並列度は client 任意 |
| pending_uploads | wrapper 内のメモリバッファ。 chunk を組み立てた bytes を保持 |
| attachment | instruction が `attachment_ids` で参照する組み立て済 upload |
| fit-to-SDK | wrapper が SDK の硬い上限に合わせて downsize / page-extract / truncate / 変換する best-effort 処理 |

### 責務分担

| 層 | 責任 |
|--|--|
| client(ダッシュボード) | file picker + chunker + ArrayBuffer push。 規範を持たない(UX hint は任意) |
| server(Phoenix) | 透過 relay + transport DoS 防衛(frame 上限・ in-flight cap)+ operator 認可。 envelope と attach_* を解釈しない(agent 非依存) |
| wrapper(per-engine) | pending_uploads 管理 / 規範最終判定 / fit-to-SDK / SDK content blocks への変換 / reject 通知。 rendering は wrapper-internal |

### 対応ファイル種別 / MIME

| 系統 | 許可 |
|--|--|
| 画像 | `image/png`, `image/jpeg`, `image/webp`, `image/gif` |
| テキスト | `text/plain`, `text/markdown`, `text/*`(UTF-8 限定)、 `application/json`, `application/xml`, 主要なソースコード MIME |
| PDF | `application/pdf` |
| Office | OOXML のみ: docx(`application/vnd.openxmlformats-officedocument.wordprocessingml.document`)/ xlsx(`…spreadsheetml.sheet`)/ pptx(`…presentationml.presentation`) |
| 拒否 | 圧縮(zip/tar)、 旧 Office(.doc/.xls/.ppt)、 動画/音声、 実行ファイル系 |

非対応 MIME を受信した wrapper は `attach_rejected{reason="mime_denied"}` を返す。

### サイズ・点数・in-flight 上限

| 項目 | 値 | 担当 |
|--|--|--|
| 個別ファイル上限 | **一律 128 MB** | wrapper |
| 1 instruction 合計サイズ | **撤廃**(wrapper の fit-to-SDK と RSS が事実上の上限) | — |
| 1 instruction 点数 | 10 | wrapper |
| in-flight upload | 20 / wrapper | wrapper |
| transport frame 上限 | 8 MB | server |
| TTL(未参照 upload / chunk 不完全) | 5 分 | wrapper |

### 転送 wire

wire 詳細は [protocol](protocol.md) の「方向別メッセージ種別」と
「ファイルアップロード wire」セクションを参照。 概要:

- `attach_open`(text/JSON、 client → server → wrapper)で upload を予告。
- `attach_chunk`(binary frame、 同方向)で bytes を chunked 転送。 並列可。
- `attach_close`(text/JSON、 同方向)で 1 upload の完了通知。
- `instruction` を拡張 `{ agent_id, text, attachment_ids? }` で id 参照。

server はバイト列を解釈・永続せず agent channel に透過 relay する
(ディスク不到達、 [ADR-0020](../adr/0020-dashboard-battery-included-client.md) F3)。

### wrapper-internal rendering

wrapper は active SDK と active model を知っているので、 各 attachment を
最適な SDK content block に変換する。 protocol / client / server には
Anthropic API 用語(image_block / document_block / text_block 等)は
出さない。

Claude Agent SDK の場合:

| 種別 | render 先 |
|--|--|
| 画像 | `image` content block |
| text / code | `text` content block(本文インライン) |
| PDF | `document` content block |
| Office | wrapper 内 officeparser(pure JS、docx/xlsx/pptx)でテキスト化 → `text` block |

上表は Claude Code アダプタ(`wrapper/claude-code/src/upload.ts`)の
ポリシー。engine ごとに wrapper が独自ポリシーを持つ設計で、**Codex
アダプタ(`wrapper/codex/src/upload.ts`)は画像のみ受け付ける** —
`ext.session_capabilities` に `attachment_types: ["image"]` を advertise し、
UI 側の picker / paste / drop もそれに合わせて画像へ絞る
([plugin-model](plugin-model.md))。protocol 上限(128 MB / in-flight 20 /
TTL 5 分)は両 engine で共通。

### fit-to-SDK

128 MB の protocol 上限(client → server → wrapper)と Claude API の SDK
実効上限のギャップは wrapper が吸収する。 Phase 7 Stage A の spike(IN2)で
判明した SDK 上限:

- 画像 content block: **10 MB(base64 後、 生 ~7.5 MB)** / モデル別
  visual token 上限(8000 px 長辺 / 1568-2576 px の長辺で自動 downscale)
- document content block(PDF): **32 MB / 600 ページ**(200K context モデルは
  100 ページ)
- text content block: byte 上限なし(モデルの context window 依存)
- **リクエスト合計: 32 MB がハード上限**(全 attachment の base64 後合計)
- 現行 active Claude モデル(Fable 5 / Mythos 5 / Opus 4.x / Sonnet 4.6 /
  Haiku 4.5)はすべて image / document 対応

| 種別 | fit | 失敗時 reject reason | 採用ライブラリ |
|--|--|--|--|
| 画像 | 解像度 / 品質 downsize → 10 MB / モデル別 px 上限 以内 | `unfittable_image` | sharp(`ImageDownsizer` 抽象経由、 ADR-0018 対応時に sharp-wasm32 / jimp へ差替え可能) |
| PDF | 先頭 N ページ抽出 → 32 MB / モデル別ページ上限 以内 | `unfittable_pdf` | pdf-lib(pure JS) |
| text / code | 先頭 N MB 切り詰め(`truncated` 印付き)+ Anthropic SDK の `countTokens` で context window 検証 | `text_too_large` | 自前 + `@anthropic-ai/sdk` `countTokens` |
| Office (docx/xlsx/pptx) | text に変換 → text 同様 | 同上 | officeparser(pure JS、 markitdown は OQ で fallback 余地) |

**zip bomb ガード**: OOXML は zip コンテナなので、圧縮サイズが 128 MB 制限を
通っても展開後に爆発しうる。wrapper は entry の**展開後合計**が
`OFFICE_MAX_UNCOMPRESSED_BYTES`(64 MB)を超えた時点で変換を打ち切り、
呼出元へ bomb として報告する(`wrapper/claude-code/src/upload.ts`)。

wrapper は instruction 着信時に **全 attachment の base64 後合計サイズを
事前検証**し、 32 MB を超える場合は
`instruction_rejected{reason="total_request_over"}` で拒否する。
個別 fit 後でも合計が超える場合に発火。 32 MB 超を扱う運用要求が出たら
Files API 経路(`file_id` 参照)を OQ で起票する。

### reject 経路

wrapper の判定で受理不能な場合、 専用 envelope type で通知する:

| envelope `type` | payload | 用途 |
|--|--|--|
| `attach_rejected` | `{ upload_id, reason, detail? }` | 個別 upload 拒否(attach_close 時の検査) |
| `instruction_rejected` | `{ attachment_ids?, reason, detail? }` | instruction 全体拒否(SDK エラー等) |

reason enum: `size_over` / `mime_denied` / `count_over` / `timeout` /
`interrupted` / `unfittable_image` / `unfittable_pdf` / `text_too_large` /
`total_request_over` / `sdk_error`。

既存 `result.is_error` は「ターン完了時のエラー」の意味論を保つため
流用しない。 両 envelope は operator 限定配信
([ADR-0021](../adr/0021-role-information-disclosure-policy.md))。

### `interrupt` の意味拡張

既存 `interrupt` op が次も担う:

- 当該 agent の **pending_uploads を全 drop**(中継中 chunk 含む)
- 直前 instruction が SDK 内処理中なら **staged attachment bytes を drop**
- drop した upload_id ごとに `attach_rejected{reason="interrupted"}` を発火
- turn 進行中でなくとも uploads があれば作動(従来の no-op 条件が緩む)
- uploads / staged が無ければ従来通り(前方互換維持)

### UI モデル(遅延 upload)

protocol 不変の client 規範:

1. **添付ボタン または D&D drop zone** → file picker / ドロップで取得した
   ファイルは client local の "to-send tray" に **参照だけ**保持
   (bytes 転送なし)。 drop zone は agent 単位(例: AgentDetail の
   チャットボックス領域)に限定し、 複数 agent 間で曖昧にならないようにする。
2. tray から ✕ で除去可(client local の話、 protocol 関与なし)。
3. 送信ボタン押下 → `attach_open` × N → `attach_chunk*` → `attach_close`
   × N → `instruction(attachment_ids=[...])` の順で転送。

picker / D&D 取得時の即時 upload は非採用(送信前取り消しでの帯域浪費・
TTL 依存を回避)。

### TTL と fail-safe

wrapper の `pending_uploads` は **5 分**で未参照のものを破棄する。
explicit cancel は `interrupt`(上記)で出る。 TTL は client 障害 /
instruction 不発時の fail-safe。

## Constraints

- MUST: rendering(image_block / document_block / text_block 選択・
  Office 変換)は **wrapper-internal**。 protocol / client / server は
  Anthropic API 用語を持たない。
- MUST: server はバイト列を解釈・永続しない(agent 非依存・
  [ADR-0020](../adr/0020-dashboard-battery-included-client.md) F3)。
- MUST: `attach_open` / `attach_chunk` / `attach_close` / `attach_rejected`
  / `instruction_rejected` は **operator 限定配信**
  ([ADR-0021](../adr/0021-role-information-disclosure-policy.md))。
- MUST: transport は [Phoenix Channels 一本化](../adr/0009-client-transport.md)
  維持(別 socket / HTTP POST upload を立てない)。
- MUST: protocol `version` 据え置きで追補
  ([ADR-0015](../adr/0015-protocol-version-stamping.md))、 受信側は未知
  キーを無視する。
- MUST: `interrupt` 拡張は前方互換(uploads / staged 不在時は従来挙動)。
- SHOULD: client は規範を持たず、 reject はすべて wrapper の判定に従う
  (UX hint は任意)。

## Open Questions

| ID | スラグ | urgency |
|--|--|--|
| Q1 | [file-upload-fs-read-fallback](../open-questions/file-upload-fs-read-fallback.md) | low |
| Q2 | 解決済 — [ADR-0034](../adr/0034-session-capabilities-advertisement.md) F7 へ畳んだ(受理可種別は `ext.session_capabilities` で publish する) | — |
| Q3 | [file-upload-json-fallback](../open-questions/file-upload-json-fallback.md) | low |
| Q5 | [file-upload-spill-storage](../open-questions/file-upload-spill-storage.md) | low |
| Q6 | [file-upload-exif-stripping](../open-questions/file-upload-exif-stripping.md) | low |
| Q8 | [file-upload-name-collision](../open-questions/file-upload-name-collision.md) | low |
| Q9 | [file-upload-files-api-route](../open-questions/file-upload-files-api-route.md) | low |
| Q10 | [file-upload-markitdown-fallback](../open-questions/file-upload-markitdown-fallback.md) | low |

## See Also

- 関連 specs: [protocol](protocol.md),
  [architecture](architecture.md), [non-goals](non-goals.md),
  [threat-model](threat-model.md)
- ADRs:
  [0009](../adr/0009-client-transport.md)(Channels 一本化),
  [0015](../adr/0015-protocol-version-stamping.md)(version 規約),
  [0020](../adr/0020-dashboard-battery-included-client.md)(battery-included),
  [0021](../adr/0021-role-information-disclosure-policy.md)(配信ポリシ),
  [0025](../adr/0025-file-upload-wire-and-wrapper-rendering.md)(本仕様の決定根拠)
