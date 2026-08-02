---
title: 共通フッターの外部ファイル化 — system-footer.md と user-footer.md
status: accepted
date: 2026-08-03
opened: 2026-08-02
supersedes: []
superseded_by: null
related_specs: [persona-personality-injection, persona-pack-schema]
related_adrs: [29, 44]
---

# ADR-0045 — 共通フッターの外部ファイル化

## Status

Accepted(2026-08-02 起草、2026-08-03 マスター決裁)。
[ADR-0029](0029-persona-server-sot-and-pack-distribution.md)
の F5 / D5 を部分改訂する(supersede はしない)。

起草時は
[#175](https://gitea.example.invalid/sakurai.yuta/kaoiro/issues/175)
([ADR-0044](0044-coordination-injection-hitl.md) の実装)が詰める
フッター**文面**との突き合わせを accept 条件としていたが、文面試行
こそが本 ADR の機構を必要とする相互待ちだったため、決裁で機構と
文面を分離し機構のみ確定して accept した。内蔵デフォルト文面は
現行のまま、協調指針の文面更新は
[coordination-footer-scope](../open-questions/coordination-footer-scope.md)
決着後に別途行う。

## Context

共通フッターは全エージェントの system prompt 末尾に常時載る運用
パラメータでありながら、現在は Elixir のモジュール属性
(`server/lib/kaoiro_server/persona_assets.ex` の `@common_footer`)
にハードコードされている。1 文字の変更にも server の再ビルドと再デプロイ
が要る。

これが実務問題として顕在化しているのが ADR-0044 F1 の文面確定
([coordination-footer-scope](../open-questions/coordination-footer-scope.md))
である。「短い行動原則を試作して不足分を計測する」という自然な進め方が、
1 回の試行ごとにビルドを要求されるため回らない。

一方で人格記述(`personality.md`)は既に pack 内のファイルであり、
運用者が編集できる。共通フッターだけがコード側に取り残されている。

制約が 2 つある。設置ディレクトリは `:ro` でマウントされうるため、
server 側からファイルを書き出す前提の設計は採れない。また persona
設置ディレクトリ自体は pack ingest が `.cache/` を書き込むため、現状
`:ro` を保証できない(`server/docker-compose.yaml` の overlay 例と
矛盾する既存不具合。本 ADR とは独立に別課題で扱う)。footer はこの
問題を避けるため専用 root へ分離する(F1)。

## Decision

### F1: 既定フッターは「内蔵デフォルト + ファイル優先」

既定文面は server バイナリに内蔵し、footer 設置ディレクトリに
`system-footer.md` があれば、その内容で内蔵版を**完全に置き換える**。
ファイルが無い / 空(trim 後空文字列)なら内蔵版を使う(fail-closed
にしない)。

footer 設置ディレクトリは新設 env `KAOIRO_FOOTER_DIR` で指定する。
**未設定ならファイル優先は無効**(内蔵版のみ・user-footer なし)で、
persona 設置ディレクトリ(`KAOIRO_PERSONA_DIR`)には footer を
置かない。分離の理由は 2 つ — pack ingest の `.cache/` 書き込みで
persona dir は `:ro` を保証できないこと、既定の pack dir が repo
追跡下にあり運用ファイルが git / docker build context へ混入し得る
こと。container では `./footers:/etc/kaoiro/footers:ro` のような
`:ro` mount を想定する。env/path の変更は server 再起動で反映する
(watcher の監視 root は起動時固定)。

内蔵デフォルトの物理実体はモジュール属性ではなく
`server/priv/footers/system-footer.md`(build source。release の
`priv/` にも同梱される)に置き、`@external_resource` で再コンパイル
追跡した上でコンパイル時に `File.read!` で取り込む。運用者は
リポジトリまたは release 同梱のこのファイルを閲覧して既定文面を確認
でき、`.example` の二重管理・docs 転載・ダンプタスクを要しない
(起草時の open-question footer-default-visibility は本 ADR へ統合
して決着)。

### F2: 運用者独自フッターは `user-footer.md` 1 枚

footer 設置ディレクトリ(F1)の `user-footer.md` を footer prompt の
**末尾**に連結する。
合成順は `preset + personality → system-footer → user-footer`。連結の
区切りは既存の personality / footer 結合と同じ空行(`\n\n`)とする。
空・欠落・read_error 時は F1 / F6 に従い「何も足さない」へ縮退する。
`system-footer.md` / `user-footer.md` はいずれも**全ペルソナ共通 1 枚
のみ**とし、persona 別の上乗せファイル(`user-footer.<persona_id>.md`)
は持たない。persona 固有の指示は従来どおり pack の `personality.md`
側で表現する。

### F3: 運用者フッターはリポジトリに置かない

`system-footer.md` / `user-footer.md` は env と同じ「環境ごとに変わる
運用側の設定ファイル」であり、リポジトリへはコミットしない。F1 の
root 分離により既定の置き場が repo の外になるため、`.gitignore` /
`.dockerignore` の除外行は不要になる(repo 追跡下の pack dir に同居
させる起草時案では両方必須だった)。

### F4: 反映は watcher 経由で次回接続から

`KAOIRO_FOOTER_DIR` 設定時のみ、同ディレクトリ直下の
`system-footer.md` / `user-footer.md` の**ファイル名完全一致**を専用
watcher で監視し(persona pack の watcher とは分離。任意の `*.md`
には広げない)、server 再起動なしに再構築する。debounce 窓内で
2 ファイルを同時更新した場合、一時的に新旧混在の snapshot があり得る
ことは許容する(直後の rebuild で収斂)。接続中の wrapper には反映
せず、次に接続する wrapper のスナップショットから効く
([ADR-0029](0029-persona-server-sot-and-pack-distribution.md) F9 を維持)。

### F5: 合成結果は rebuild ログで常時可視化する

rebuild のたびに、各層の由来(file / built-in / missing / empty /
read_error)・文字数・正規化後の短縮 SHA-256 を info レベルでログに
出す。read_error は missing / empty と区別し、絶対 path と理由を
warn で出す(silent failure にしない)。長さの warn 閾値は設けない
(根拠ある閾値が立たず、常時 warn は無視される)。肥大への気付きと
3 層合成の配送文字列の追跡(下記 Negative)は文字数 + hash で担保し、
長さ担保の論点はこれで決着する
([coordination-footer-scope](../open-questions/coordination-footer-scope.md)
には文面の論点のみが残る)。

### F6: 読み取りの意味論

- UTF-8 必須。先頭 BOM は除去し、CRLF は LF へ正規化する。invalid
  UTF-8 は read_error として扱う(rebuild は落とさない)。
- regular file のみ読む。symlink・FIFO 等は read_error 扱いで拒否する
  (FIFO の `File.read` ブロックや、root 外 target の変更を watcher
  が拾えない問題を避ける)。
- cold start の read_error は欠落と同じ縮退(system → 内蔵版、user →
  なし)。稼働中の一時的な read_error は**直前の正常値を維持**する
  (atomic save や権限変更の短い窓で、新規接続だけ規約が消える事故
  を防ぐ)。いずれも F5 の warn を出す。
- byte 上限は設けない(trusted local input として operational cap
  なしを明示する)。

## Consequences

### Positive

- フッター文面の試行が再ビルド不要になり、ADR-0044 F1 の文面確定
  ([coordination-footer-scope](../open-questions/coordination-footer-scope.md))
  を「案 A から始めて計測する」進め方で回せる。
- kaoiro 既定 (`system-footer.md`) と運用ルール (`user-footer.md`) が
  分離され、既定の更新を取り込みつつ独自指示を保てる。
- footer root は読み取り専用アクセスのみで、`:ro` mount 構成でも
  壊れない(pack ingest の `.cache` 書き込み問題から分離済み)。
  container では bundled packs を置き換えずに footer 2 枚だけを永続
  編集できる。

### Negative

- プロンプトの注入層が 3 つ(personality / system / user)になり、
  実際に配送された文字列の追跡が難しくなる。F5 の rebuild ログ
  (由来 + 文字数)で追跡の起点を確保する。
- `system-footer.md` を置いた運用者には、kaoiro 側の既定更新が届か
  なくなる(意図的な override であり、`user-footer.md` の存在理由)。
- 運用者の自由記述がそのまま全エージェントの常時 context 消費になる。
  警告閾値は設けず(F5)、ログ可視化で肥大に気付ける状態を保つ。

### Neutral

- ADR-0029 F5(結合は server 側の責務、wrapper は受領文字列をそのまま
  注入)は変わらない。変わるのは「文面の SoT がコードかファイルか」
  の 1 点。
- 既定文面の実物は F1 の `priv/footers/system-footer.md` 実ファイル
  をそのまま見せる(起草時の open-question footer-default-visibility
  は本 ADR へ統合して close)。

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
| footer を persona 設置ディレクトリ root に同居(起草時案) | pack ingest の `.cache` 書き込みで `:ro` を保証できず、repo 追跡下の既定 dir へ運用ファイルが git / docker build 混入する。専用 root 分離(`KAOIRO_FOOTER_DIR`)で両問題が消える |
| 起動時に既定文面を seed 書き出し | `:ro` マウント環境で機能しない。一度書き出すと配布物側の更新が既存インストールに届かない |
| `system-footer.md` を必須ファイル化 (fail-closed) | 既存環境がアップグレードで即死する。移行手順が必須になり、フッターだけ ADR-0029 F3 より強い制約を負う |
| 共通 + persona 別 user footer の 2 層 | 注入層が 4 つになり、実プロンプトの追跡が現実的でなくなる |
| persona 別 user footer のみ | 全員共通のルール 1 行を足すのに全 persona 分のファイル編集が要る |
| フッターファイルをリポジトリにコミット | 環境ごとに内容が変わるため衝突源になる。env と同じ扱いが自然 |
| 接続中セッションへのホットスワップ | ADR-0029 F9(会話中に persona が変わる不確実性を持ち込まない)と衝突 |
| server 再起動時のみ反映 | 文面の試行錯誤コストが下がらず、外部化の主目的を損なう |
| 既定文面の提示: `system-footer.md.example` を別途配布 | 内蔵版と example の二重管理になり、同期切れが誤解を生む。F1 の `priv/` 実ファイル埋め込みなら実物そのものを見せられる |
| 既定文面の提示: docs へ全文転載 | コピー元が md 内コードブロックになり整形崩れ・転載 drift の温床 |
| 既定文面の提示: mix タスクでダンプ | 実行環境前提(コンテナ運用だと `docker exec`)。`priv/` 実ファイルで代替できる |
| 長さガード: 閾値超えで server warn (L2) | 閾値の根拠が立たない。常時 warn は無視される。F5 のログ可視化で代替 |
