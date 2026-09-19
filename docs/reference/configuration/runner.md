---
title: "Runner configuration"
status: implemented
last_updated: 2026-09-19
---

# Runner configuration

## Coverage

This page covers the connection fields in `runner.config.json` (`host_id` /
`server_url` / `cwd_allowlist` / `capabilities` / tokens, below), the Codex
and Antigravity engine-specific blocks, and the Codex backend selector.
Operator steps are in the
[backend switching runbook](../../operations/codex-backend-switch.md). The
per-spawn config fields the runner relays to the wrapper process itself
are in [Wrapper configuration](wrapper.md).

## `runner.config.json` example (`wss://` required)

For prod deployments through nginx, `server_url` must be `wss://` (`ws://`
direct connections receive 301 under the [1.4](../../operations/network-and-login.md#14-nginx-reverse-proxy) constraint). Only the direct VPN
deployment ([1.5](../../operations/network-and-login.md#15-direct-vpn-deployment-no-nginx-plain-http-2026-07-26)) uses `ws://<PHX_HOST>:<PORT>/runner`. Make `host_id` unique per
host: the server's `HostRegistry` registers by host ID, so duplicates overwrite
one host with the other.

```json
{
  "host_id": "lab-pc-1",
  "server_url": "wss://kaoiro.example.com/runner",
  "cwd_allowlist": ["/home/agent/repos"],
  "capabilities": ["claude-code", "codex", "antigravity"]
}
```

Set `KAOIRO_RUNNER_TOKEN=<token issued in 1.1>` in `runner.env` (pair it with
`<host_id>:<token>` in server-side `KAOIRO_RUNNER_TOKENS`) and run `chmod 600`.
Override `server_url` with `KAOIRO_RUNNER_SERVER_URL` in `runner.env` as well
(issue #135; env takes precedence over the config file).

For local launchers, `runner/runner.env` is a separate gitignored file that
contains only `KAOIRO_RUNNER_TOKEN=<64 lowercase hex>`. `scripts/dev.sh` and
`scripts/dogfood.sh` create it with mode 0600 when absent and append its pair
to the server list for the configured host; a preset environment token wins
after validation.

接続先 `server_url` は環境変数 `KAOIRO_RUNNER_SERVER_URL` で上書きできる
(**env が config ファイルより優先**、issue #135)。配布バイナリ/サービス運用
(systemd/launchd ユニット、`env_file` 等)で `runner.config.json` を編集せず
接続先を切り替えたい場合に使う。`ws://` または `wss://` で始まる必要があり、
不正な形式は起動時 / config reload 時に fail-fast する。ホットリロード
(`watchRunnerConfig`)でも同じ優先順位を維持するため、env 設定中に
`runner.config.json` の `server_url` を書き換えても実際の接続先は変わらない
(host_id 等の他フィールド変更によるホットリロード自体は通常どおり効く)。

## Other `runner.config.json` and env fields

`context_work_budget_percent` は Claude の context window に対する soft な
作業予算の割合で、既定は `60`。wrapper は SDK が返した各 model の `maxTokens`
から token 分母を導出するため、1M window では 600k、200k window では 120k が
作業予算になる。`0 < 値 <= 100` の有限数だけを受け付け、変更は hot reload 後の
次回 spawn から反映される。生窓の使用率とこの作業予算比は、dashboard と wrapper
の context 通知で分母付きに併記される(issue #254)。

runner の Phoenix wire log は、定期 heartbeat の push と対応する reply を既定で
省略する。他の transport / reconnect / error / 制御メッセージは従来どおり出力される。
接続レベルの調査で従来の全量出力が必要な場合だけ、`runner.env` に
`KAOIRO_RUNNER_LOG_PHOENIX_HEARTBEATS=1` を設定する。`1` 以外・未設定は省略のまま。
この値は runner 起動時に `process.env` から読むため、変更後は runner サービスを
再起動する。dogfood の一時調査では
`KAOIRO_RUNNER_LOG_PHOENIX_HEARTBEATS=1 scripts/dogfood.sh` として起動すれば、
`tmp/dogfood-logs/runner.log` にも全量が出る。

## Codex backend

The public Codex engine defaults to `codex exec`. Set `codex.backend` to
`"app-server"` in `runner.config.json` to select the persistent app-server child
for subsequent Codex wrapper lifetimes on that host. `"exec"` or omission keeps
the default. The runner relays only its local selection as `codex_backend` in
the wrapper startup config; direct wrapper launches may use that same field.
Unknown values are rejected. No environment variable, command-line backend flag,
dashboard selector, spawn payload or resume snapshot selects a backend.

Configuration reload does not switch running children. After the runner's
`codex backend=... for subsequent wrappers` diagnostic, new launches and resumes
use the new selection. The wrapper also logs its selected backend at startup.
There is no automatic fallback to exec. See the
[rollback runbook](../../operations/codex-backend-switch.md#codex-backend-selection-and-rollback)
and [ADR-0058](../../adr/0058-codex-app-server-turn-steer.md).
Steering remains disabled and approval remains `never`.

### Codex backend selection

`runner.config.json` accepts `"codex": { "backend": "app-server" }` alongside
existing auth/catalog options. Omission or `"exec"` selects exec. The setting
is host-wide and applies only to new Codex wrapper lifetimes, including resume,
reset, and automatic restart. Existing children are not switched by a reload.
Invalid values reject startup (or skip a bad reload without replacing the last
valid config). Wait for `runner: codex backend=... for subsequent wrappers`
after editing; the earlier `config reload` line is not an application receipt.
There is no backend environment variable, flag or dashboard launch selector.

For rollback, stop the target agent, set `backend` to `"exec"`, wait for the
applied-config diagnostic, then resume its recorded session on the same host
and cwd. See [backend switching runbook](../../operations/codex-backend-switch.md#codex-backend-selection-and-rollback).
Use a runner release that bundles this selector and both backends; older
wrapper releases may ignore the new field. No automatic exec fallback is used.

## Codex 設定

`runner.config.json` の `codex` ブロックで Codex engine 固有の設定を渡す。

- `auth_mode`(`"chatgpt"` / `"apikey"`)— Codex アダプタの catalog 解決に
  使う auth mode の明示宣言(phase-24)。優先順位は **明示宣言 > codex CLI
  の `doctor` 検出 > `"unknown"`** で、宣言があれば検出をスキップするため
  runner の PATH に codex binary が無くても catalog が空にならない。これは
  catalog 選択用の宣言 metadata にすぎず、runner は credential を付与も変更
  もしない。`chatgpt_plan` からの暗黙推定はしない(API-key auth なのに plan
  が書かれた config を誤判定するため)。誤宣言すると catalog が実 entitlement
  とずれ、未対応 model / effort の明示要求が SDK 側で loud fail して既存の
  `switch_error` rollback に落ちる。
- `chatgpt_plan` — operator 申告の ChatGPT plan(catalog 解決に使用、
  API-key auth では無視)。
- `extra_models`(`EngineModelInfo[]`、issue #292)— lets the operator
  declare a model kaoiro's curated catalog
  (`wrapper/codex/src/catalog.ts`, ADR-0035 H3) has not caught up with yet,
  without waiting for a kaoiro release. Only `value` is required; every
  field accepts only `EngineModelInfo`'s INPUT subset — `resolved_model`
  is upstream-derived metadata and is never read from config.
  `display_name` defaults to `value`; omitting `effort_levels` means no
  effort UI is offered (ADR-0035's "never infer an effort level" rule). A
  matching `value` overrides the curated catalog's entry; a new `value` is
  appended (`mergeExtraModels`). The same merge applies both to the
  runner's register (LaunchDialog) and to the wrapper's own catalog
  resolution (`ext.models` / effort-switch / `setModel`). This does not
  bypass entitlement — declaring a model the account cannot actually use
  still hits the SDK's usual 400/404, surfaced as the existing
  `switch_error` rollback (or a launch failure for a fresh spawn).
  ```json
  "extra_models": [
    { "value": "gpt-6-astra", "display_name": "GPT-6-Astra",
      "effort_levels": ["low", "medium", "high", "xhigh", "max", "ultra"],
      "default_effort": "low" }
  ]
  ```
- `internal_subagents`(boolean、既定 `true`)— Codex の内部サブエージェント
  spawn の可否。正の boolean で、`true` は force-enable、`false` は無効化、
  省略は effective default の `true`。wrapper が per-run config に effective 値を
  常に `features.multi_agent` として注入する
  ([ADR-0038](../../adr/0038-codex-internal-subagents-toggle.md))。

**precedence**: runner option を SoT とし、user-global な Codex config
(`~/.codex/config.toml` 等)より **上位**。effective(= configured ?? true)を
常に per-run config へ書き込むため、global 設定に依らず runner の意図が優先
される(`false` のみ実際に無効化、`true` / 省略も明示注入)。

**live reload**: config を書き換えると次回以降の spawn にのみ反映される。稼働中の
wrapper プロセスは launch 時の値を保持し、即時には変わらない。

## Antigravity configuration

`runner.config.json`'s `antigravity` block passes Antigravity-engine-specific
settings (phase-34 Stage B6, issue #292).

- `cli_path` is an optional absolute path to `agy`. It is used unchanged for
  the model probe, hook registration, and every Antigravity turn. When it is
  absent, the runner searches only absolute directories in its own `PATH`.
  A bad explicit path never falls back to `PATH`; a newly spawned Antigravity
  wrapper is refused while existing wrappers retain their launch snapshot.
- `probe_timeout_ms` is an optional integer from 1000 through 120000, with a
  default of 30000. It bounds only `agy models` and `/hooks` probes, not a
  model turn or permission deadline. `KAOIRO_NODE` selects Node for runner
  helpers and is unrelated to this executable path.

- `extra_models` (`EngineModelInfo[]`) — the same operator-declaration
  mechanism as Codex's `extra_models` above, reusing the identical
  `parseExtraModels` / `mergeExtraModels` helpers: lets the operator
  declare a model that the register-time `agy models` probe (or the pinned
  1.1.26 snapshot fallback) does not yet return, without waiting for a
  kaoiro release. Only `value` is required; every field accepts only
  `EngineModelInfo`'s INPUT subset — `resolved_model` is upstream-derived
  metadata and is never read from config. `display_name`
  defaults to `value`; omitting `effort_levels` means no effort UI is
  offered (ADR-0035's "never infer an effort level" rule, which this
  engine follows too even though Antigravity itself has no effort switch
  today). A matching `value` overrides the resolved base catalog's entry;
  a new `value` is appended. The same merge applies both to the runner's
  register (LaunchDialog) and to the wrapper's own catalog (`ext.models`,
  `setModel`), and is re-applied on every live probe refresh so a
  refreshed catalog does not silently drop a declared model.
  ```json
  "antigravity": {
    "extra_models": [
      { "value": "gemini-4-nova", "display_name": "Gemini 4 Nova" }
    ]
  }
  ```

**live reload**: same semantics as the Codex block above — a config change
reaches only spawns after the reload. A reload resolves the path again, so a
fixed executable can recover without a config-text change. A catalog snapshot
fallback merely preserves model choices; it does not prove that a wrapper can
start.
