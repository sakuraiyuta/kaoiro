---
title: Wrapper configuration (runner-relayed fields)
description: WrapperConfig fields the runner sources from runner.config.json, distinct from the fields mirrored verbatim from the spawn payload.
status: accepted
last_updated: 2026-09-19
related: [protocol]
---

# Wrapper configuration (runner-relayed fields)

### WrapperConfig fields relayed by the runner (issues #181 and #292)

`WrapperConfig` (protocol/src/index.ts) is the runner's per-spawn config
handoff to the wrapper process it launches — a process-boundary data
structure, not a `runner:<host_id>` channel message like the ones in
[Runner control and launch](../protocol/runner-control.md).
Most of its 30 fields mirror the `spawn` payload verbatim
(`resolveWrapperConfig`, runner/src/supervisor.ts); this section documents
only the fields that instead come from `runner.config.json`'s per-engine
blocks, since nothing else in this spec names `WrapperConfig`.

- `codex_backend?: "exec" | "app-server"` — runner-local `codex.backend`,
  resolved to `"exec"` when omitted and relayed only for Codex launches. The
  wrapper validates the closed enum. It is not accepted from `spawn` or a
  resume snapshot and is not a wire capability. Reload affects subsequent
  wrapper lifetimes, including resumes; existing wrappers retain their backend.

- `codex_extra_models` / `antigravity_extra_models` (`EngineModelInfo[]`)
  — the operator's `codex.extra_models` / `antigravity.extra_models`
  declaration (runner.config.json), already merged by the runner's
  `buildRegister` into the launch catalog it advertises. Relayed so the
  wrapper applies the SAME merge to its own catalog resolution — `ext.models`,
  effort-switch availability (Codex only), and `setModel` validation must
  all recognise a declared model too, not only the register's launch-time
  list. Absent / empty on either field means no declarations for that
  engine. See [Codex model settings](../../operations/codex-model-settings.md#d-kaoiros-own-extra_models-declaration-issue-292) (D) and
  runner/README.md's "Codex 設定" / "Antigravity configuration" sections
  for the declaration syntax and merge semantics.

- `antigravity_cli_path` / `antigravity_probe_timeout_ms` — runner-local
  values derived from `antigravity.cli_path` / `antigravity.probe_timeout_ms`.
  They are not accepted from a server `spawn` payload and introduce no
  server/dashboard error vocabulary. The wrapper snapshots them at launch;
  path resolution or probe failure is reported only by an existing bounded,
  redacted local diagnostic.

## See Also

- [Runner control and launch](../protocol/runner-control.md) — the
  `runner:<host_id>` control channel this config rides (`spawn` payload
  fields this page's intro refers to as mirrored verbatim).
- [Runner configuration](runner.md) — the Codex backend selector and other
  `runner.config.json` settings not yet migrated here.
