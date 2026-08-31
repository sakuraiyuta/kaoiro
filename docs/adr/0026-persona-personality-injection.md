---
title: 人格プロンプト注入 — SDK systemPrompt.append + wrapper 同梱 md
status: superseded
date: 2026-07-02
opened: 2026-07-02
supersedes: []
superseded_by: 29
related_specs: [persona-personality-injection, personas, threat-model]
related_adrs: [3, 6, 29]
---

# ADR-0026 — 人格プロンプト注入 — SDK systemPrompt.append + wrapper 同梱 md

## Status

Superseded by [ADR-0029](0029-persona-server-sot-and-pack-distribution.md)
(2026-07-05)。SDK `systemPrompt.append` 経由での注入方式は継承しつつ、
人格プロンプトの一次ソースを wrapper 同梱 md から server 集約 SoT に
移し、配送を WS ハンドシェイクの push で行う形に転換した。共通フッター
の結合は wrapper 側から server 側に移動した。

以下は歴史的経緯として残す。

## Context

[personas](../specs/personas.md) はペルソナ立ち絵の性格付け (ao/momo/kuroe)
を保持してきたが、口調・一人称等の会話設定は「消費する機能が現行仕様に無い」
という理由で明示的に非対象としていた。kaoiro が dogfooding 可能な段階に
入り、実行時の会話にも一貫したキャラクター性を持たせる価値が生じたため、
人格記述を Claude Agent SDK に注入する仕組みを設計する。

主な設計問:

1. Claude Agent SDK への注入経路(preset.append か完全置換か)
2. 人格文字列の格納方式(config 内べた書きか、外部 md 参照か、同梱パックか)
3. 共通フッターの中身と合成順
4. 多言語対応の下地
5. 文字数上限の扱い

## Decision

- **D1 注入方式**: SDK の `systemPrompt: { type: 'preset', preset:
  'claude_code', append: ... }` の `append` に「人格記述 + 共通フッター」
  を差し込む。preset を捨てて自作 string に置換しない。
- **D2 格納方式**: wrapper リポジトリに `wrapper/personas/<persona.id>.md`
  として**同梱**する。`config.persona.personality_prompt_file?` があれば
  それで override、無ければ同梱デフォルトを解決する(γ2 方式)。サーバ経由
  の配信は行わない。
- **D3 共通フッター**: 中身と合成順は当初 open-question として `persona-
  common-footer` に委ねる方針だった(初期実装の暫定方針は「環境認識 1 文
  (このエージェントは kaoiro クライアント越しに操作されています相当)を
  ハードコード」)。この open-question は 2026-07-05 に
  [ADR-0029](0029-persona-server-sot-and-pack-distribution.md) D5 に
  merge され、暫定方針そのまま確定として close された。
- **D4 言語**: Persona に `language?: string` フィールドを追加(未指定は
  `"ja"` 既定)。phase-0 では読み込みのみで dispatch ロジックは持たず、
  多言語 dispatch は [persona-language-dispatch](../open-questions/persona-language-dispatch.md)
  で追う。
- **D5 文字数上限**: spec に SHOULD 目安 (200-1000 字) を明記。hard 上限は
  置かない。
- **注入は wrapper 起動時のみ**。mid-session の差し替えは不可。サーバ側
  からの上書き経路も用意しない([threat-model](../specs/threat-model.md) の
  allowed_tools と同じ扱い)。
- **Envelope 非露出**: 人格文字列を state_change / log / result envelope に
  載せない。dashboard に流れる ID は従来通り `persona.id` / `persona.name`
  のみ(pack 由来の canonical、session 中不変)。**稼働中に変わり得る
  表示名は別の top-level `display_name` field が担う**(issue #209
  D19/D23) — `persona.name` 自体を rename の対象にしない、という本節
  の趣旨とも一貫する。

## Consequences

### Positive

- 同一 `persona.id` は再起動をまたいで同じ立ち絵 + 同じ口調で応答する
  ようになり、[ADR-0003](0003-persona-identity-persistence.md) の同一性
  永続化が「見た目」から「振る舞い」まで拡張される。
- Claude Code preset の tool 使用マナー・安全指示が保持されるため、既存
  挙動への副作用が最小。
- 人格記述は wrapper リポジトリ内で管理でき、サーバ・dashboard を触らずに
  試作・調整が回せる。dogfooding フェーズの反復コストが低い。
- `language` フィールドを先に敷いたことで、後で多言語 dispatch を足す
  ときの型変更が要らない。

### Negative

- Claude Code preset の指示(簡潔さ・事実確認等)と人格記述(口調上書き等)
  が競合する余地。判別可能性は SHOULD 止まりとし、問題化を待つ運用に
  なる。
- 人格文字列を wrapper に同梱するため、人格更新のたびに wrapper 再起動が
  要る(mid-session 差し替え不可)。
- 共通フッターの中身が未決のまま phase-0 に入るため、暫定ハードコードを
  後で差し替えるコストが残る。

### Neutral

- 人格文字列は wrapper 内で完結し、Envelope・サーバ・dashboard 側の
  スキーマ変更は不要。ADR-0003(サーバは agent 非依存)を破らない。
- `default` ペルソナは人格記述を持たず、共通フッターのみ append される。
  personas.md の「default = 立ち絵なし・CSS 顔」既定と対称的な扱い。

## Alternatives Considered

### D1 注入方式

| Option | Why rejected |
|--------|--------------|
| B: `systemPrompt` を string で完全置換 | Claude Code preset の大量の tool 使用マナー・安全指示を自作する必要があり dogfooding 段階では非現実的 |
| C: 制御メッセージで mid-session 差し込み | SDK に該当機能なし(`systemPrompt` は query 開始時のみ有効) |

### D2 格納方式

| Option | Why rejected |
|--------|--------------|
| α: config JSON にべた書き | 長文編集時の JSON エスケープが dogfooding の摩擦になる。数行〜数十行の md を JSON 内 string で扱うのは辛い |
| β: config で個別ファイル参照を必須 | 同梱デフォルトがないので、初期 3 体が「箱を開けたら動かない」状態になる |
| γ1: server/priv 経由の配信 | サーバが人格文字列の一次ソース化してしまい、「サーバから上書き不可」方針と衝突する |

### D4 言語

| Option | Why rejected |
|--------|--------------|
| η: 日本語想定固定(将来 open-question 化) | 検討時の推奨案だったが、future-proof を先に敷く判断で不採用 |
| ι: 何も決めない | 「日本語で書いていいの?」の実装迷子リスク |

### D5 文字数上限

| Option | Why rejected |
|--------|--------------|
| μ: hard 上限 8KiB でエラー | SHOULD 止まりで判別可能性を追求しない今回のスコープ方針と整合しない。fail-fast は将来問題化してから追加でよい |
| λ: 上限なし・目安も書かない | 初期執筆時の指針不足。SHOULD 目安を書くだけで済む |
