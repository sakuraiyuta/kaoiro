---
title: ファイルアップロードの wire と wrapper-internal レンダリング
status: accepted
date: 2026-06-27
opened: 2026-06-27
supersedes: []
superseded_by: null
related_specs: [file-upload, protocol, non-goals]
related_adrs: [9, 15, 20, 21, 34]
---

# ADR-0025 — ファイルアップロードの wire と wrapper-internal レンダリング

## Status

Accepted

## Context

[ADR-0020](0020-dashboard-battery-included-client.md)(battery-included)が
許容した「新たな公開プロトコル面の追加」枠で、 ダッシュボードからの
ファイル添付(画像 / テキスト / PDF / Office)を Claude Code に渡せる機構を
導入する。 #52 issue 本文は 4 つの意思決定点を残しており、
my-spec-elicitation で 14 件の F 決定として確定した。

設計の中心問:

1. レンダリング(SDK の content block 選択・ Office 変換)の責任を
   どの層に置くか?
2. ファイル bytes をどのように client → server → wrapper に運ぶか?
3. wrapper はバイト列をどこに保持するか?
4. ファイルの上限・ MIME 規範 / 弾く場所 / reject 通知経路は?
5. cancel / interrupt のセマンティクスは?

## Decision

### F1: rendering は wrapper-internal

client / server は type-agnostic、 protocol に Anthropic API 用語
(image_block / document_block / text_block 等)を出さない。 wrapper が
SDK と active model を知る唯一の層であり、 ここでレンダリング種別を決める。

rejected:

| | 理由 |
|--|--|
| client がレンダリング種別を決める | 「状態導出は wrapper、 server は agent 非依存」MUST(architecture.md)に反する。 client にモデル知識が必要 |
| server がレンダリングを決める | server agent 非依存原則違反 |

### F2: 転送 wire = (c)+(d) ハイブリッド

`attach_open` / `attach_chunk`(binary)/ `attach_close` / `instruction` 拡張
(`attachment_ids` 参照)の 4 op 構成。 wire 詳細は
[file-upload](../specs/file-upload.md) / [protocol](../specs/protocol.md)。

rejected:

| 案 | 理由 |
|--|--|
| (a) `instruction` 同梱 | text-only モデルが汚れる / 1 フレーム上限到達 / リトライ粒度粗い / 第三者クライアントへの間口狭い |
| (b) `instruction_with_attachments` 新 event 同梱 | (a) と同じ frame サイズ問題、 メリット小 |
| (d) 単独 binary frame 直送 | id 参照なしでは instruction との突合が脆い |
| 別 socket / HTTP POST upload | ADR-0009 一本化を侵食 |

### F3: wrapper の assembly buffer = 純メモリ完結

`pending_uploads` は wrapper 内のメモリのみ。 ディスク不到達。

rejected: spill-to-temp-FS / 常時 temp FS — MVP 不要、 ディスク到達原則違反。
OQ5 で将来余地。

#### #112 追補 (2026-07-23、マスター承認): Codex `local_image` 限定例外

Codex SDK 0.144.1 の画像入力は bytes / base64 ではなく path を受け取る
`local_image` block だけである。このため Codex wrapper に限り、**画像のみ**を
instruction 受理後に wrapper-private temp directory へ materialize して SDK に渡す。
directory は `mkdtemp` (0700)、file は 0600、prefix に `agent_id` を含め、自分の
orphan だけを次回起動時に sweep する。`image/*` の形式細別 allow-list は持たず、
SDK が不受理なら既存 turn error 経路で表面化する。上限は F4 の一律 128 MB をその
まま適用し、種別別 cap を導入しない。

成功・失敗・interrupt を含む turn 完了時に file と directory を必ず削除する。
cleanup 失敗は stderr warn で loud に残し、次回起動時の prefix-scoped sweep で回収する。
F11 の interrupt drop semantics にはこの temp file cleanup も含む。これは SDK が
path 入力しか受理しないこと、会話内容自体は SDK rollout により既に disk 永続される
ことを踏まえた限定的な受容判断であり、マスターが 2026-07-23 に承認した。

### F4: 個別ファイル上限 = 一律 128 MB

UI スクショ・ デザインデータ・ 大物論文等の多種多様な入力を「リソース
ぎりぎりまで」受け止める。 SDK の硬い上限とのギャップは F10 (fit-to-SDK)
が吸収する。

rejected: 種別ごと上限(image 5MB / PDF 32MB / text 1MB / Office 10MB)—
API 上限の事務的写しでユーザ意図と不整合。

### F5: 1 instruction 合計サイズ cap = 撤廃

wrapper の fit-to-SDK と RSS が事実上の上限。

rejected: 512 MB 等の数値 cap — F8 (A4-α)と矛盾、 wrapper 一元化を侵食。

### F6: 点数 / in-flight cap

- 添付 10 / instruction
- in-flight 20 / wrapper

rejected: 無制限 — DoS 防衛と UX 上の妥当な範囲を設けない。

### F7: MIME 許可リスト

詳細は [file-upload spec](../specs/file-upload.md) を参照。

rejected: 圧縮(zip/tar)/ 旧 Office(.doc/.xls/.ppt)/ 動画音声 /
実行ファイル系 — 攻撃面増 / SDK 非対応 / 用途なし。

### F8: 弾く場所

| 層 | 役割 |
|--|--|
| client | 規範を持たない(任意で UX hint) |
| server | transport DoS 防衛(frame 8 MB + in-flight cap 20 + operator 認可) |
| wrapper | 規範最終判定(F4-F7)+ fit-to-SDK |

rejected: client 側 pre-block(`ext.capabilities` publish)— wrapper 知識
との重複、 wrapper 一元化を侵食。 OQ2 で将来余地。

### F9: reject 経路 = 新 envelope type 2 個

- `attach_rejected { upload_id, reason, detail? }`
- `instruction_rejected { attachment_ids?, reason, detail? }`

reason enum は [file-upload spec](../specs/file-upload.md) を正本とする。
両 envelope は operator 限定配信
([ADR-0021](0021-role-information-disclosure-policy.md))。

rejected:

| | 理由 |
|--|--|
| 既存 `result.is_error` に乗せる | 「ターン完了時のエラー」の意味論を保つため流用しない |
| push 同期 reply で返す | 現状 kaoiro は fire-and-forget 主体、 server 素通し設計と整合しない |

### F10: wrapper の fit-to-SDK 責任

128 MB の protocol 上限と SDK の硬い上限(image 10 MB / PDF 32 MB /
**リクエスト合計 32 MB がハード上限**、 Phase 7 Stage A spike 結果)の
ギャップを吸収する best-effort:

- 画像 downsize: **sharp**(`ImageDownsizer` 抽象経由、 ADR-0018 対応時に
  sharp-wasm32 / jimp に差替え可能)
- PDF page-extract: **pdf-lib**(pure JS)
- text truncate: 自前 + `@anthropic-ai/sdk` の `countTokens` で context
  window 検証
- Office → text: **officeparser**(pure JS、 docx/xlsx/pptx 1 lib)、
  markitdown CLI は Q10([file-upload-markitdown-fallback](../open-questions/file-upload-markitdown-fallback.md))で
  fallback 余地

合計 32 MB 超は `instruction_rejected{reason="total_request_over"}` で
拒否。 個別不能は F9 の専用 reason(`unfittable_image` / `unfittable_pdf` /
`text_too_large`)で reject。 表詳細は
[file-upload](../specs/file-upload.md) を参照。

>32 MB 単独ファイルの実用は Files API 経路(`file_id` 参照)で実現可能
(1 file 500 MB まで)。 採用判断は Q9
([file-upload-files-api-route](../open-questions/file-upload-files-api-route.md))。

rejected: 「SDK が reject したらそのまま返す」のみ — 128 MB cap と SDK
小上限のギャップで UX 破綻。

### F11: `interrupt` の意味拡張

既存 `interrupt` が次も担う:

- 当該 agent の pending_uploads 全 drop
- 直前 instruction が SDK 内処理中なら staged attachment bytes drop
- drop した upload_id ごとに `attach_rejected{reason="interrupted"}` を発火
- turn 進行中でなくとも uploads があれば作動
- uploads / staged が無ければ従来通り(前方互換維持)

rejected: 別 op `attach_cancel` 追加 — `interrupt` 拡張で必要なくなった。

### F12: UI モデル = 遅延 upload

protocol 不変の client 規範。 詳細は file-upload spec を参照。

rejected: 即時 upload(picker 選択 = 即転送)— 取り消しでの帯域浪費、
TTL 依存。

### F13: TTL = 5 分

`pending_uploads` の未参照・ 不完全エントリを 5 分で破棄。 explicit cancel
は F11、 TTL は fail-safe。

rejected: TTL なし — メモリ leak リスク。

### F14: チャンクサイズ・並列度 = 推奨値のみ

MVP: 1 chunk 64 KB、 並列度 client 任意。 「間口を広げる」路線で MUST に
しない。

## Consequences

### Positive

- ダッシュボードからの添付が dogfooding 可能になる(ADR-0020 の意図実現)。
- protocol が wire 中立(API 用語非依存)で第三者クライアント実装の間口が広い。
- server 素通し原則と Channels 一本化を維持
  ([ADR-0009](0009-client-transport.md) / ADR-0020 F3)。
- 失敗時の reject が新 envelope で明示され、 既存 result のセマンティクスを汚さない。
- 128 MB の寛容な上限で多種多様なファイル(スクショ / デザイン / 大物論文)に対応。
- wrapper を per-engine 翻訳層とする「kaoiro の MUST」を強化(architecture.md)。

### Negative

- 公開プロトコル面が 4 op + envelope 2 種類増える(ADR-0020 が許容)。
- wrapper の責任が増える(pending_uploads / fit-to-SDK / Office 変換)。
- 実装着手前に Phoenix V2 binary frame と phoenix.js ArrayBuffer push API の
  spike が必須(plan Stage A 参照)。

### Neutral

- 大ファイル送信は client の chunker と server frame 上限調整(8 MB 既定)に依存。
- fit-to-SDK の細部(downsize アルゴリズム / page-extract 戦略)は実装で決まる。

## Alternatives Considered

詳細は各 F の rejected 行に集約。 主な分岐:

- レンダリング層分散 vs 集中 — F1 で集中(wrapper)を採用
- transport 設計(同梱 / 分離 / バイナリ)— F2 で hybrid 採用
- バッファ置き場(memory / FS)— F3 でメモリ採用
- 上限ポリシー(種別ごと / 一律)— F4 で一律採用、 F10 で fit-to-SDK 補完
- 拒否経路(既存 result 流用 / 新 envelope)— F9 で新 envelope 採用
- cancel UX(別 op / interrupt 拡張)— F11 で拡張採用

## Followups

| OQ | スラグ |
|--|--|
| Q1 | [file-upload-fs-read-fallback](../open-questions/file-upload-fs-read-fallback.md) |
| Q2 | 解決済 — [ADR-0034](0034-session-capabilities-advertisement.md) F7 |
| Q3 | [file-upload-json-fallback](../open-questions/file-upload-json-fallback.md) |
| Q5 | [file-upload-spill-storage](../open-questions/file-upload-spill-storage.md) |
| Q6 | [file-upload-exif-stripping](../open-questions/file-upload-exif-stripping.md) |
| Q8 | [file-upload-name-collision](../open-questions/file-upload-name-collision.md) |
| Q9 | [file-upload-files-api-route](../open-questions/file-upload-files-api-route.md) |
| Q10 | [file-upload-markitdown-fallback](../open-questions/file-upload-markitdown-fallback.md) |

Phase 7 Stage A spike 完了(plan の「Spike 結果」セクション参照): Phoenix
V2 binary serializer 仕様 / phoenix.js ArrayBuffer push API 確証、 Claude
API 上限値確定(image 10 MB / PDF 32 MB / リクエスト 32 MB)、 fit-to-SDK
ライブラリ採用確定(sharp / pdf-lib / officeparser / Anthropic SDK
`countTokens`)。 `max_frame_size` は既定 `:infinity` のため運用設定で
8 MB 程度に明示する必要あり(spec 反映済)。

## Related

- specs: [file-upload](../specs/file-upload.md)(本仕様の集約)、
  [protocol](../specs/protocol.md)(wire 詳細)、
  [non-goals](../specs/non-goals.md)(AV スキャン非対応)
- 関連 ADR:
  [0009](0009-client-transport.md)(Channels 一本化、 F2 で維持)、
  [0015](0015-protocol-version-stamping.md)(version 規約、 追補は version 据え置き)、
  [0020](0020-dashboard-battery-included-client.md)(本決定の上位枠 F2 / F3)、
  [0021](0021-role-information-disclosure-policy.md)(配信ポリシ、 attach_* は operator 限定)
- 由来: my-spec-elicitation(#52)
