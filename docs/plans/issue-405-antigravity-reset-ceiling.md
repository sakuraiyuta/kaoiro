---
title: Issue 405 — Compare Antigravity reset ceilings using effective network access
description: Resolve false permission-ceiling refusals when an Antigravity sandbox determines effective network access, and make the recovery hint actionable.
status: implemented
last_updated: 2026-09-26
issue: 405
must_fix_rounds_used: 0
---

# Issue 405 — Compare Antigravity reset ceilings using effective network access

This plan starts from `origin/develop` at `ba696b503261db5c3af9f4806a5579b9f8f8d995`.
The implementation worktree is `worktrees/hiiro-405` on
`issue-405-antigravity-reset-ceiling`.

## Problem and evidence

The production observation recorded in
[issue #405](https://github.com/sakuraiyuta/kaoiro/issues/405) used server and
runner commit `063b6899`. An Antigravity agent launched with
`sandbox=danger-full-access`, `approval=never`, and no `network_access` field
received a resume snapshot with `network_access=true`. The runner refused its
operator-approved reset with `permission_ceiling_conflict`, reporting current
`true` against ceiling `false`. The issue reports this for one live agent; the
wider claim is inferred from the code path.

At the design baseline, source inspection confirms the mismatch:

- `runner/src/permission_ceiling.ts:156-171` resolves the default network
  ceiling from `launch.networkAccess ?? false`, so the omitted launch field
  pins `max_network_access=false`.
- `wrapper/antigravity/src/network_access.ts:3-15` maps
  `danger-full-access` to effective network access `true`, independent of the
  configured network value. `wrapper/antigravity/src/host.ts:427-430` stamps
  that effective value into `resume_snapshot`.
- `runner/src/supervisor.ts:1141-1175` applies that snapshot before checking it
  against the stored ceiling. `#ceilingConflictAgainst` at
  `supervisor.ts:1445-1458` passes the snapshot's network value and stored
  `max_network_access` to the same raw boolean comparison.
- Operator `session_reset` with either mode is sent to the runner as
  `reset_session` by `server/lib/kaoiro_server_web/channels/agents_channel.ex:833-884`.
  The runner validates the mode, then reaches the same ceiling check for both
  modes. The comparator is also called by `switch_session` at
  `runner/src/supervisor.ts:977-991`.
- The current dashboard formatter at `dashboard/src/App.svelte:397-405`
  instructs the operator to narrow the reported axis directly. When
  `danger-full-access` pins effective network access, narrowing only
  `network_access` cannot change that effective value.

A local runner measurement was made against the design baseline without starting
an Antigravity CLI, live agent, server, or production runner. A temporary
Vitest probe injected a fake child into `Supervisor`, launched with
`sandbox=danger-full-access`, `approval=never`, and omitted `network_access`,
then submitted the effective snapshot (`network_access=true`) with each reset
mode. `new` and `clear` both returned `ok=false`,
`reason=permission_ceiling_conflict`, and
`{axis: network_access, current: true, ceiling: false}`; in both cases the old
child remained alive. A control snapshot with `network_access=false` passed the
check, terminated the fake child, relaunched, and returned `ok=true`. The probe
reported `1` file and `3` passing tests. Its temporary test file was removed.
This measures the runner command path; it does not claim a live operator UI or
production end-to-end observation.

A separate before-change measurement confirms the same mismatch in
`switch_session`. A temporary Vitest probe launched an Antigravity child with
`sandbox=danger-full-access`, `approval=never`, and no `network_access`, then
called `Supervisor.handleSwitchSession` with a valid target and snapshot
`{sandbox: danger-full-access, network_access: true}`. The existing shared
comparison returned `permission_ceiling_conflict`, logged
`runner: switch_session refused for lab-pc-1.issue405-switch: max_network_access=false is narrower than launch network_access=true`,
and left the original child alive (`kills=0`, one child). The exact command
`pnpm exec vitest run test/issue405-switch-baseline-probe.test.ts` exited `0`
with `1` test passing. The temporary test file was removed after measurement.
This is a local command-path measurement, not a live-agent observation.

The first attempted test command used `pnpm test -- test/issue405-probe.test.ts`
and ran the full runner suite instead of filtering to the probe. That baseline
run exited `1` because this fresh worktree did not yet have built wrapper
`dist` packages. After `pnpm -C wrapper build`, the isolated probe command
`pnpm exec vitest run test/issue405-probe.test.ts` exited `0` with both mode
refusals and the passing control above. The initial run is not evidence about a
code change; no source code had been changed.

The source audit found no other configured-versus-effective value transform on
the Antigravity axes checked by the runner: the wrapper reports `sandbox` and
`approval` from their selected values (`host.ts:399-400, 427-430`), while only
`network_access` passes through `effectiveNetworkAccess`. `model` and `effort`
are resume fields but are not permission-ceiling axes. Antigravity sandbox
being advisory is a separate enforcement property, not a value-basis split.

The affected running cohort is limited to the current runner generation where
the stored `max_network_access=false` was derived from an omitted launch
`network_access` and no explicit `antigravity.max_network_access` overrides it.
The server restore payload carries the persisted effective `resume_snapshot`
but no launch network field (`server/lib/kaoiro_server_web/channels/agents_channel.ex:2856-2880`);
the runner applies that snapshot before `#launchSpawn`
(`runner/src/supervisor.ts:767-785` and `runner/src/resume_snapshot.ts:221-245`).
On that restore, the effective snapshot value `true` becomes the new parsed
launch value and the implicit ceiling is re-pinned to `true`. An explicit
operator `max_network_access=false` remains a raw configured bound and still
rejects such a restore at spawn validation (`supervisor.ts:1304-1320`).

## Proposed decisions

### 1. Fix option

Adopt option 1: compare effective network values at the runner's resume-ceiling
boundary. Use the existing exported `effectiveNetworkAccess` helper from
`@kaoiro/antigravity` (`wrapper/antigravity/src/index.ts:22`) so the ceiling
and wrapper use the same mapping:

- `danger-full-access` → `true`;
- `read-only` → `false`;
- `workspace-write` → the configured network value.

For the resume comparison, derive the current effective value from the
snapshot-applied sandbox and network value, and derive the ceiling's effective
value from `max_sandbox` and `max_network_access`. Keep the stored configured
maxima, wrapper relay, and wire snapshot unchanged. A conflict remains
fail-closed when the snapshot would exceed the effective ceiling; reset never
silently clamps.

This deliberately allows the current effective network value to exceed the
raw advertised `max_network_access` in a full-access session. For example,
with `max_sandbox=danger-full-access` and raw `max_network_access=false`, the
effective network ceiling is `true`, so an effective snapshot with
`sandbox=workspace-write` and `network_access=true` passes the resume check.
The relaunched wrapper still receives and advertises raw
`max_network_access=false`; its existing startup path does not reject that
combination (the constructor checks `approval=on-failure` but not the ceiling
pair at `host.ts:559-563`; initial status builds the effective value and raw
advertisement at `host.ts:399-431`). The server and wrapper's live
permission-switch gates continue to reject a later request to set
`network_access=true` against that raw advertisement (`agents_channel.ex:2393-2470`,
`host.ts:887-888, 1024-1034`). This running-value/advertised-maximum mismatch is
accepted for this fix: full access already makes the effective value `true`,
and normalizing the relayed ceiling would change the operator's configured
maximum. No `max_*` value is rewritten.

Spawn and resume checks intentionally remain asymmetric. Spawn validation
(`supervisor.ts:1304-1320`) checks whether the operator's raw launch values
contradict raw configured maxima. Reset and `switch_session` validate a
wrapper-reported effective snapshot against the effective combination of the
stored sandbox and network maxima. This preserves spawn's role as input
consistency validation and makes resume checks compare values on the basis the
wrapper actually reports.

`#ceilingConflictAgainst` is shared by reset and `switch_session`, so this
comparison change also applies to the same resume snapshot boundary on
`switch_session`. The implementation and regression coverage should include
both callers; no wrapper file needs modification, which avoids the active
wrapper/engine-adapter work for issue #407.

Option 2 (carry configured network access separately in the resume snapshot) is
not selected. It would change snapshot production and relay across wrapper,
server, and runner while duplicating configuration the runner already owns;
it also creates a new protocol field with no need for this comparison.

Option 3 (rewrite an omitted launch value to `true` under
`danger-full-access`) is not selected. It only normalizes one spawn shape and
leaves the comparison wrong for other effective values derived from sandbox.
It also changes the launch value stored by the runner rather than aligning the
comparison's two bases.

### 2. Issue #397 recovery hint

Update the hint conditionally. If a reported network conflict accompanies a
current `sandbox=danger-full-access` conflict, explain that the sandbox pins
effective `network_access=true`; tell the operator to narrow `sandbox` to its
reported ceiling first, then narrow `network_access` only if it remains above
its ceiling. The new UI text will be Japanese, matching the existing dashboard.
Under a `read-only` ceiling, lowering the sandbox also makes the
effective network value false. Ordinary `workspace-write` network conflicts
continue to name `network_access` directly. With `max_sandbox=danger-full-access`,
the effective network ceiling is `true`, so this false conflict and its hint
will not be emitted.

### 3. Operator `/new` and `/clear`

The local runner measurement confirms both modes reach the same refusal. The
server sends the same `reset_session` shape with only `mode` varying, and the
runner's ceiling check is mode-independent. No live agent is needed for this
question, so the production runner/server remain untouched.

The before-change `switch_session` probe above confirms that this is not only a
shared-code inference: the issue snapshot is rejected through the handler before
the child is killed. Post-change coverage will include a positive issue-shape
switch and a negative control where `workspace-write` with
`network_access=false` is genuinely widened to `true`.

### 4. Other configured/effective splits

No other split was found among Antigravity's ceiling-checked permission values.
`sandbox` and `approval` are copied as selected; only network access is derived
from the sandbox. Model and effort do not participate in this ceiling. The
implementation will not expand the comparison to unrelated snapshot fields.

## Scope

In scope:

- runner effective-network comparison at the shared resume ceiling check;
- runner regression tests for reset modes `new` and `clear`, the shared
  `switch_session` caller, unchanged sandbox/approval conflicts, and a genuine
  `workspace-write` plus `network_access` widening;
- dashboard recovery text and tests for the pinned-network case;
- the documentation updates listed below.

Out of scope:

- changing resume snapshot shape, wrapper behavior, server relays, or protocol
  fields;
- changing runtime permission-switch maxima or spawn-time validation;
- deploying a release or completing issue #396's post-release live-agent test.
  Those are release operations; this work will not modify or restart production
  services. The measurement above does not require a live agent.

## Documentation updates

- `docs/reference/engines/antigravity-tools-permissions.md`: explain effective
  network ceiling derivation, raw maxima retained on relay, and the ordered
  recovery when full access pins the value.
- `docs/reference/security/enforcement-boundaries.md`: state that reset and
  switch snapshot checks compare effective network against the effective
  combined sandbox/network ceiling, while spawn validation and relayed maxima
  remain raw.
- `docs/adr/0057-antigravity-adapter.md`: add a dated addendum for issue #405 in
  the ADR's historical voice, including the intentional spawn/resume basis
  difference; do not rewrite its prior decision text.
- No protocol reference change is planned because message shape and error
  vocabulary remain unchanged.

## Validation plan

1. From the runner, import `effectiveNetworkAccess` from the existing runtime
   dependency `@kaoiro/antigravity` and pin all six sandbox/network combinations:

   | sandbox | configured `false` | configured `true` |
   | --- | --- | --- |
   | `danger-full-access` | `true` | `true` |
   | `read-only` | `false` | `false` |
   | `workspace-write` | `false` | `true` |

   This also makes upstream mapping changes visible in runner CI. Retain a true
   widening conflict when the effective ceiling is `false`.
2. In the supervisor harness, assert that reset `new` and `clear` with the
   issue snapshot no longer refuse, and that `switch_session` accepts the same
   issue snapshot and relaunches after the old child exits. For each command,
   retain a negative control where a real `workspace-write` /
   `network_access=false` ceiling is widened to `true`; it must refuse before
   the old child is killed. Preserve existing sandbox/approval conflict
   behavior. The pre-change switch refusal is evidenced above.
3. Test the dashboard hint for both the pinned full-access case and the normal
   workspace-write network conflict. The Japanese hint must not claim that
   changing `network_access` alone can override full access; it must direct the
   operator to lower `sandbox` first when both axes conflict.
4. Mutation-check the new comparison and dashboard condition: temporarily
   remove the effective normalization / disconnect the hint branch, run the
   matching tests and capture the red output, restore the code, then capture
   green output. Also keep the real-widening control red against refusal so the
   guard remains pinned.
5. Run `pnpm -C wrapper build` before runner validation because runner resolves
   wrapper packages from `dist`. Then run runner typecheck, build, and full test
   suite; run dashboard check, build, and full test suite because its UI is
   touched. Report each command's exit code and unhandled errors/warnings
   separately from pass counts. No server or wrapper source changes are planned.
