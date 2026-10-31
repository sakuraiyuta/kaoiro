---
title: Codex U2 fresh migration — native 0.164.0
status: measured
last_updated: 2026-10-31
---

# Codex U2 fresh migration — native 0.164.0

Measurement for [issue #564](https://github.com/sakuraiyuta/kaoiro/issues/564).
Product commit: `af4a41545a2df0d4e9d8a951b7cf7cf840d8c5a7`.
Native SHA-256:
`b93f6811d3f653f0fb83be4050d857fb9abbb111dfa2ce160563327daff7f306`.
The [structured record](u2-fresh-migration-0.164.0-2026-10-31.json)
contains the measured outcomes and source identities. This is acceptance evidence,
not a deployment record. Follow the [operator runbook](../../operations/codex-backend-switch.md).

## Actual components and fixture boundaries

The isolated Linux run built the production release, runner and wrapper from the
commit. It used the normal launcher, backend factories, loopback Responses
provider, synthetic credentials, real RPC and operator WebSocket. All 15 declared
DETS stores were relocated into disposable storage and checked against open DETS
files. The workflow used its default readers, writer and credential adapter;
only the command boundary mapped systemctl/journalctl to the actual runner PID
and captured stdout, and container RPC to the actual release RPC. This does not
measure real systemd, journald or a production container deployment.

The model provider emitted a local tool call followed by a final response. Native
turns were counted at exec launch or app-server `turn/start`, separately from HTTP
requests and wrapper launches. No real account or billed model service was used.

## Measured migration behavior

| Acceptance | Observation |
| --- | --- |
| A/B/C | Existing exec IDs continued before migration; reset/stop detached pointers while retaining policy and history. |
| D/E | A peer turn or another non-fresh sibling prevented remove-pin. |
| G | Explicit exec was removed only at the fresh boundary. App-server restore used no resume ID and produced a new native ID with policy and snapshot retained. |
| K | A failed fresh launch left the target detached. Same-backend restore succeeded while a sibling remained live; backend change was refused. |
| J | With explicit app-server selection applied before activating old code, both existing app-server IDs continued on `7dab1d857f203d9f25021a37b866394c383df7bf` with the same native hash. Prior history reached the next request. |
| M | Reset failure rollback and peer input preserved the non-fresh refusal. Unavailable pointer storage prevented mutation. |
| L | Fresh exec selection and restores produced new IDs without app-server resume. |
| N | An archived non-nil pointer prevented restore-fresh. This is not a new guard on ordinary restore APIs. |

The old omitted-backend target was rejected by the procedural offline loader
check; the measurement does not claim an automatic product rollback gate.
Viewer credentials and a token revoked after join did not authorize restore.
Registry generation failure reached the workflow as a refusal.

The main route used 13 native turns. A separate omitted-backend run used two
turns: one live app-server sibling retained its entire observed state and child
entry while a stopped fresh target was restored and acquired a distinct ID.
Changing the backend was refused with both present. The new monotonic progress
checks did not reject these normal joins. This is finite evidence, not proof that
all future joins have the same transition order.

## Observation fixture

The permanent observation fixture used four exec turns across the candidate and
old runner `c8f75a35be90f683983db9857d32fc9276bd0f53`, retaining each
session ID across its two tool turns. The old reader timed out and was refused.
For both normal and killed registry partitions, the old VM exited and its PID
was absent. Immediately after the new VM became ready, observation returned
`ambiguous_runner`; registration then changed from false to true and observation
recovered with the original runner instance and child. The fixture pauses the
runner only after it has observed the old VM socket close; this preserves the
existing measurement procedure and is not a transport reconnect fix.

Removing `mint_wrapper_token` from the fixture's spawn preparation caused
`unauthorized`, no native turn, and fixture failure. Restoring it passed the
four-turn run with authentication enabled. All observed processes exited.
This fixture was not traced for network connects; the network counts below
cover only the separate migration and sibling runs.

## Deterministic checks and limits

The workflow/operator/compatibility suites passed 195 tests before and after 87
independent mutations. Forty units covered restore comparisons, stability,
deadline and strict pre-action reads; 47 retained the record, workflow and
credential checks. Each mutation made its corresponding test fail. The unit
count is a finite acceptance inventory, not all AST operands. In particular,
runner host/revision validity is tested at the shared input validator.

Reverse connected, pointer and live transitions were tested within one bundle
and across bundles. A bundle that completed after the deadline was rejected even
when otherwise stable. These tests fix the decision rules; they do not substitute
for the real lifecycle measurements above.

Network connect traces for the main route and sibling run contained 49 and 8
AF_INET-family records respectively, all loopback. Empty traces and a non-loopback
address were rejected by the measurement checker. The runs removed their scratch
state after completion. Production authentication, external model behavior,
packaged deployment, other native pins and cross-backend session resume were not
measured by this record. U2 and C4C still require adjacent release integration.

All three native commands exited 0. Build preparation emitted dependency/compiler
warnings; the observation driver also emitted an Elixir locale warning. Native
assertions completed without unhandled errors. These warnings are retained in
the implementation review record rather than described as warning-free runs.
