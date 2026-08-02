---
title: 共通フッターの外部ファイル化 — system-footer.md と user-footer.md
status: proposed
date: 2026-08-02
opened: 2026-08-02
supersedes: []
superseded_by: null
related_specs: [persona-personality-injection, persona-pack-schema]
related_adrs: [29, 44]
---

# ADR-0045 — 共通フッターの外部ファイル化

## Status

Proposed。[ADR-0029](0029-persona-server-sot-and-pack-distribution.md)
の F5 / D5 を部分改訂する(supersede はしない)。
[#175](https://gitea.example.invalid/sakurai.yuta/kaoiro/issues/175)
([ADR-0044](0044-coordination-injection-hitl.md) の実装)が同じ
フッターの**文面**を詰めている最中のため、突き合わせが済むまで
accepted にしない。

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

制約が 1 つある。persona 設置ディレクトリは `:ro` でマウントされうる
(`server/docker-compose.yaml` の overlay 例)。したがって server 側から
ファイルを書き出す前提の設計は採れない。

## Decision

### F1: 既定フッターは「内蔵デフォルト + ファイル優先」

既定文面は server バイナリに内蔵し、persona 設置ディレクトリ
(`KAOIRO_PERSONA_DIR`、既定 `priv/persona-packs`)の root に
`system-footer.md` があれば、その内容で内蔵版を**完全に置き換える**。
ファイルが無い / 空なら内蔵版を使う(fail-closed にしない)。

### F2: 運用者独自フッターは `user-footer.md` 1 枚

同 root の `user-footer.md` を footer prompt の**末尾**に連結する。
合成順は `preset + personality → system-footer → user-footer`。
`system-footer.md` / `user-footer.md` はいずれも**全ペルソナ共通 1 枚
のみ**とし、persona 別の上乗せファイル(`user-footer.<persona_id>.md`)
は持たない。persona 固有の指示は従来どおり pack の `personality.md`
側で表現する。

### F3: 運用者が置いたフッターファイルは git 管理外

`system-footer.md` / `user-footer.md` は env と同じ「環境ごとに変わる
運用側の設定ファイル」として扱い、`.gitignore` に追加する。既定の
取り込みディレクトリ `server/priv/persona-packs/` は git 追跡下
(pack zip が置かれる)なので、明示的な除外行が必須になる。

### F4: 反映は watcher 経由で次回接続から

`KaoiroServer.PersonaWatcher` の監視対象(現在は `*.zip` のみ)を `.md`
にも広げ、server 再起動なしに再構築する。接続中の wrapper には反映せず、
次に接続する wrapper のスナップショットから効く
([ADR-0029](0029-persona-server-sot-and-pack-distribution.md) F9 を維持)。

## Consequences

### Positive

- フッター文面の試行が再ビルド不要になり、ADR-0044 F1 の文面確定
  ([coordination-footer-scope](../open-questions/coordination-footer-scope.md))
  を「案 A から始めて計測する」進め方で回せる。
- kaoiro 既定 (`system-footer.md`) と運用ルール (`user-footer.md`) が
  分離され、既定の更新を取り込みつつ独自指示を保てる。
- `:ro` マウント構成でも、書き込みを一切行わないため壊れない。

### Negative

- プロンプトの注入層が 3 つ(personality / system / user)になり、
  実際に配送された文字列の追跡が難しくなる。
- `system-footer.md` を置いた運用者には、kaoiro 側の既定更新が届か
  なくなる(意図的な override であり、`user-footer.md` の存在理由)。
- 運用者の自由記述がそのまま全エージェントの常時 context 消費になる。
  長さガードの要否は
  [coordination-footer-scope](../open-questions/coordination-footer-scope.md)
  で扱う。

### Neutral

- ADR-0029 F5(結合は server 側の責務、wrapper は受領文字列をそのまま
  注入)は変わらない。変わるのは「文面の SoT がコードかファイルか」
  の 1 点。
- 既定文面の実物をどう運用者に見せるかは未決
  ([footer-default-visibility](../open-questions/footer-default-visibility.md))。

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
| 起動時に既定文面を seed 書き出し | `:ro` マウント環境で機能しない。一度書き出すと配布物側の更新が既存インストールに届かない |
| `system-footer.md` を必須ファイル化 (fail-closed) | 既存環境がアップグレードで即死する。移行手順が必須になり、フッターだけ ADR-0029 F3 より強い制約を負う |
| 共通 + persona 別 user footer の 2 層 | 注入層が 4 つになり、実プロンプトの追跡が現実的でなくなる |
| persona 別 user footer のみ | 全員共通のルール 1 行を足すのに全 persona 分のファイル編集が要る |
| フッターファイルをリポジトリにコミット | 環境ごとに内容が変わるため衝突源になる。env と同じ扱いが自然 |
| 接続中セッションへのホットスワップ | ADR-0029 F9(会話中に persona が変わる不確実性を持ち込まない)と衝突 |
| server 再起動時のみ反映 | 文面の試行錯誤コストが下がらず、外部化の主目的を損なう |
