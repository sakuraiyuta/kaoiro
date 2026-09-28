---
title: Claude CLI 2.1.284 delivery remeasurement
description: Loopback observations of the 1M model suffix and native delivery boundaries after the SDK bump.
status: measured
last_updated: 2026-09-29
---

# Claude CLI 2.1.284 delivery remeasurement

## Scope and verdicts

This is the first measurement batch for [issue #427](https://github.com/sakuraiyuta/kaoiro/issues/427),
fixed to `69a474526b2dfe538aa14be8aa8a5b703c00da1d`. It measures the installed
SDK/CLI mechanism, not the later host validation changes. E5, the default
wrapper/server composition, and production-settings R3 are measured separately
in the second batch below, against the rebased host changes. No phase-2 enablement decision follows
from this report alone.

| Premise | Verdict | Boundary |
| --- | --- | --- |
| `opus[1m]` becomes an explicit 1M request indication | established | Context header captured by the loopback HTTP endpoint |
| E1: fold input, including ticket bytes, reaches the next model request | established | Byte-contiguous containment inside a CLI wrapper |
| E2: fold hook body and live prompt identity match | established | Exact body and same root prompt/session IDs |
| E3: tool-free live-turn input becomes a new root prompt after result | established | Fresh ID, two native result frames |
| E4: priority `now` finishes after the running tool, then starts a new root | established | Tool marker, old result, fresh hook, next result |
| E5 / production-settings R3 | established | Second batch below; bounded observed schedules |

## Artifact binding

A dedicated detached worktree was built in dependency order (protocol
typecheck, core, agent-common, Claude). All preparation commands exited 0.
The installed SDK is 0.3.284, its bundled Linux x64 CLI reports 2.1.284.

- SDK `sdk.mjs`: `32d062c37b03e10870fbf839f54694545ee01bc0ec719e47078fbed76e30ef71`.
- Bundled CLI: `5cd90aabd83f8a15136c35aa37bb1d92b348993573316643dc3fe4e04afbf88f`.
- Built host: `6b0458db84993d58c46d7f4a0e389d8817e6eb42159be3b1a9a16294dbe9ec75`.
- Built CLI entry: `00bf0e9c824cd632f3bedb79de8792e09ef892b862b00b568e938161b1e7fb70`.

The lockfile SDK integrity is
`sha512-NSoJwEq6nFSf8dtaacYx37QdGgqApI3eHFUlxclMLYi8irb6ZJwEaUnPnLUCyAyg9W/tMkgZC0GXWLRCc01I0w==`.
Raw records live under `tmp/reviews/issue-427/native-batch1/`; `artifacts.json`
binds source/build/SDK/CLI bytes. The final manifest also binds probes,
checkers, raw requests and event logs.

## Model request comparison

The reference is the HTTP endpoint's capture of the actual request. The
prediction is the supplied SDK `options.model`; no model response is used as
proof of its own configuration. Each run uses a fresh scratch HOME and config,
`settingSources:[]`, a fixed text response, and a real SDK `query()`.

| Run | SDK model | Control | Request model | `context-1m-2025-08-07` |
| --- | --- | --- | --- | --- |
| M1 | `opus[1m]` | none | `claude-opus-5-5` | present |
| M2 | `opus` | none | `claude-opus-5-5` | absent |
| M3 | `opus[1m]` | `CLAUDE_CODE_DISABLE_1M_CONTEXT=1` | `opus` | absent |

Observed: M1 and M2 differ by the context beta in `anthropic-beta`, while both
strip the suffix and resolve to the same model string. M3 removes that beta,
but also changes alias resolution and omits `per-turn-control-2026-07-01`;
it is a CLI environment control, not an assertion that disabling 1M changes
only one header. Full sanitized headers and bodies are retained.

Inferred: the explicit suffix is not lost before the provider request boundary
in this configuration. No real provider was called, so actual capacity,
entitlement, token limits, model availability and provider acceptance remain
outside this result. These measurements do not establish any Sonnet native
context-window capacity.

## Delivery reference versus hook prediction

The retained E1-E4 driver is used with new build imports, output directory and
budget accounting. Its one native-input seam is unchanged byte-for-byte;
host admission, origin and settlement guards are unchanged. The endpoint
captures requests independently of the hook recorder. The wrapper's normal
entry function composes the real host; the server link is a local recorder.
These are mechanism measurements, not E5 default composition tests.

| Run | Schedule | Reference | Hook/result observation |
| --- | --- | --- | --- |
| B1 | Bash boundary without injected input | No `E_INPUT_` in either request | One initial root hook, one result |
| F1 | Inject while a one-second Bash runs | Request 2 includes the full payload bytes | Same prompt/session ID, exact hook text, one result |
| T1 | Inject while the first tool-free response is held | Request 2 includes the full payload bytes | Fresh prompt ID 4 ms after result 0, then result 1 |
| P1 | Inject with `priority:now` while Bash runs | Request 2 includes the full payload bytes | Tool completes before result 0; fresh hook 7 ms later, then result 1 |

The fold payload remains inside `tool_result.content` in a `<system-reminder>`.
`fold-wrapper-example.txt` preserves the entire UTF-8 wrapper, including the
synthetic ticket. The wrapper text matches the 2.1.280 F1 reference after only
substituting the unique payload. The prior T1/P1 gaps were 5/6 ms; the new gaps
are 4/7 ms. These single observations are not latency distributions and do not
replace production-settings R3. No change in the measured E1-E4 relationships
was observed.

The checker asserts against raw requests and hooks, not a self-authored
expected hook fixture. Six independent in-memory defects (missing 1M header,
changed payload, changed ticket, wrong fold ID, reused T1 ID, tool completion
after P1 result) each produce exit 1; unchanged raw data produces exit 0.
B1 is the native no-input control. Raw records are not edited by controls.

## Isolation and limits

All model URLs are loopback, with a clean child environment, dummy credential,
isolated HOME/config/cwd, no inherited real credentials, disabled telemetry,
update and nonessential traffic, and explicit alternate-provider flags off.
The process launcher preserves the selected CLI and records its command.
Only owned SDK child processes and loopback listeners are started or closed.
The sanitized HTTP recorder omits credential headers. No production server,
runner, peer process or real provider is used.

Each root run is bounded to five minutes and 20 model requests; the batch
budget records every SDK launch, including unsuccessful measurements. The
hand-back subsection/report records its separate candidate and control runs.

## Hand-back scope

See the [separate shape record](../issue-426/2026-09-29-cli-2-1-284-shapes.md).
The hand-back shape remains **unmeasured** after the five-run allowance. Task
notification identity and result kind were observed in the streaming host
composition. The absence of hand-back in sanitized queries also occurred in
the retained 0.3.280 sanitized record; it is not treated as a version regression.
The director's decision keeps [issue #426](https://github.com/sakuraiyuta/kaoiro/issues/426) admission frozen and fail-closed;
the planned canary does not rely on establishing a hand-back positive case.
This records that decision, not a new safety certification from these probes.

## Schedule, controls and cleanup

The complete batch used **12 of 16 root SDK runs**: model 3/3, delivery 4/8,
hand-back 5/5. It issued **43 model requests**. Every invocation exited 0,
including H1/H1r where the requested hand-back observation was unavailable;
process success is not a positive hand-back verdict. No run exceeded 20
requests or four child Agents. Per-run values are copied from captured output:

| Run | Model requests | Run duration (ms) | Outcome |
| --- | --- | --- | --- |
| M1 | 1 | 843 | 1M header observed |
| M2 | 1 | 836 | Unsuffixed control |
| M3 | 1 | 871 | Disable-1M control |
| B1 | 2 | 2291 | No-injection control |
| F1 | 2 | 4068 | Fold |
| T1 | 2 | 1407 | Tool-free re-prompt |
| P1 | 2 | 2259 | Priority-now re-prompt |
| H1 | 5 | 2455 | Restricted sanitized hand-back attempt unavailable |
| H1r | 5 | 2450 | Unrestricted-tools sanitized attempt unavailable |
| N1 | 5 | 3745 | One-Agent streaming notification; no hand-back |
| N2 | 14 | 5929 | Four-Agent streaming notifications; no hand-back |
| N3 | 3 | 2268 | Background Bash notification control |

The SDK window was **623.087 seconds**, from 2026-09-28 20:28:00.002Z to
20:38:23.089Z, including the waits for two approved composition changes.
Sum of run durations: **29422 ms**. Native-run budgets and time accounting are
in `budget.json` and `schedule.json`.

All six delivery/model checker negative controls exited **1**, restoration
exited **0**. The notification identity control also exited **1**, restoration
**0**. The initial H1 raw and both sanitized probe versions are retained;
`handback-probe-change.json` records the approved change. The separate
streaming probe is also hash-bound. No frozen source guard was changed.

All SDK children had exited (zero remaining in each finished record), local
listeners were closed, and the dedicated build worktree was removed. Eight
CLI task-output roots named for this worktree's scratch cwd were removed.
No retained transcript file existed at the observed transcript paths
(`persistSession:false`); full SDK frame/hook/request logs are retained.
The old evidence and peer worktrees were only read. Cleanup is recorded in
`cleanup.json`; only evidence, probes and checkers remain.

The evidence manifest binds **87 files**, SHA-256:
`ec0405de385ca546f93bbf7f8c5628957cd8ca1f6c6d7af38e27e6bddbd19ac3`.

## Second batch: default composition and production-settings R3

The second batch is fixed to `5c6f49b5690b74228bbac6b7d101ad4432f879fc`,
rebased onto `21bd0ee0`, including the persona allowlist from issue #441.
It uses the real `runClaudeCli` entry, real AgentHost and SDK, and a separate
local Phoenix server with isolated persistence. No wrapper injection or input
seam is present. The server-only observation delta records join inputs/replies
and inbound wire events; the E5 negative control removes capability keys from
one root's join. No admission or settlement guard is changed.

Dependency-order builds and protocol typecheck exited 0. Source, build, SDK,
CLI, probes, checkers and server delta are pinned in
`tmp/reviews/issue-427/native-batch2/frozen-artifacts.json`, SHA-256
`ebe45e291d41709acdc0eb6dff7f913835586df9be3d99b32e333c6e77b88fe6`.
All 256 frozen files matched after measurement. SDK and bundled CLI hashes
remain those listed above. The final built host hash is
`c65ba67dd6ac24368d053e892850532a0e4326a05d2c510fe2b476e26e81f007`;
the CLI entry, now including the persona allowlist, is
`65e909beb0b87e472d90b8d8738c03029a47e546350f6cbb19ff35e4ea9b7e80`.
The raw evidence manifest contains 191 files with zero mismatches:
`tmp/reviews/issue-427/native-batch2/manifest.json`, SHA-256
`a31329261bb5d655096102c7dcf2d95781da0493d28ba91620344a84ed3fd002`.

### Reference versus prediction

The loopback endpoint independently captures actual model requests. Predictions
are the configured capability/flag and the scheduled early input. References
are the server's observed join, delivery ledger and wire reports, plus the
native transcript. Neither scripted text responses nor an expected fixture
establish the handoff or terminal boundary.

| Run | Schedule / control | Observed result | Requests | Result-to-submitted gap |
| --- | --- | --- | --- | --- |
| E5 P1 | Default composition; flag and PERSONAS absent | Phase 1 advertisement; accepted, queued, submitted, settled | 1 | Not applicable |
| E5 P2 | Repeat default composition | Same stages, correct incarnation/generation, dispatch ACK | 1 | Not applicable |
| E5 N1 | Capability keys removed from root join | Accepted only; no wrapper stage reports | 1 | Not applicable |
| R3 T1 | Early input during held tool-free response | Fresh root after old result, receipt submitted, settled | 2 | 6 ms |
| R3 T2 | Repeat T1 | Same | 2 | 7 ms |
| R3 T3 | Repeat T1 | Same | 2 | 7 ms |
| R3 T4 | Repeat T1 | Same | 2 | 6 ms |
| R3 F1 | Early input during one-second Bash | fold_hook submission; one terminal | 2 | Not applicable |
| R3 F2 | Repeat F1 | Same | 2 | Not applicable |
| R3 N1 | Flag off; PERSONAS absent | Early request downgraded to normal; no receipt text; two ordinary roots | 2 | 20 ms |

E5's original join advertises `early:none`, `yield:none`, `stage_reports:true`
and `work_control:v1`. P1/P2 negotiate them and reach `prompt_hook` submission
on the first turn. N1 still advertises them, but the negative server composition
drops negotiation and observes only server acceptance. No ticket is used, so
`included` is correctly absent. Both allowlist and global flag are absent in
all E5 runs. **E5 is established**, including the issue #441 default-off
composition contract.

R3's positive runs set `KAOIRO_CLAUDE_PHASE2_DELIVERY=1`; N1 sets it to `0`.
The tool-free positive gaps have minimum 6 ms and maximum 7 ms. They measure
wrapper result-envelope `ts` to wrapper submitted-stage `at`, not network
arrival time or the beginning of SDK result handling. Each native transcript
has distinct root prompt IDs and two results. Both fold controls retain one
terminal and submit at `fold_hook`. No unknown stage or root-hook timeout is
observed. These findings match the prior 2.1.280 relationships; its three
production-settings root gaps were 7, 6 and 8 ms.

**R3 is established for these schedules:** the measured gaps are well below
the 2,000 ms default. Inferred: these observations support retaining that
value for this measured configuration. They do not bound all settings hooks,
host loads or future CLI releases, and are not a latency percentile estimate.

### Settings, controls and cleanup

R3 reads the operator's real HOME and settings. The settings and all 14 audited
hook files exactly match the previously approved R3 bytes; see
[the settings inventory](2026-09-28-claude-fold-measurements.md#production-settings-and-side-effects).
The loaded configuration includes SessionStart date/worklog/model-profile,
UserPromptSubmit reminder/model-profile, Bash guards, write/Skill guards,
Stop validation and SessionEnd usage logging. Stop-hook summaries in every R3
native transcript independently confirm `stop-validate.sh`. The enabled
Context7, rust-analyzer-lsp and cli-anything cache trees expose no extra hook
files. Plugin configuration does not prove a successful connection.

The only output-location difference is `USAGE_LOG_PATH` pointing into scratch.
Loopback responses contain text or the bounded Bash command only. Native
transcripts contain two Bash tool uses total and zero Skill calls. Existing
settings/hook bytes remain unchanged. E5 instead uses isolated HOME/config.
All invocations run inside loopback-only network/PID namespaces with explicit
dummy credentials and no external route; no shared server or peer process is
used. Each invocation has a five-minute timeout and a 20-request cap.

The three checker controls independently alter phase-1 advertisement,
submitted-stage presence and the root delay in temporary copies. Each exits 1;
restoring the original data exits 0. Raw logs remain unchanged. Native E5 N1
and R3 N1 supply the capability and flag-off controls respectively.

There were 10 root SDK runs out of the 10-run allowance, 17 model requests,
and a 96.455-second SDK window (2026-09-28 21:27:03.116 through 21:28:39.571
UTC). Before the first wrapper launch, two preparation invocations failed
because the scratch MIX_HOME lacked Hex; they made zero SDK/model calls.
The second attempt followed an incorrect local archive-path assumption. The
installed Elixir 1.20.1 Hex archives were then copied into scratch without
changing the probe. Both failed logs are retained under E5/setup-no-hex*.

All ten probe invocations and checkers exited 0. Every wrapper exited 0.
Eight server observers exited 1 during requested shutdown because their read
loop outlived DeliveryStates; the other two exited 0. These errors followed
completed observations, and are retained rather than reported as clean server
exits. All owned descendants are gone. Only measured-session markers,
project/session-env directories and owned task-output roots were removed;
the shared marker cache is byte/mtime-identical to its pre-run snapshot.
Any additive history entries were left untouched. The dedicated worktree,
builds and isolated persistence were removed. Evidence under
`tmp/reviews/issue-427/native-batch2/` is intentionally retained.
