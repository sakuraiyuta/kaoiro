---
title: Codex model カタログの現状と変更経路
description: OpenAI Codex エコシステム側のプラン × 利用可能 model 表、認証 2 モード (ChatGPT-account / API-key) の非対称、model 変更の 3 経路 (Web UI / CLI / config.toml)、および `codex doctor` の情報粒度。ADR-0032 F4bc「空カタログ + アカウント既定委任」判断の根拠情報。
status: accepted
related: [codex-sdk-events, protocol, plugin-model]
---
<!-- markdownlint-disable MD033 -->

# Codex model カタログの現状と変更経路

## Purpose

[ADR-0032](../adr/0032-codex-adapter.md) F4bc は Codex adapter の
`supportedModels()` を空カタログとし model 選択をアカウント既定に委任する
判断を採ったが、その **根拠となる Codex エコシステム側の現状** (プラン別
model 可用性 / 認証モードの非対称 / 変更経路 / SDK からの列挙可否) は ADR
本体には収まらないため本 spec に外出しする。

**phase-16 update (2026-07-13)**: [ADR-0035](../adr/0035-codex-model-catalog-and-mid-session-switch.md) の判断で catalog は復活
した。ChatGPT-account 認証下でも **operator が `runner.config.json` に
`codex.chatgpt_plan` を申告する**ことで entitled model 集合を静的に解決
できるようになり、Plus 以上では Sol / Terra / Luna の catalog を LaunchDialog
に出し、session 途中の switch も受け付ける (詳細は
[ADR-0035](../adr/0035-codex-model-catalog-and-mid-session-switch.md) と
[phase-16](../plans/phase-16-codex-model-switch.md))。本 spec は現時点でも
「なぜ列挙 API を待たず operator 申告に依存するか」の 1 次情報として
参照される。

**Status: accepted** — 一次情報 (OpenAI 公式ドキュメント / help center /
`codex doctor` 実行) の verbatim 引用ベース。ただし OpenAI 側運用で
entitled model 集合が動く実績あり (2026-07 時点で過去 `gpt-5.5` が
一時 404 → 復帰の例、[openai/codex#26892](https://github.com/openai/codex/issues/26892))
のため、本 spec の表は「2026-07-11 時点」のスナップショット。

## プラン × 利用可能 model (2026-07-11)

| プラン | 月額 | Codex 利用可能 model | Codex 側の既定 | 備考 |
|---|---|---|---|---|
| Free | $0 | `gpt-5.6-terra` のみ | Terra | Sol / Luna 選択不可 |
| Go | $8 | `gpt-5.6-terra` のみ | Terra | 2026-04 新設ティア |
| Plus | $20 | Sol / Terra / Luna (effort 選択可) | **Sol + medium** | CLI/Desktop で切替可 |
| Pro | $100 or $200 | Sol / Terra / Luna + `gpt-5.3-codex-spark` | **Sol + medium** | 200 版は 5h 窓 20 倍 |
| Business | $25/user | Sol / Terra / Luna | **Sol + medium** | 旧 Team ($30) を 2026-04 に置換 |
| Enterprise | custom | Sol / Terra / Luna (+ 個別交渉) | **Sol + medium** | admin 側 default 変更可 |
| API-key | 従量 | Sol / Terra / Luna / 5.5 / 5.4 / 5.4-mini + deprecated 一部 | **明示指定必須** | 400/404 制約なし |

**モデル slug** (`--model` / `~/.codex/config.toml` / `-c model=` で使う識別子):
`gpt-5.6-sol` / `gpt-5.6-terra` / `gpt-5.6-luna` / `gpt-5.5` / `gpt-5.4` /
`gpt-5.4-mini` / `gpt-5.3-codex-spark`。

**API 参考料金** (1M token あたり): Sol $5 入力 / $30 出力、
Terra $2.50 / $15、Luna $1 / $6。

## 認証 2 モードの非対称 (F4bc 根拠)

### ChatGPT-account 認証

プランに entitled されていないモデル slug を `--model` で明示指定すると:

- **HTTP 400** `{"detail":"The 'gpt-X.Y' model is not supported when using
  Codex with a ChatGPT account."}`
- または **HTTP 404** `Model not found gpt-X.Y`

観測された拒否 slug 例 (2026 時点、GitHub issue 実観測):
`gpt-5-codex` / `gpt-5.1-codex` / `gpt-5.2-codex` / `*-codex-mini` /
`codex-mini-latest`。過去には `gpt-5` / `gpt-5.5` も一時期拒否。

**列挙 API が存在しない**: このアカウントで通る slug 集合を SDK/CLI から
プログラム的に取得する経路は現時点で無い。`~/.codex/auth.json` は token を
保持するだけで entitlement を返さない。`codex doctor` (下記) も plan tier /
entitled models は返さない。この非対称と列挙不能が **ADR-0032 F4bc が
curated 静的リストを諦め空カタログに転じた直接の根拠**。

### API-key 認証

entitle 判定なし。上記拒否 slug も多くが通る。deprecated 版も一部残る。
curated 静的リストを持たせても 400/404 リスクは限定的。

## Model 変更の 3 経路

### (A) Web UI (Codex Settings)

2026-07-09 に Codex が macOS/Windows 版 ChatGPT Desktop App に統合された。

- **Codex サイドバー右上の歯車アイコン → 「Codex Settings」→ model
  プルダウンで切替**。同じパネルに「Open config.toml」ボタンあり
  (config.toml を直接編集する経路への導線)。
- Desktop / CLI / IDE 拡張は同一の `~/.codex/config.toml` を共有するので、
  どこで変えても全経路に効く。

ChatGPT web の設定画面ではなく **Codex 側でのみ** 変える点に注意 (ChatGPT
会話用と Codex コーディング用は別扱い)。

### (B) CLI option (一時上書き)

Codex CLI のヘルプ:

```text
-m, --model <MODEL>
    Model the agent should use
-c, --config <key=value>
    Override a configuration value that would otherwise be loaded from
    `~/.codex/config.toml`. Examples: `-c model="o3"`
```

- 単発上書き: `codex -m gpt-5.6-terra "..."`
- ドット記法: `codex -c model="gpt-5.6-luna" "..."`

`codex exec` / `codex mcp-server` などのサブコマンドでも同じフラグが渡る
(`@openai/codex-sdk` 経由の kaoiro も同じ)。ただし ChatGPT-auth 下では
プラン外 slug 指定で 400/404 に落ちる。

### (C) 永続設定 (`~/.codex/config.toml`)

```toml
# ~/.codex/config.toml
model = "gpt-5.6-sol"
```

**解決優先度** (高 → 低):

1. CLI フラグ (`--model` / `-c model=`)
2. profile (`[profiles.xxx]` セクション、`--profile` で有効化)
3. プロジェクト config `.codex/config.toml` (trusted project のみ)
4. ユーザ config `~/.codex/config.toml`
5. アカウント / プラン既定 (暗黙)

`CODEX_HOME` env で `~/.codex` の場所自体を移すことも可能。

## `codex doctor` の情報粒度

`codex doctor --json` (0.144.1) が返す 18 チェックのうち auth / config
関連が以下を報告する:

| フィールド | 経路 | 用途 |
|---|---|---|
| `auth.credentials.details["stored auth mode"]` | `~/.codex/auth.json` | `chatgpt` / `apikey` の判別 (kaoiro 側から取得可) |
| `auth.credentials.details["stored API key"]` | 同上 | API-key 併用の有無 |
| `auth.credentials.details["stored ChatGPT tokens"]` | 同上 | ChatGPT token 保存状態 |
| `config.load.details["model"]` | `~/.codex/config.toml` | 明示指定値 or `<default>` |
| `config.load.details["model provider"]` | 同上 | 通常 `openai` |
| `config.load.details["enabled feature flags"]` | 同上 | 有効な feature flag 一覧 |

**JSON 実形状の注意** (phase-16 の A-2 blocker で判明): 0.144.1 の doctor
`--json` は `checks` を「フラットな要素キー辞書」として返し、要素キー自体が
`"auth.credentials"` のようなリテラルなドット付き文字列になっている。
つまり `report.checks["auth.credentials"].details["stored auth mode"]` で
アクセスするのが正しく、`report.checks.auth.credentials.details[...]` の
ネスト path として辿ると常に undefined になる。テスト fixture もこの実
shape に合わせる必要がある (Potemkin fixture では実データ breakage を
検出できない、[runner/src/codex-auth.ts](../../runner/src/codex-auth.ts) 実装参照)。

**返さないもの** (F4bc の判断が変わらない主要因):

- Master (このアカウント) の **プラン tier** (Plus / Pro / Business / etc.)
- **アカウント既定モデル名** (Sol / Terra / Luna のいずれか)
- **entitled models 集合** (このアカウントで 400/404 にならない slug 列)

kaoiro 側は `codex doctor --json` を parse すれば auth mode 判別まで到達
できるが、そこから先は operator 手入力 or 上流 SDK の情報公開待ちになる。

## kaoiro 側への含意

- **旧実装 (ADR-0032 F4bc、2026-07-11 [e89fa98](https://gitea.example.invalid/sakurai.yuta/kaoiro/commit/e89fa98)、phase-16 で ADR-0035 に上書き)**:
  LaunchDialog に model select を出さず、wrapper は `model` を送らず、
  `codex exec` は `~/.codex/config.toml` → プラン既定の順で解決していた。
  AgentDetail は「アカウント既定 (選択不可)」を表示。
- **現行 (ADR-0035、phase-16、2026-07-13 host verify 済)**: operator が
  `runner.config.json` の `codex.chatgpt_plan` を申告することで catalog
  resolver (`@kaoiro/codex/catalog.ts`) が auth mode + plan から
  `EngineModelInfo[]` を返し、runner→wrapper→server→dashboard を経由して
  `ext.models[]` を advertise する。LaunchDialog に model / effort select
  が復活し、AgentDetail からの mid-session switch も
  `set_model` / `set_effort` で受け付ける。詳細は
  [ADR-0035](../adr/0035-codex-model-catalog-and-mid-session-switch.md) と
  [phase-16](../plans/phase-16-codex-model-switch.md)。
- **entitle 判定の非対称性は解消していない**: catalog は operator 申告に
  依拠しており、SDK からの列挙 API 出現時は再検討する余地あり。
- **切替の実行モデル**: switch は現 turn を保持したまま次 turn から適用する
  ([ADR-0035](../adr/0035-codex-model-catalog-and-mid-session-switch.md) F1)。不正 slug は turn 開始時に 400/404 で loud fail し、
  silent fallback せず旧 pinned model へ rollback する
  ([ADR-0035](../adr/0035-codex-model-catalog-and-mid-session-switch.md) F3、adapter 実装は [wrapper/codex/src/host.ts](../../wrapper/codex/src/host.ts))。
- **`~/.codex/config.toml` 直書きの位置付け**: kaoiro を介さない CLI/Desktop
  経由の運用や、kaoiro 未対応 slug (`gpt-5.3-codex-spark` 等 Pro 限定
  model) を使う場合の運用手段として引き続き有効。CLI 優先度 4 のため
  kaoiro 経由 spawn より低く、operator 明示指定と競合しない。

## 一次情報の参照先

- OpenAI 公式:
  [Codex Pricing](https://chatgpt.com/codex/pricing/) /
  [ChatGPT Learn — Models](https://learn.chatgpt.com/docs/models) /
  [Config basics](https://learn.chatgpt.com/docs/config-file/config-basic) /
  [Codex Settings (OpenAI Academy)](https://openai.com/academy/codex-settings/) /
  [Codex changelog](https://developers.openai.com/codex/changelog)
- OpenAI Help Center:
  [Using Codex with your ChatGPT plan (article 11369540)](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan) /
  [GPT-5.6 in ChatGPT (article 20001325)](https://help.openai.com/en/articles/20001325-a-preview-of-gpt-56-sol-terra-and-luna)
- 実観測 (400/404 挙動):
  [openai/codex#14266 (gpt-5.4 拒否期)](https://github.com/openai/codex/issues/14266) /
  [#19654 (gpt-5.5 unsupported)](https://github.com/openai/codex/issues/19654) /
  [#26892 (gpt-5.5 404 while gpt-5.4 works)](https://github.com/openai/codex/issues/26892)
- ローカル検証: `codex doctor --json --no-color` (Codex CLI 0.144.1、
  2026-07-11 実行)
