---
title: Claude launch capability prerequisites
status: measured
last_updated: 2026-10-16
---

# Claude launch capability prerequisites

These are bounded **preimplementation** observations for
[issue #426](https://github.com/sakuraiyuta/kaoiro/issues/426) and
[issue #674](https://github.com/sakuraiyuta/kaoiro/issues/674). They informed the
[accepted design](../../plans/issue-426-stage2-native-continuations.md).
They do not establish that the final product admits or rejects a send correctly.

The description-only, resumption and permission measurements used baseline
`fed60d78c1031dc48b72f1d1e780c829911d9080`, Claude CLI `2.1.293` and Agent SDK
`0.3.293`. The production `runClaudeCli → AgentHost → SDK` composition ran against
an isolated real server and scripted loopback model endpoint. Provider model calls
were zero. Native callbacks, accepted inputs and task frames were observed.

The Monitor measurements used an isolated feature-cache condition that exposed
Monitor. The public WebSocket input was observed in that exposed schema; no
additional WebSocket variant was enabled. This is not evidence that an arbitrary
production installation advertises Monitor by default.

## Transport and lifecycle

| Measurement | Observation | Limit |
| --- | --- | --- |
| Native execution identity | The inspected SDK/CLI surfaces did not expose the required current-execution join for hand-back and Monitor reports; inspecting SDK `0.3.301` did not repair that premise | A wrapper-issued capability replaces that missing join under the accepted trust boundary; it does not discover a native run key |
| Rejected command wrapper | Wrapping a refused Monitor command changed native deny into an approvable broker ask; the command executed only after that approval | The command/helper-wrapper strategy was rejected, not repaired with a permission parser |
| Description-only command Monitor (E6) | Two events, a completion containing the final event, and an expiry reached four independent native root inputs with the description marker | Transport and native provenance, not product admission or requester receipt |
| First-send transcript visibility (E6) | All four rows were absent on the first poll and became readable while the hook waited, after approximately 57–60 ms | Four observations, not a latency guarantee; the product uses one bounded acquisition budget |
| Canonical SendMessage (E7) | An inactive local Agent resumed under the same task ID, a new run and the SendMessage call ID; the rewritten canonical message reached the new child and report | Historical `content` remained a preview; it was not synchronized or used as authority |
| TaskStop ordering (E7) | Matching stopped frames preceded successful TaskStop results; an already-produced marked Monitor event still arrived later | Stopping a producer is not a delivery barrier |
| Public WebSocket (E9) | Two text events and normal close carried the marked description; task type was `monitor_ws`; the close root and result omitted `producer` | The marker was a prefix in this probe; final suffix encoding, first-send timing and error/binary/expiry/re-arm schedules require product acceptance |
| Natural WebSocket termination (E9) | Native status `stopped` occurred before queued event and close inputs | Raw `stopped` does not distinguish deliberate cancellation from natural close |

The pinned WebSocket launch uses a `ws` object containing its URL and options.
Its `task_started` does not require an `is_backgrounded` field. A command Monitor
uses `local_bash`; these sources must remain classified separately from Bash.
The native formatter escapes ampersand, less-than and greater-than once. Parsing
must preserve escaped block-looking event text as payload.

## Permission boundary

The permission controls preserved the wrapper's default allowed tools. They used
an inspected permission configuration with no Agent-prompt, Monitor-description
or SendMessage-message/content-sensitive rule. Relevant explicit rules were added
only to the isolated controls. The broker used its actual resolution path with
scripted operator decisions; no browser interaction or real-model classifier
invariance is claimed.

| Control | Result |
| --- | --- |
| Description-only command deny (E6) | Denial remained; no broker request or execution |
| Whole-Agent ask in default mode (E7) | Both original and rewritten calls reached the broker |
| Typed Agent ask (E7) | Neither original nor rewritten call asked; this was not a positive ask control |
| Whole-Agent ask in auto mode (E9) | Both original and rewritten calls reached the broker |
| Independent Agent rejecting hook (E9) | Both calls were rejected without launch |
| Monitor auto allow/deny/ask/independent hook (E9) | Tested outcomes were retained; the allow pair produced exactly two execution marks |
| Whole-Agent deny (E9) | Agent disappeared from the advertised tools; the fixture stopped before either invocation. The before/after comparison remains unmeasured |

Independent SDK hooks saw original input even when registered after an updater.
Their registration order does not prove that they inspect effective rewritten
bytes. The issuer must validate its planned change and separately join actual
accepted input, native task/call/run evidence and successful outcome.

The design's bounded disposition for whole-Agent deny combines observed tool
exclusion with unchanged tool names, availability, permission selectors and
allowed tools. It does not relabel the failed live comparison as green. Typed
deny evidence remains separate. A changed content-sensitive policy requires new
applicable checks before enabling the feature.

E7 used seven SDK queries and E9 used eight. Both exhausted their allocations;
failed fixture attempts remained counted. Their post-hoc measurement checkers
were exercised with negative copied evidence and restored results. Those checkers
were not product authorization gates.

## Remaining acceptance

Real-model marker obedience, authenticated content, universal bearer-copy/replay
prevention, every possible WebSocket schedule, arbitrary hooks and deployment
settings are outside these measurements. The final implementation must satisfy
P0–P9 in the accepted plan with target and verifier hashes, actual send attempts,
server acceptance, requester receipt, negative controls, mutation results and
full affected test suites. No production enablement follows from this page.
