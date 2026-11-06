---
title: Wrapper configuration
description: Runner-relayed WrapperConfig fields and engine-local delivery controls.
status: accepted
last_updated: 2026-11-07
related: [protocol]
---

# Wrapper configuration

## Managed engine environment

The wrapper exports the following non-secret output to each managed engine
process (Claude Code, Codex exec/app-server, Antigravity, and Grok), on both
fresh starts and resumes:

| Variable | Wrapper value | Meaning |
| --- | --- | --- |
| `KAOIRO_AGENT` | `1` | A kaoiro-managed process or its descendant |

Variable existence is the stable detection contract, including an empty value.
The wrapper overwrites inherited values with `1` in its child environment and
leaves its parent's environment unchanged. This is an output to agents, not a
runner behaviour setting or an environment override covered by issue #469.
It carries no identity or credential and grants no permission.

Native tool shells and command hooks inherit the marker. Codex also sets it
explicitly in `shell_environment_policy.set`, including when inherited shell
variables are disabled. User-side command hooks can test for it without
printing other environment values:

```sh
[ "${KAOIRO_AGENT+x}" = x ] || exit 0
```

A nested CLI launched from a managed tool shell inherits the marker even if
it has no kaoiro MCP connection of its own. For independent CLI runs or hook
tests from that shell, remove it explicitly:

```sh
env -u KAOIRO_AGENT <engine-cli> ...
```

An independently launched plain CLI receives no new marker. Auxiliary probes
are outside this agent-session guarantee: probes sharing a marked child
environment may receive it, while independent catalog probes do not gain it.
Marker presence does not imply that kaoiro tools are available.

## WrapperConfig fields relayed by the runner (issues #181 and #292)

`WrapperConfig` (protocol/src/index.ts) is the runner's per-spawn config
handoff to the wrapper process it launches — a process-boundary data
structure, not a `runner:<host_id>` channel message like the ones in
[Runner control and launch](../protocol/runner-control.md).
Most fields mirror the `spawn` payload verbatim (`resolveWrapperConfig`,
runner/src/supervisor.ts). This section documents the fields that instead
come from `runner.config.json`'s per-engine blocks. Claude's delivery controls
below resolve at launch, using the runner-relayed flags and captured environment.

`codex_tool_home?: string` is a local runner-to-Codex-wrapper field. The runner
creates a private empty directory for each Codex wrapper and overwrites any
inbound value before launch; it is not a server or dashboard setting. A directly
launched Codex wrapper creates its own private directory when the field is
absent. The wrapper rejects a missing path or one resolving to its state home
before a turn. The directory is passed to native shell tools, while the native
Codex process keeps its separate `CODEX_HOME` for auth, sessions and resume.

- `in_flight_delivery_enabled?: boolean` — the runner resolves the host ceiling
  for this engine and relays it explicitly. `false` disables all declared
  in-flight modes after the backend (and, for Claude, its legacy opt-ins);
  per-agent policy cannot widen it. Direct Claude/Codex launches without this
  key resolve as if the ceiling were `true`.
  Antigravity still omits delivery declarations. Changes apply to later wrapper
  lifetimes; the live per-agent policy remains a separate gate.

- `codex_backend?: "exec" | "app-server"` — runner-local `codex.backend`,
  resolved to `"app-server"` when omitted and relayed only for Codex launches. The
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
  [Runner configuration](runner.md)'s "Codex 設定" / "Antigravity
  configuration" sections for the declaration syntax and merge semantics.

- `antigravity_cli_path` / `antigravity_probe_timeout_ms` — runner-local
  values derived from `antigravity.cli_path` / `antigravity.probe_timeout_ms`.
  They are not accepted from a server `spawn` payload and introduce no
  server/dashboard error vocabulary. The wrapper snapshots them at launch;
  path resolution or probe failure is reported only by an existing bounded,
  redacted local diagnostic.

- `max_sandbox` / `max_approval` / `max_network_access` — runner-local
  values derived from `antigravity.max_sandbox` /
  `antigravity.max_approval` / `antigravity.max_network_access`
  ([ADR-0057](../../adr/0057-antigravity-adapter.md) F4c Stage B0, issue
  #359). These are the host-local permission-switch
  ceilings for that agent: the wrapper (and the server, redundantly) reject
  a `set_permission` widening any axis past its ceiling with
  `exceeds_launch_ceiling`. See [Runner configuration](runner.md)'s
  "Antigravity configuration" section for the declaration syntax and
  defaulting rules.

## Codex operator steer controls

On the app-server backend a Codex wrapper declares `operator_input_modes:
{version: "v1", early: "steer"}` at join and steers an operator instruction into
the running turn only while the server echoes it. No opt-in is needed. The host
ceiling (`in_flight_delivery_enabled`, relayed from `in_flight_delivery.codex.enabled`;
`false` declares `early: "none"`) and the stored per-agent policy decide the
rest, so an operator turns it off per agent from the dashboard or for the host
through the runner configuration (see [Runner configuration](runner.md#host-delivery-ceilings-and-defaults)).
The exec backend and a false ceiling declare `early: "none"`, so the server stamps
operator input `normal` instead of deriving the default from the inter-agent
declaration. The wrapper logs `codex: operator_steer=on|off` at startup. See
[Codex app-server transport](../engines/codex-app-server.md#operator-steering-adr-0058-stage-2).

The old variables `KAOIRO_CODEX_OPERATOR_STEER` and
`KAOIRO_CODEX_OPERATOR_STEER_PERSONAS`, runner key `codex.operator_steer`
and wrapper field `operator_steer` are no longer recognized. They are silently
ignored without warnings, including obsolete non-boolean file values.
Use `in_flight_delivery.codex.enabled` for the next-spawn ceiling,
`in_flight_delivery.codex.default` for new agents, or the per-agent live policy.
A directly launched wrapper uses its `in_flight_delivery_enabled` ceiling.

## Codex approval axis controls

`KAOIRO_CODEX_APPROVAL_AXIS=1` in the Codex wrapper process environment
makes approval a mutable axis for every Codex peer on the app-server
backend; `KAOIRO_CODEX_APPROVAL_AXIS_PERSONAS=momo,other` enables only the
listed `persona.id` values. Both use `personaOptInSource`; only flag `1` enables globally. Otherwise a
comma-separated list of exact persona IDs decides, with whitespace trimmed;
an empty/invalid item invalidates the list. The default is off. An enabled wrapper
advertises `permission_switch_axes.approval` with `values: ["untrusted",
"on-request", "never"]` (launch value and ceiling `never`) once permission
sync is negotiated, writes the operator's selected approval into each
`turn/start`, and routes command and file-change approval requests to the
operator. Approvals have no deadline unless `permission_timeout_ms` is set.
`codex.approval_axis: true` in `runner.config.json` is the same global opt-in as the
variable `1`, and a set `KAOIRO_CODEX_APPROVAL_AXIS` wins over it. Config false is equivalent to absence and does not override a
persona-list opt-in. The exec backend ignores both variables. The wrapper logs
`codex: approval_axis=on|off` at startup. See
[Codex app-server transport](../engines/codex-app-server.md#approval-requests-adr-0064)
and [ADR-0064](../../adr/0064-codex-app-server-approval-requests.md).

Selecting `untrusted` or `on-request` also requires an operator dialog for
`request_session_reset`. The dialog is skipped only when both the dispatched
turn and latest selection are `never` and permission state is unblocked;
loosening a running strict turn takes effect on its next turn. Exec and
app-server with the axis off use `never`.

## Claude native continuation ownership

Unified native continuation ownership is the default for a new Claude wrapper
lifetime. `KAOIRO_CLAUDE_NATIVE_CONTINUATIONS` selects the mode at startup:

| Value | Mode |
| --- | --- |
| unset | native (default) |
| `1` | native (accepted for compatibility) |
| `0` | legacy |
| any other value | native, with one warning on stderr at startup |

Only the exact value `0` selects legacy, so a mistyped value never silently
turns the mode off. There is no live switch, runner configuration field, or
additional server capability. The selection is independent of the phase-2
delivery controls below.

The mode instruments root Agent launches, eligible inactive `SendMessage`
reactivations, and Monitor descriptions with wrapper-issued launch markers. It
requires native transcript evidence before granting a new send origin. Unknown
or unproved sources remain unable to send; Bash and Workflow completion policy
is retained. It does not enable native Monitor tools or change tool permission.
If the native transcript evidence becomes unusable while no native turn holds
a lease, only native continuations close for the rest of that wrapper
lifetime and ordinary input continues; relaunch the wrapper to restore them.

Native is the default because peer coordination builds on it; `0` is the
fallback for when native ownership must be withdrawn.
Landing it does not authorize production rollout, which remains a separate
operator gate under the
[high-risk change procedure](../../operations/high-risk-change-release.md). Monitor acceptance uses an isolated cache that exposes Monitor;
production availability remains unmeasured. See [Claude events](../engines/claude-events.md#native-continuation-ownership)
and [ADR-0063](../../adr/0063-layered-delivery-authority-and-continuations.md).

## Claude phase-2 delivery controls

Claude advertises `early: "fold"` and `yield: "tool_boundary"` by default when
`in_flight_delivery_enabled` is not false. The server must echo delivery modes
v1, and live delivery still requires the existing per-agent policy and final
host acceptance checks. `enabled: false` declares none; stored off prevents
new in-flight acceptance without changing the negotiated declaration.

`KAOIRO_CLAUDE_PHASE2_DELIVERY`, `KAOIRO_CLAUDE_PHASE2_DELIVERY_PERSONAS`,
runner key `claude_code.phase2_delivery` and wrapper field `phase2_delivery`
are no longer recognized and are silently ignored without warnings. They do
not enable or disable delivery. A direct wrapper uses its local
`in_flight_delivery_enabled` ceiling and per-agent policy; runner settings do
not control a direct launch. The startup diagnostic remains
`[claude phase2 delivery] source=policy`, or `source=off` under a false ceiling.

The runner no longer captures or strips these obsolete variables and does not
relay the old config keys. It still keeps `CODEX_HOME` out of Claude wrappers.
See [host delivery settings](runner.md#host-delivery-ceilings-and-defaults)
and the [C5 release prerequisite](../../operations/server-update-and-rollback.md#claude-delivery-opt-in-retirement).
A false ceiling retains FIFO root scheduling. With negotiated mechanisms,
stored off still allows operator-priority root scheduling while preventing
new folds/cuts; replacing an old false with stored off can change root order.

The dated [fold measurements](../../evidence/issue-429/2026-09-28-claude-fold-measurements.md)
and [2.1.284 remeasurement](../../evidence/issue-429/2026-09-29-claude-2-1-284-remeasurement.md)
remain historical observations of their named pins, not current-pin timing
claims. The native policy checks use an isolated local provider, not a billed
or credentialed model. The first-production-flip checklist remains retired.

## See Also

- [Runner control and launch](../protocol/runner-control.md) — the
  `runner:<host_id>` control channel this config rides (`spawn` payload
  fields this page's intro refers to as mirrored verbatim).
- [Runner configuration](runner.md) — the Codex backend selector and other
  `runner.config.json` settings not yet migrated here.
