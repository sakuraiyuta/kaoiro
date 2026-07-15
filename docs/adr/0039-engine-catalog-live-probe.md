---
title: LaunchDialog モデル catalog を短命 SDK probe + runner memory cache で live 化する (Option E)
status: accepted
date: 2026-07-15
opened: 2026-07-15
supersedes: []
superseded_by: null
related_specs: [protocol, plugin-model]
related_adrs: [23, 32, 35, 37]
---

# ADR-0039 — LaunchDialog モデル catalog を短命 SDK probe + runner memory cache で live 化する (Option E)

## Status

Accepted (2026-07-15、マスター決裁)。実装は
[phase-20-engine-catalog-live-probe](../plans/phase-20-engine-catalog-live-probe.md)。

## Context

[ADR-0037](0037-claude-model-catalog-live-refresh.md) F1 は LaunchDialog の
Claude モデル catalog を `default` 1 エントリの BOOTSTRAP に縮小した。理由
は「register 経路は wrapper Query 未生成のため SDK.supportedModels() を
呼べない」という鶏と卵の制約であり、これは F2 の live 経路 (`ext.models` を
`AgentHost.#refreshSupportedModels()` で SDK 実測) が per-agent にしか
効かない事実と合わせて、fresh operator が開く LaunchDialog を常に "default"
のみに固定していた。

kaoiro peer 越しの調査 (2026-07-15) で以下が判明した:

- `@anthropic-ai/claude-agent-sdk@0.3.208` の `Query` interface は
  `initializationResult(): Promise<SDKControlInitializeResponse>` /
  `supportedModels(): Promise<ModelInfo[]>` / `close(): void` を持つ。
- `SDKControlInitializeResponse.models` に catalog が既に含まれる。
- `Query` は `prompt: string | AsyncIterable<SDKUserMessage>` を要求し、
  control request は streaming input mode 限定 (`AsyncIterable` を渡した
  場合のみ動作)。resolve しない AsyncIterable を渡せば user_message は
  送られず、init 完了後に control request だけを叩いて close できる。
- Empirical spike (phase-20-1) で prompt 未送信の短命 probe が成立する
  ことを実測: init+supportedModels ~1.4s、close 後 subprocess 完全 cleanup、
  `~/.claude/projects/` 差分 0、tmpdir 汚染 0、OAuth/keychain 認証成功 (詳細
  は phase-20-1 の記録)。

したがって ADR-0037 の「原理的に不可能」は正確には「register-only 前提 (query
を一切生成しない前提) での不可能」であり、runner 上で **短命 SDK probe** を
走らせれば register 経路の catalog リッチ化が可能。

制約として:

- Codex 側は [ADR-0035](0035-codex-model-catalog-and-mid-session-switch.md)
  F1 の静的 catalog 判断を保持する (`codex doctor` が entitled model を
  返せない技術的不可能性、operator plan 申告で足りる)。live probe は
  Claude 側にのみ適用する。
- SDK 0.3.208 の `Options` に `settingsSources` は見つからず (実測、
  藤 turn-5 確認)、user settings は probe subprocess でも常にロードされる。
  副作用最小化は cwd 隔離 + `mcpServers: {}` / `tools: []` / `hooks: undefined`
  等で対応する。`--bare` は keychain reads を skip して OAuth を切るため
  probe には使えない (前段調査で誤って提案したが撤回済み)。
- Codex `AGENTS.md` の peer-first routing (ADR-0038) と同様、probe の
  subprocess は runner が保持する auth context を使う。runner の auth と
  operator が spawn する wrapper の auth が同じ account を指す前提。
  multi-account host では account mismatch のリスクが残る (ADR-0038 と同構造)。

## Decision

### F1 — Option E: runner-only orchestration (server cache なし)

catalog SoT は runner の memory cache とする。server に per-host warm cache
GenServer を追加する Option D は退ける (`(host, engine)` の precedence 判定 /
TTL / probe と wrapper の consistency 判定 / envelope 経路への write が増え、
複雑度に見合う価値がない)。既存 `HostRegistry` の engines 保持と
`RunnerLink.updateRegister()` の register 再送信で完結する。

### F2 — 短命 probe CLI を `@kaoiro/claude-code` に切り出す

`wrapper/claude-code/src/probe.ts` を新設し `bin: kaoiro-claude-probe` として
公開する。runner は child process として `spawn(process.execPath,
[require.resolve('@kaoiro/claude-code/dist/probe.js'), ...])` で起動し、
`@anthropic-ai/claude-agent-sdk` への直依存を wrapper 側に閉じる (runner
package は SDK を dependency に加えない)。probe は stdout に 1 行 JSON で
結果を返し、exit 0 = 成功 / 1 = 失敗。

### F3 — probe は init.models を第一取得源、supportedModels() を fallback

`initializationResult()` の応答 `SDKControlInitializeResponse.models` に catalog
が既に含まれるため、probe はまずこれを使う。init.models が空 / undefined / 欠落
の場合のみ `supportedModels()` を追加で叩く (SDK 応答 shape 変化への耐性)。
同じ control request を無駄に二重取得しない (藤 turn-5 の設計指摘)。

### F4 — probe Options: 副作用最小 + OAuth/keychain 保持

probe は以下の Options で SDK query を起動する:

- `cwd`: 新規作成の隔離 tmpdir (`os.tmpdir()/kaoiro-claude-probe-<pid>-<ts>`)、
  finally で削除。project settings / CLAUDE.md 発火 / session file 汚染を封じる。
- `mcpServers: {}` / `tools: []` / `allowedTools: []` / `disallowedTools: []`
  / `agents: {}` / `additionalDirectories: []` / `hooks: undefined`。
- `env` 未指定 (SDK が `process.env` を継承) — keychain / OAuth / API-key の
  auth 経路を保持する。
- `settingsSources` は SDK 0.3.208 に見つからず (実測)、user settings は
  常にロードされる。追加抑止手段なし。

`--bare` 相当は **採らない** (keychain reads を skip して OAuth を切るため)。

### F5 — runner memory cache: TTL 1h、last-known-good、dedup

`runner/src/claude_catalog_cache.ts` は engine → `{ models, fetchedAt }` の
memory-only cache (disk persist なし)。TTL 既定 1 時間。TTL 判定は runner
のみが行う (client は毎回 auto-refresh を投げ、runner が cache 判定で
skip)。

- `force=false` (LaunchDialog auto-refresh): cache fresh なら probe skip、
  `ok=true` を即返す。stale/miss なら probe 実行。
- `force=true` (LaunchDialog 手動 button): TTL 無視で probe 実行。
- 同時 refresh は runner-level Mutex + in-flight Promise 共有で 1 subprocess
  にまとめる (dedup)。
- probe 失敗時は cache を更新しない (last-known-good を保持)。次の refresh 要求
  で再挑戦できる。

### F6 — protocol event: `refresh_engine_catalog` + `catalog_result`

`protocol/src/index.ts` に以下 2 型を追加:

- `RefreshEngineCatalog { version, engine, request_id, force? }` — client →
  server → runner。host_id は topic で addressing (agents_channel は
  payload の `host_id` から runner topic を決める)。
- `EngineCatalogResult { version, host_id, engine, request_id, ok, reason?,
  models_count? }` — runner → server → operators (agents:lobby, operator-only)。
  失敗は closed vocabulary (`EngineCatalogFailReason` = `auth_failed` /
  `spawn_failed` / `cli_error` / `invalid_output` / `timeout` /
  `unsupported_engine`)。

`models_count` は toast 用の size-only 信号で、モデル名等の詳細は含めない
(catalog 本体は既存 `hosts` broadcast で流れる)。

### F7 — server は薄い relay に留める

`agents_channel.ex` に `handle_in("refresh_engine_catalog", ...)` を既存
`relay_to_runner_guarded` パターンで追加 (operator-only、host_id 剥がして
`runner:<host_id>` へ broadcast)。`runner_channel.ex` に
`handle_in("catalog_result", ...)` を既存 `forward_to_operators` パターンで
追加 (host_id stamp して `agents:lobby` へ broadcast)。engine の validation は
runner に委ねる (Option E で runner が SoT、server は engine-agnostic)。
`agents_channel` の `intercept` と `handle_out` に `catalog_result` を追加し
operator-only 配信を保証する。

### F8 — client: 自動 refresh on open + Claude 限定 button + default fallback

`LaunchDialog.svelte` は `engine === "claude-code" && hostId !== ""` に
なった時点で自動的に `connection.refreshEngineCatalog(hostId, engine, false)`
を発火する。手動 button は `force=true` で発火。button は Claude engine
選択時のみ表示 (Codex は静的 catalog、Codex では意味がない)。probe 失敗
時は既存の `default` 1 エントリ fallback を維持する (LaunchDialog は
`engineModels ?? []` で描画済み)。

catalog 本体は runner が `updateRegister` を呼んだ結果の `hosts` broadcast
で自然に repopulate される。`catalog_result` の toast (成功時 models_count /
失敗時 reason) は parent 層で `onCatalogResult` を hook する形で扱えるが、
本 phase では最小実装として LaunchDialog 内の error 表示に留める (詳細
toast は future work)。

## Consequences

### Positive

- LaunchDialog Claude モデル catalog が live 実測に追従する (Sonnet 5 等の
  新モデルを手動更新なしで表示可能)。
- Server-side cache を追加せず、既存 `RunnerLink.updateRegister()` +
  `HostRegistry` upsert + `hosts` broadcast の枠内で完結する。
- probe は SDK 直依存を wrapper package に閉じ、runner は engine-agnostic な
  child process spawn だけを持つ。engine 追加時の runner 変更が最小。
- OAuth / keychain / API-key の全 auth 経路が保持される (`--bare` を採らない
  ことで実現)。
- TTL / dedup を runner memory に閉じ、複雑度が最小 (server cache / disk
  persist なし)。
- session/history 汚染ゼロ (spike で 0 files 実測)、課金なし (control
  request で REST 未呼び出し)。

### Negative

- Multi-account host では runner auth と operator が spawn する wrapper auth
  が異なる account を指す可能性があり、probe と wrapper で catalog がずれる
  リスクが残る (単一 account host では発生しない)。
- Runner 起動時は cache 空。最初の LaunchDialog open で probe が走るため、
  ~1.5s の待ち時間が発生する (auto-refresh の spinner で表示)。
- SDK subprocess spawn の overhead (~1s) が cache miss 時に発生する。

### Neutral

- `default` fallback は保たれるため、probe 失敗環境 (auth 未設定 etc.) でも
  LaunchDialog は使える。
- Codex 側 catalog は据え置き (ADR-0035 F1 保持)。
- server-side cache を持たない設計は将来の要件 (複数 runner が同じ engine
  catalog を共有する等) が生じたら再評価する。

## Alternatives Considered

| Option | Decision |
|--------|----------|
| Option A: runner 常駐 WarmQuery | Reject。startup() で subprocess を pre-warm しても Query 昇格は 1 回限りで、複数 refresh に使い回せない。常駐 subprocess の maintenance コストに見合わない |
| Option C: server-side warm cache primary | Reject。(host, engine) precedence / TTL / probe と wrapper の consistency 判定 / envelope 経路への write が増え、複雑度に見合う価値なし (藤 turn-3)。runner cache の last-known-good で resilience は同等 |
| Option D: hybrid (server cache primary + runner probe fallback) | Reject。上の C を primary にした複合案。C を退けた時点で不要 |
| REST `/v1/models` (`@anthropic-ai/sdk`) | Reject。OAuth-only 環境で `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` 未設定なら不可。SDK subprocess のほうが auth 経路が広い |
| `--bare` オプション相当を probe に採用 | Reject。keychain reads を skip して OAuth を切るため、マスター環境で probe が auth 失敗になる (藤 turn-5 訂正) |
| probe を runner package に直実装 | Reject。runner が `@anthropic-ai/claude-agent-sdk` に直依存すると engine 境界が崩れる (ADR-0032 F1 分離を退行させる) |
| server 側に engine validation | Reject。Option E で runner が SoT。server は agent-agnostic な relay に留める (ADR-0023 慣習) |

## Implementation

[phase-20-engine-catalog-live-probe](../plans/phase-20-engine-catalog-live-probe.md)。
実装は kaoiro peer delegation で kuroe が実施、fuji がレビュー・Git 判断を
担う。commit / push / branch は fuji 承認後。

Phase 20-1 の empirical spike (2026-07-15) で本 ADR の前提を追認済み:
prompt 未送信の短命 probe が SDK 0.3.208 で成立、session file 差分 0、
tmpdir 汚染 0、close 後 subprocess 完全 cleanup、OAuth 認証成功。

kaoiro peer (fuji) の独立 real probe 実行でも同結果を追認 (redact 済み記録):
PASS / exit 0 / elapsed ~1.59s / 6 models / `~/.claude/projects` ファイル数
差分 0 / 個人情報出力なし / probe 残留プロセスなし。F4 の Options 構成
(cwd 隔離 + `mcpServers: {}` / `tools: []` / OAuth 保持) が operator の
実環境でも実測どおりに機能することを確認。
