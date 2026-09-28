---
title: Claude phase-2 prerequisite measurements E1–E5 and R3 timing
description: Native loopback measurements of fold delivery, prompt identity, priority now, default-wrapper stage reporting, and production-settings receipt-root timing.
status: measured
last_updated: 2026-09-29
---

# Claude phase-2 prerequisite measurements

## Decision output

For the pinned SDK 0.3.280 / native CLI 2.1.280 and the schedules below:

| Premise | Result | Evidence and limit |
| --- | --- | --- |
| E1: live input reaches the next model request verbatim, ticket included | **Established for the measured running-Bash fold** | F1 and F2 request 2 contain the complete pushed UTF-8 text as a contiguous byte sequence inside `tool_result.content`. The surrounding block is not equal to the input. |
| E2: fold hook text and live-owner prompt ID match | **Established for the measured fold** | F1 and F2 hook text is byte-identical without normalization; each hook has the initial root prompt ID and arrives before that turn's terminal. |
| E3: input queued before a tool-free turn ends starts a new root prompt | **Established for the measured text-only completion** | T1 pushes while request 1 is held; the original result precedes the new UserPromptSubmit, which has a different prompt ID; request 2 contains the input. |
| E4: `priority: now` waits for the running tool, ends the turn once, and starts the input as a new turn | **Established for the measured running Bash** | P1's tool end marker precedes result index 0; a different prompt ID and request 2 follow; result index 1 ends that new turn. |
| E5: default wrapper negotiation and first-turn stage reports | **Established for the measured ordinary first turn** | E5/P1 and E5/P2 use the unmodified default wrapper with a real local server; accepted, queued, submitted (`prompt_hook`) and settled are recorded. E5/N1 disables negotiation and suppresses wrapper stages while retaining native completion and dispatch ACK. See the separate E5 measurement below. |
| E6: generic production input-to-model-request correlation | **Unmeasured** | Request capture is an independent reference, not a field exposed to the production host. No generic epoch/correlation claim is made. |
| R3/S1: receipt-root delay with production settings | **Established for the measured tool-free schedule** | Three phase-2 runs on `c658b69f` measured 7, 6 and 8 ms from wrapper result emission to submitted (`prompt_hook`), with real operator settings loaded. See the separate R3 measurement below for the clock definition and limits. |

No measured premise was refuted. These are native mechanics measured against a scripted local model, not guarantees for every engine schedule or evidence of model comprehension. In particular, no result authorizes removal of existing admission/terminal guards or proves that a fresh SDK prompt has a send-capable wrapper owner.

Owner: Kogane; decision owner: Kohaku. Authorization: issue [433](https://github.com/sakuraiyuta/kaoiro/issues/433), conversation `99b61b22-7fbf-4d3e-b308-bc762bba7eca`, including turn 4's checker-only correction. The design baseline is `01f6467ee2bb6f13d5ead7e4b2dd81b6fd40fb26`, [phase-2 measurements](../../plans/issue-429-delivery-authority-protocol.md#required-phase-2-measurements), with [ADR-0063](../../adr/0063-layered-delivery-authority-and-continuations.md) D6–D8 retained.

## Composition, isolation, and artifacts

The probe enters the freshly built `runClaudeCli`, which constructs the real AgentHost, InterAgentTool, MCP server and production origin/settlement callbacks. A recording ServerLink supplies the local persona and reply-basis negotiation; it connects to no kaoiro server. Host lifecycle callbacks and SDK frames are observed and forwarded unchanged. A scratch-only Query input iterator merges the extra user message without replacing the active host owner. No origin, grammar, admission or settlement guard is changed. Query options restrict tools to one scripted Bash command; it writes two scratch timing markers around `sleep 1`. No Agent child is launched and no inter-agent send is requested.

Each invocation runs in a fresh user/network/PID namespace with only loopback enabled and no external route. A nested user namespace supplies UID/GID 1000. The child environment is an allowlist with an isolated config directory and a dummy local API key; real credentials and provider endpoints are not inherited. The outer PID namespace bounds descendant lifetime. Model responses are scripted Anthropic Messages SSE, not real API responses or spend. Request bodies are captured independently at the loopback endpoint; the response script does not use the proposed hook-ID predictor to decide whether an input was included.

Dedicated worktree/build path: `/home/yuta/git/kaoiro/worktrees/kogane-433`, fixed at the baseline before the report commit. Offline frozen-lockfile install, protocol typecheck, and core → agent-common → claude-code builds each exited 0. Shared source/dist and peer worktrees were untouched. Protocol is type-only and has no build output. The probe used only this dependency-order build, avoiding the shared-dist drift documented by I3/issue 428.

Retained host evidence directory: `/home/yuta/git/kaoiro/tmp/reviews/issue-429/e/`.

| Binding | SHA-256 |
| --- | --- |
| `manifest-v2.json` — 209 source/build/probe/SDK/CLI hashes | `a8872ce6abcfe9845ae2abb935ca175b751eed5211599a02619e84b2c3ef39a3` |
| `run-manifest.json` — 57 retained evidence-file hashes | `eae62051052064844b9325ca489e2de81812020041c010a14cd379b1ad28b47e` |
| `probe.mjs` | `4e9bd908b640ea735cf84fda11d0580654ef3bafa0ead847672a16771b78f983` |
| `seam.mjs` — the sole input-routing delta | `bbf7827080ff04116423b8789b374a719d353ff309a75dcffb6fd671ce4d7c54` |
| Final `checker.mjs` | `8ea967aeff415514e4ef8b6f71e96fdc23ad20aaec76f03d997cf9ebb98377f9` |
| Built `claude-code/dist/cli.js` | `00daf7dca9da209c99a0dfd64458b3bf1fb3b5ca5c22a6835e33ba245576ba5c` |
| Built `claude-code/dist/host.js` | `d91b139b1f6932b94c2fcc18c7713078b513b8ee9db597a36cdfdde2ffdcb861` |
| Installed `sdk.mjs` | `ef4c2c0fc286d8c7dab7771516cf95206f9f670e99e74dc62f245b7fc8224955` |
| Executed Linux x64 native CLI | `1e08503dbdf3c2cb0d706d32f3408277388d1c76ef108673e8fe42c1b322925b` |

Node: `/home/yuta/.asdf/installs/nodejs/24.3.0/bin/node`, v24.3.0, also content-bound in the manifest. Every native init reports CLI 2.1.280; the actual spawned binary path is recorded per run. `manifest-verification.json` records 209 comparisons and zero mismatches before cleanup. Frozen probe/seam/product outputs were unchanged throughout; only the explicitly approved checker correction occurred.

## Schedule, counts, and timing

**8/12 budget slots used: five native SDK runs and three offline negative-control slots.** The offline slots are conservatively counted, though they start no SDK. Ten model requests total; zero child Agents. The SDK window was `2026-09-28T03:33:53.518Z` to `03:37:03.392Z`: **189.874 seconds (3 min 9.874 s)**, including the checker-approval pause. Each run was below five minutes and used two requests, well below its 20-request cap. Preparation/build time is outside this SDK window.

| Run | Schedule | Requests / results | Duration (ms) | Invocation / checker exit |
| --- | --- | --- | ---: | --- |
| B0 | Ordinary root input, one Bash tool, no extra input | 2 / 1 | 2183 | 0 / 0 |
| F1 | Push input after Bash start marker, without priority | 2 / 1 | 6128 | 0 / 0 |
| T1 | Hold first text-only response, push input, then let the turn finish without any tool | 2 / 2 | 1445 | 0 / 0 |
| P1 | Push with `priority: now` after Bash start marker | 2 / 2 | 2225 | 0 / 0 |
| F2 | Unchanged repetition of F1 after the checker correction | 2 / 1 | 6058 | 0 / 0 |

Counts come from `schedule-counts.json`, `budget.json` and each run's final event, not inferred from test names. Each owned CLI exited 0; each final record reports zero live owned children. Each invocation emitted the expected `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` warning for bypassPermissions; production PreToolUse hooks remained active. No unhandled errors were reported. No product test suite is claimed: no product implementation changed.

## Reference versus prediction

The prediction uses native UserPromptSubmit text/IDs and lifecycle ordering. The reference is actual captured request content and native result/tool events. The endpoint's request number is never injected into the host as an ownership field. Exact raw records are `{run}.events.jsonl`, `{run}.requests.jsonl`, `{run}.responses.jsonl`; the collected comparison is `reference-vs-prediction.json`, all bound by the run manifest.

| Run | Production-visible observation | Independent reference / result |
| --- | --- | --- |
| F1 | Push 636 ms; exact-text hook 3726 ms, same prompt ID `f997c297-f3c1-4e2c-b22f-368a67d75eb8` as initial root | Request 1 lacks input; request 2 at 3747 ms contains it verbatim. Tool-end marker 3705 ms; sole result 3792 ms, index 0. |
| F2 | Push 2665 ms; exact-text hook 3677 ms, same initial prompt ID `9ab8450e-ee92-4506-a8d3-bd8c8ba5e139` | Request 1 lacks input; request 2 contains it verbatim; sole result 3728 ms, index 0. |
| T1 | Push 577 ms while response 1 is held; new exact-text hook 871 ms, ID `03560268-f462-46e4-8dda-6f5a93e1d761`, different from initial `59bee9a8-078c-47d5-b263-f91eea3c74e3` | Original result 866 ms, index 0, precedes new hook; request 2 at 892 ms includes input; second result 899 ms, index 1. No tool was emitted. |
| P1 | Push 611 ms during Bash; new exact-text hook 1628 ms, ID `cc19d673-ab64-4b7b-8ca4-2b9a79a9ef2e`, different from initial `d8cfabfc-74e4-4ee2-b226-3f47148c005b` | Tool-end marker 1610 ms precedes original result 1622 ms, index 0. Request 2 at 1653 ms includes input; its result 1691 ms, index 1. Both SDK results report success; the first has an empty result string. |

Bash markers are observed by a 5 ms polling loop; these are observation times, not exact CPU execution timestamps. The request/hook/result timings come from direct callbacks. E4 establishes ordering in this schedule, not a cancellation guarantee for arbitrary tools. T1/P1's second native prompt does not have a new wrapper `onTurnStart` in this unmodified host composition; its terminal callback has no turn token. No send from that prompt was attempted. Native re-prompting therefore must not be equated with completed phase-2 wrapper ownership support.

## Exact wrapping and checker correction

**Observed:** F1's next request carries the input inside `tool_result.content` in a `<system-reminder>` introduced by `The user sent a new message while you were working:`. A following paragraph describes it as a message surfaced within the running turn and asks that it be addressed while continuing. The original Unicode text, indentation, reply-authorization JSON and random ticket remain contiguous and unchanged inside that wrapping. No normalization is required for the hook text or contained input.

The full captured tool-result string, including the entire wrapping and following reminder, is retained as UTF-8 bytes in `F1.tool-result-content.txt`: **630 bytes**, SHA-256 `d9c43bbaf725f5e955ae4af6173aa92c52f0e3bd0ef9c1469a5fd4f7f9834acc`. It is also present in the immutable request capture. This is the full example, not a reconstructed template.

The original checker (`checker-v1.mjs`, SHA-256 `bc532d0952c90f575c8f12dbd3aa4a74bcfca5cd2b264e847d018924576de24b`) incorrectly used whole-block equality for E1. F1 request 2 was therefore classified **false**. Work paused for director approval; the revised checker tests contiguous UTF-8 byte inclusion inside text/content strings. Reanalysis of the unchanged F1 raw capture gives **true**; `F1.check-v1.json` preserves the old result. Hook equality still uses whole-text equality. F2 then repeated the native schedule under the corrected checker. Probe, seam, guard and schedule bytes did not change.

| Control | Exit | What it establishes |
| --- | ---: | --- |
| Change the expected original body marker while keeping the ticket | 1 | The mutated full input is not accepted as present in the actual F1 capture. |
| Change the expected ticket while keeping the rest of the body | 1 | A different ticket is not accepted as preserved. |
| Bypass the checker's byte-inclusion predicate | 1 | The self-test fails when the verifier always accepts a match. |
| Original checker logic restored: capture reanalysis and self-test | 0 | The unmutated final checker accepts the original and rejects the two altered expectations. |

`negative-controls.json` and the corresponding logs preserve the exit codes. These are verifier controls, not mutations of product admission guards. The script never sends the diagnostic ticket as real reply authority. The CLI's wrapping labels it as new user input; whether a real model interprets or follows that wording is **unmeasured**, since the provider responses here are scripted.

## Cleanup and follow-up

The native processes were bounded by the owned PID namespaces and all five invocation sessions exited. No shared process was signalled. The dedicated build worktree, dependencies, run cwd/config directories and generated outputs are removed after preserving the evidence report commit; `cleanup.json` in the host evidence directory records the final cleanup check. Raw logs, the frozen source/build manifests, scripts, full wrapping example and comparisons remain intentionally as the requested evidence. The probe and seam are not landed as product code.

The separate E5 measurement below completes the default-composition prerequisite. These E1–E4 observations may inform the issue-434 design, but that implementation still needs its actual native gates, default composition and call-authority checks. E6 remains unmeasured; fixed snapshots and explicit receipts remain the rule.

## E5: default-wrapper negotiation and first-turn reporting

**Established for the measured ordinary first turn; no refutation.** This is a separate measurement after issue 432 landed, authorized by conversation `514aca5c-96ec-4c4c-9c62-90fd25c79217`. Product baseline: `f38c73f7a5c3e337f20e1ac2bbf05949d098fe21`. The E1–E4 records, counts and manifests above are unchanged. E6 was not attempted.

### Default composition and observation boundary

The executable is the dependency-order-built `wrapper/claude-code/dist/cli.js`, launched normally with a config file and no initial prompt. Its default composition constructs the real ServerLink, AgentHost, SDK Query, MCP tools and stage reporter. **No wrapper source, Query options, callbacks, host factory or input seam is replaced or injected.** The config only supplies agent/persona identity, a loopback kaoiro URL and model `claude-sonnet-4-6`. Permission mode and tool setup follow production defaults. A local controller peer sends one ordinary inter-agent request after the root joins; this starts the first native turn. No tool or child Agent is scripted.

The server is a separate Phoenix application built from the same baseline, with all 13 persistence paths and persona cache isolated. A read-only observer samples WorkStore negotiation and DeliveryStates delivery/history APIs every 20 ms. Server join logging records advertised/effective capabilities and actual replies. The only server source delta is that logging plus a conditional removal of `inter_agent_delivery_modes` and `work_control` for E5/N1's target join. Positive runs retain both fields unchanged. Delivery, admission, stage validation and settlement guards are unchanged. This is server-side instrumentation and a negative control, not a replacement wrapper transport.

Each invocation owns a fresh loopback-only network/PID namespace, local server, controller, default wrapper and scripted model endpoint. Route/address snapshots are in its invocation log. The environment is allowlisted, credentials are replaced by a dummy local key, and SDK config/cwd/HOME are scratch paths. Captures retain request bodies, not authorization headers. No real provider API was used; the model reference is the actual HTTP body arriving at the loopback endpoint. The production server and other peers/runners were not used or signalled.

The default wrapper also starts its ordinary metadata/usage probes. Process polling observed eight native `--output-format stream-json` processes across the three invocations: three root sessions and at least five auxiliary initialization sessions. Polling can miss short-lived processes, so this is not a total spawn count. These auxiliary sessions generated no additional captured model requests. The budget/count below describes measured wrapper/root-turn scenarios, not every helper process. Bundled native `rg` invocations are not counted as SDK sessions.

### Artifacts and independent checks

Scratch build: `/home/yuta/git/kaoiro/worktrees/kogane-433-e5`. Offline frozen-lockfile install, protocol typecheck, core → agent-common → claude-code build, and local server compilation all exited 0. The instrumentation recompile also exited 0. Shared source/dist were untouched. SDK **0.3.280**, native CLI **2.1.280**, Node **v24.3.0**. Version comes from the actual native transcripts; `/proc` observations bind the executed CLI path to the hashed binary.

Retained evidence: `/home/yuta/git/kaoiro/tmp/reviews/issue-429/e/E5/`.

| Binding | SHA-256 |
| --- | --- |
| `manifest-final.json` — 364 source/build/tool/runtime entries | `55dbf557f48eb39ccdb8c49ca7da04b37aa5af2a20d85e73fc4ae0e99620c2e0` |
| `run-manifest.json` — 69 retained evidence files | `ceab31a20e73ebb5960cb87355456b498ac28eb370c5a02bf06b8df1df31c129` |
| `probe.mjs` | `00c165d833dcb1d47532c9f569b849d8aedb873049b7628b90d78a47d4ecc200` |
| `observer.exs` | `14128f367615788ceb871dacaf059701a099503b3102c7c7dd31284fc6ce4bf5` |
| `server-instrumentation.patch` | `85aebce4beb977c6a64f9f887e405cb9b2fb51f8766c0905d26aefd26ad7317b` |
| Final `check.py` | `bb525f96f5a0fdc1101f6eb9fbbe49ecd1a99e6f4571877c5b66336132d0d8d3` |
| Built `claude-code/dist/cli.js` | `fdc588669d99b4d1d3a1b316772a18bc6dfa7eeb3cff74505cfe60d4265979f6` |
| Built `claude-code/dist/host.js` | `d91b139b1f6932b94c2fcc18c7713078b513b8ee9db597a36cdfdde2ffdcb861` |
| Installed `sdk.mjs` | `ef4c2c0fc286d8c7dab7771516cf95206f9f670e99e74dc62f245b7fc8224955` |
| Executed native CLI | `1e08503dbdf3c2cb0d706d32f3408277388d1c76ef108673e8fe42c1b322925b` |

`manifest-verification.json` records 364 final comparisons and zero mismatches. The original frozen manifest differs only at the checker, as disclosed below. Server/wrapper source, built outputs, probe and instrumentation were unchanged between P1, N1 and P2.

### Schedule and reference versus prediction

**3/6 separately authorized wrapper/root-turn runs used; three model requests; zero child Agents.** The measured window is `2026-09-28T14:00:16.868Z` to `2026-09-28T14:01:28.963Z`: **72.095 seconds**. Each invocation is below five minutes and each uses one request, below the 20-request cap. Counts and durations are copied from `budget.json`, final events and `schedule-counts.json`.

| Run | Schedule | Requests | Duration (ms) | Server stage history | Invocation / scenario checker exit |
| --- | --- | ---: | ---: | --- | --- |
| E5/P1 | Unmodified default wrapper; normal negotiation | 1 | 4218 | accepted → queued → submitted → settled | 0 / 0 |
| E5/N1 | Capability fields removed at server join | 1 | 5118 | accepted only | 0 / 0 |
| E5/P2 | Unmodified default wrapper; normal negotiation | 1 | 4160 | accepted → queued → submitted → settled | 0 / 0 |

| Run | Production observation / prediction | Independent native reference | Ledger result |
| --- | --- | --- | --- |
| E5/P1 | Modes v1 / work_control v1; first-turn stage reports predicted | Request at `2026-09-28T14:00:17.891Z` contains the unique input; native transcript version `2.1.280` and stdout contain the scripted completion. | Server records queued/submitted/settled, handoff prompt_hook; captured incarnation and generation match; ACK 1/1, lost 0 |
| E5/N1 | No negotiated modes/work_control; no wrapper reports predicted | Request at `2026-09-28T14:01:11.863Z` contains the unique input; native transcript version `2.1.280` and stdout contain the scripted completion. | Only server-created accepted remains; ACK 1/1, lost 0 |
| E5/P2 | Modes v1 / work_control v1; first-turn stage reports predicted | Request at `2026-09-28T14:01:26.757Z` contains the unique input; native transcript version `2.1.280` and stdout contain the scripted completion. | Server records queued/submitted/settled, handoff prompt_hook; captured incarnation and generation match; ACK 1/1, lost 0 |

For example, E5/P1 records accepted at `2026-09-28T14:00:17.379135Z`, queued at `2026-09-28T14:00:17.391Z`, submitted at `2026-09-28T14:00:17.828Z` and settled at `2026-09-28T14:00:17.956Z`. The unique input appears in the actual request at `2026-09-28T14:00:17.891Z`. Wrapper lifecycle logs separately show dispatch, ACK send and turn start; stdout shows native completion. The observer's poll time is not an exact event timestamp; the table uses stored stage timestamps and direct request-capture times.

**Observed:** both positive joins advertise `{version: "v1", early: "none", yield: "none", stage_reports: true}` and `work_control: "v1"`; their server replies acknowledge v1 and supply `inter_agent_delivery_incarnation`. The final stage identity matches that incarnation and the wrapper's advertised `delivery_generation`. `submitted` carries `handoff: "prompt_hook"`; `settled` carries `reason: "turn_end"`. Every run reaches `issued_seq = acked_seq = 1`, `lost_count = 0`.

**Scope/inference:** this establishes phase-1 default wiring through one ordinary first turn and its native hook. It does not establish phase-2 fold/yield capability, work-operation semantics, restart durability, or every lifecycle schedule. `included` is optional `ticket_used` evidence; no ticket was used, so its absence is expected. Neither ACK alone nor the scripted model's completion is treated as proof of stage reporting. E5/N1's server-created `accepted` remains even though the wrapper reports no stages.

### Negative control and checker correction

E5/N1 preserves the same wrapper build and native input/output path but drops the two capability fields at the server join. WorkStore then has no delivery modes and `work_control` is false. The first native turn and dispatch ACK still complete. The ledger contains **accepted only**, and no queued/submitted/included/settled report appears. Server channel logs independently count three `delivery_stage` events in each positive run and zero in N1 (`stage-wire-counts.json`). Its scenario checker exits **0**; running the positive-stage checker against those same raw logs exits **1**. Restored E5/P2 exits **0** under the positive checker. This is a negative control on the actual default startup path, not a hand-authored stage fixture.

The initial checker had two field-path mistakes: `stages` instead of `stage_reports`, and a nonexistent `reply.inter_agent_delivery.generation` instead of the advertised `delivery_generation`. E5/P1's first check exited **1** with KeyError; the measurement itself exited 0. `check-v1.py` (SHA-256 `8edac26241bcae13a8d799330532bb1d167f4fa9f5e7fa89fbc41d0d937f4029`), its failure log and `checker-revision.json` preserve this correction. Only checker paths changed; original raw logs were reanalyzed, and N1/P2 ran with the corrected checker. No product or probe change was made to obtain a passing result.

### Cleanup

All three invocation sessions exited; each owned wrapper and server exited 0. The enclosing PID namespaces bounded descendant lifetime. `cleanup-processes.json` records zero remaining owned native/wrapper processes. No shared process was killed. After preserving and pushing this docs-only report, the dedicated worktree, dependencies, isolated persistence, config/cwd and build outputs are removed; `cleanup-final.json` records that final check. The raw logs, native transcripts, scripts, server delta and manifests remain intentionally as evidence. No instrumentation is committed.

## R3/S1: production-settings receipt-root timing (2026-09-29 JST)

**Established for the measured configuration and schedule:** the three valid
T1-shaped runs measured **7, 6 and 8 ms**, minimum **6 ms**, maximum **8 ms**,
against the unchanged **2,000 ms** `pending_receipt_root_timeout_ms` default.
No valid run emitted `root_hook_timeout`. This supports retaining the operating
margin for this configuration; three observations do not establish a tail
latency bound or success rate under arbitrary machine load or hook changes.

Decision owner: Kohaku; measurement owner: Kogane. Authorization is conversation
`c80982b9-4435-4178-b74f-d7211e98fe1b`, including the side-effect decisions in
turns 4/6 and sender-capability repair and clock definition approved in turn 8.
The gate is [issue 434, design v3.1 S1](https://github.com/sakuraiyuta/kaoiro/issues/434#issuecomment-5871817486).
The measured product commit is `c658b69f506033ae76a35f5a75de025e68b85e74`.
This section establishes S1's timing prerequisite, not every R3 assertion:
there was no third queued root R, and the pending-root hold/fail-stop guards
were not mutated in this native measurement. Capability rollout is a separate
decision; this docs-only change does not enable it by default.

### Composition and the measured clock

The executable is the unmodified default `claude-code/dist/cli.js`, with the
real SDK, native CLI, Host, ServerLink and local Phoenix server. All positive
runs set `KAOIRO_CLAUDE_PHASE2_DELIVERY=1`; N1 sets it to `0`. No Host factory,
SDK callback, Query iterator, input seam or admission guard is injected or
changed. Two owned local sender connections submit the ordinary and early
messages through the server. Server-only instrumentation appends received
wire payloads without changing them; a read-only observer snapshots the
actual delivery ledger. The model endpoint independently captures requests.

The interval is **`submitted.at - previous result-envelope.ts`**. Both values
come from the wrapper's own millisecond-resolution wall clock, not from server
receive timestamps or polling. The first endpoint is the existing result
processing/emission point, not the first byte received from SDK stdout; the
second is the synchronous stage report from the admitted root hook. The gate
owner explicitly accepted this quantity as the timeout basis. It does not
measure the entire push-to-hook interval, initial settings startup, or Stop
hooks completed before the old result. T4's preliminary 6 ms progress update
used the settled timestamp by mistake; the raw result timestamp yields **7 ms**.

Each run uses fresh user/network/PID namespaces, only loopback enabled, and no
external route. Real provider API calls are impossible in that namespace. The
explicit child environment contains a dummy local API key and loopback base
URL; inherited credential environment variables are omitted. Real HOME is
available to the CLI as required for settings; credential files are not copied
into evidence. No runner, existing peer process or production server is used.
The local server has separate persistence paths. Namespace process lifetime
bounds descendants, and direct children are stopped by retained handles.

### Production settings and side effects

`HOME=/home/yuta`; no scratch HOME or `CLAUDE_CONFIG_DIR` replaces the operator
configuration. `/home/yuta/.claude/settings.json` resolves to
`/home/yuta/git/ai-settings/claude/settings.json`, SHA-256
`817a66b3da1a0a928e54327d681d0cbc9301e2480f19ec55022deb518a90b789`.
**Difference from production: `USAGE_LOG_PATH` points into the R3 evidence
scratch directory.** Settings and hook bytes are unchanged. The model is pinned
to `claude-sonnet-4-6`; `allowed_tools: ["Bash"]` permits the single bounded
optional tool schedule. These settings do not characterize other models,
permission choices, hooks or ambient workloads.

The following is the configured hook inventory, not a claim that every matcher
fired. Process observations show the worklog, model-profile start/prompt,
carefully-coding reminder, compound-Bash, secret-dump, Stop and SessionEnd
commands. Native transcript attachments separately show the SessionStart date
hook, and Stop summaries contain both `stop-validate.sh` and the SDK callback.
Process sampling can miss short-lived hook commands.

| Event / matcher | Configured command(s), under `~/.claude/hooks/` unless stated |
| --- | --- |
| SessionStart | Date/additionalContext shell command; `worklog-session-start.sh`; `model-profile.sh start` |
| UserPromptSubmit | `carefully-coding-reminder.sh`; `model-profile.sh prompt` |
| PreToolUse: Bash | `git-herestring-guard.sh`; `approve-compound-bash.sh` |
| PreToolUse: Bash or Read | `secret-dump-guard.py` |
| PreToolUse: Write or Edit | `carefully-coding-gate.sh check` |
| PreToolUse: Skill | `carefully-coding-gate.sh mark` |
| PreToolUse: WebFetch | `webfetch-auto-allow.sh` |
| PreToolUse: asset submit MCP tools | `asset-library-reminder.sh` |
| PostToolUse: Write or Edit | `post-lint.sh` |
| PostModelSwitch | `model-profile.sh switch` |
| Stop | `stop-validate.sh` |
| SessionEnd | `usage-log.py` |

The configured status line is `~/.claude/statusline.sh`; this is a print/SDK
run, and no status-line invocation was observed. Enabled plugin entries are
rust-analyzer-lsp, Context7 and cli-anything. Their inspected cache trees expose
no additional hook files. Context7's configured remote MCP endpoint has no
external route in the measurement namespace. Configuration presence does not
establish a successful plugin or MCP connection.

The Skill marker hook can delete other sessions' files older than seven days.
That branch was excluded by fixed model responses containing only text and the
one measured Bash call. **Native transcripts contain Bash: 1, Skill: 0, other
tool_use: 0 across all six SDK runs.** No Agent child is created. Pre/post cache
inventories include names, mtimes and hashes: additions **0**, changes **0**,
deletions **0**. Session-specific model marker creation was authorized, but no
such new marker was observed. The pre-existing shared cache is unchanged.

### Runs, reference and prediction

**6/6 SDK runs consumed**, including the invalid sender-setup run. There are
**12 model requests**, no real model API requests. The window from the first
wrapper launch at `2026-09-28T18:05:20.168Z` to final cleanup event at
`18:09:44.257Z` is **264.089 seconds**. Every SDK invocation is below five
minutes and below its 20-request cap. Two earlier server-only preparation
attempts, T1/T2, failed before wrapper/SDK launch because the isolated MIX_HOME
lacked Hex; those logs remain, and neither consumed an SDK run. The installed
Hex archive was copied into scratch before proceeding.

| Run | Schedule | Requests / results | Duration (ms) | Invocation / checker exit | Result-to-submitted (ms) |
| --- | --- | --- | ---: | --- | ---: |
| T3 | Invalid: sender omitted delivery-mode capability; early send rejected locally | 2 / 1 | 38239 | 1 / not classified | — |
| T4 | Hold text-only response, send early input, finish old turn, admit fresh root | 2 / 2 | 7485 | 0 / 0 | 7 |
| T5 | Repeat T4 | 2 / 2 | 7361 | 0 / 0 | 6 |
| N1 | Same schedule, phase-2 flag off | 2 / 2 | 7254 | 0 / 0 | 17 (ordinary queued root) |
| F1 | Send early input while bounded Bash is running | 2 / 1 | 8586 | 0 / 0 | Not a new-root interval |
| T6 | Repeat T4 after the negative control | 2 / 2 | 7344 | 0 / 0 | 8 |

T3 is a probe setup failure, not a receiving-wrapper defect. Its sender's
ServerLink rejected `delivery_intent: early` with `work_control_unavailable`
and `send_not_attempted: true`. The approved repair adds the sender's valid
`interAgentDeliveryModes` and `workControl` declarations; only unused run labels
were added otherwise. Receiver bytes, hooks, input path and schedule remain
unchanged. Both probe versions and raw logs are retained. The invalid run also
records an observer shutdown race (`DeliveryStates` already stopped); all five
valid runs have wrapper/server exit 0. The expected SDK Bash auto-approval
warning is recorded; no valid run reports an unhandled exception.

| Run | Wrapper observation / prediction | Independent reference |
| --- | --- | --- |
| T4 | Result `18:07:21.491Z`; seq 2 submitted/prompt_hook `18:07:21.498Z` | Native transcript has two distinct root prompt IDs; request 2 contains the early body with the real `fold_id`/reply-authorization input. |
| T5 | Result `18:07:42.181Z`; submitted `18:07:42.187Z` | Two distinct root IDs and two results; request 2 contains the receipt-bearing input. |
| T6 | Result `18:09:42.000Z`; submitted `18:09:42.008Z` | Same independent checks as T4/T5. |
| N1 | Negotiated early mode `none`; requested early is granted normal; prompt_hook follows ordinary queueing | Two native root IDs, but no receipt-bearing mid-turn input in either request. |
| F1 | Seq 2 submitted/fold_hook `18:09:05.962Z`; sole result `18:09:06.081Z` | Native transcript has one root prompt ID and one Bash call; request 2 carries the mid-turn input in tool-result content. |

All valid early deliveries reach settled with `reason: turn_end`; no unknown
stage or timeout is recorded. Reported `included` is not required: the scripted
model never spends a reply ticket. Captured requests are the input-inclusion
reference, not evidence that a model understood that input. The timestamp and
identity assertions are evaluated against actual wire/transcript records.

### Negative control, artifact binding and cleanup

N1 keeps the same product, settings and input schedule, with the phase-2 flag
off. Its negative-scenario checker exits **0**. Applying the positive root
receipt checker to those same native logs exits **1** (receipt text, early
grant and advertisement assertions fail); restored T6 exits **0**. Raw logs are
never edited to manufacture this contrast. The checker is a disposable raw-log
reader; no product test suite or guard mutation is claimed by this measurement.

Evidence is retained at
`/home/yuta/git/kaoiro/tmp/reviews/issue-429/e/R3/`. `schedule-counts.json`,
`native-summary.json`, per-run `*.check.json` and `negative-controls.json`
contain the counted results. The server observation delta is retained and not
committed. Offline install, protocol typecheck and dependency-order core →
agent-common → claude-code builds, plus the scratch server build, all exited 0.
Protocol is type-only. Installed SDK is **0.3.280**; every native transcript
reports CLI **2.1.280**. Node is **24.3.0** at the pinned absolute path.

| Binding | SHA-256 |
| --- | --- |
| `run-manifest.json` — 122 retained evidence files | `64fb23cd5046ec29dedbb0bde98441c5b1b7e52907a1003224e0a01b8773902d` |
| `artifacts-final.json` — final source/build/SDK/CLI/probe/checker bindings | `34949c3179948d54e39049dfdb7b203d927692aeba24537443e3b79e29ce17d5` |
| Original `probe-v1.mjs` | `ff9ebcf1e06c512cf083d5ef38fb05a8214107bdda8baa1aaf2744cae3ea4faa` |
| Corrected `probe.mjs` | `890f638e44ffccfda50ceb63ac26f031de3356b1c2f544f86301e504d05d08a7` |
| `check.py` | `971e71043d0bda0f993561cca69751bb6f883d7ce2b6308ce871288adc8f12b8` |
| Server observation patch | `8e761c1287bfbcd2d4670d54c4797edcd09f91dc70cab3b5a270fc0dc4ddf247` |
| Built `claude-code/dist/cli.js` | `00bf0e9c824cd632f3bedb79de8792e09ef892b862b00b568e938161b1e7fb70` |
| Built `claude-code/dist/host.js` | `6b0458db84993d58c46d7f4a0e389d8817e6eb42159be3b1a9a16294dbe9ec75` |
| SDK `sdk.mjs` | `ef4c2c0fc286d8c7dab7771516cf95206f9f670e99e74dc62f245b7fc8224955` |
| Executed Linux x64 CLI | `1e08503dbdf3c2cb0d706d32f3408277388d1c76ef108673e8fe42c1b322925b` |

Before cleanup, all 273 frozen artifact comparisons matched except the one
explicitly authorized probe revision; unexpected mismatches were zero. The
final artifact manifest binds the corrected probe and checker. Product output
and real settings/hook bytes did not change between runs.

Cleanup removed the six scratch-cwd project directories and six corresponding
session-env directories under real HOME after preserving their transcripts.
No model marker needed deletion; history.jsonl was not edited (any CLI append
is retained). `owned-home-artifacts.json` enumerates the exact paths and session
IDs. `cleanup-home-processes.json` records their absence, unchanged settings
and shared cache, and zero remaining owned wrapper/native processes. The
scratch worktree `worktrees/kogane-434-r3-native`, dependencies, build outputs
and separate server persistence were removed; `cleanup-final.json` records
that check. Only the intentionally retained evidence remains. No shared
process was signalled or shared session artifact removed.
