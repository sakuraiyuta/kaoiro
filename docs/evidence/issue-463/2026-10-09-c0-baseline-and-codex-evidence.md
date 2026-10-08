---
title: "Issue 463 C0: delivery baseline and Codex evidence inventory, 2026-10-09"
status: recorded
last_updated: 2026-10-09
---

# Delivery baseline and Codex evidence inventory (issue 463, stage C0)

Tracking: [issue 558](https://github.com/sakuraiyuta/kaoiro/issues/558), child C0 of
[issue 463](https://github.com/sakuraiyuta/kaoiro/issues/463). The plan is
[the default in-flight delivery plan](../../plans/issue-463-default-inflight-delivery.md);
this page is its stage 0 record. Every source claim below is read from develop
`867696cb` (`git show 867696cb:<path>`) unless another commit is named.

What this page is: claims tied to a commit, with a control for each, and an
inventory of which recorded Codex evidence supports which ADR-0058 requirement
on which artifact. What it is not: a measurement run. No test suite and no native
run was executed for it. Production was read only as listed in section 2.

## 1. Baseline claims

Each claim has a probe on the pinned commit and a control on an input where the
fact is false, or a second state that must read the other way. A scratch checker
ran all probes and controls (65 checks, 0 failures). Flipping the expectation of
any one probe made the checker exit 1 (13 of 13 claims). The checker is not
committed.

| ID | Claim | Source at 867696cb | Probe | Control (fact false, or second state) |
|---|---|---|---|---|
| P-1 | The Claude wrapper declares `early: fold` and `yield: tool_boundary` only when phase 2 is on | `wrapper/claude-code/src/cli.ts:993-994` | 1 and 1 matches of the two conditional expressions | 0 in `wrapper/codex/src/cli.ts`, 0 in `wrapper/antigravity/src`, 0 in the declaring commit's parent `b1c48a08^` |
| P-2 | The Codex wrapper declares `early: steer` only for the app-server backend; `yield` is always `none` | `wrapper/codex/src/cli.ts:720`, `:853` | 1 and 1 matches | 0 in the Claude wrapper, 0 in the Antigravity wrapper, 0 in the declaring commit's parent `f6d667ee^` |
| P-3 | The Codex wrapper always declares `operator_input_modes` (issue 489) | `wrapper/codex/src/cli.ts:856`; fix `70e47552` | 1 match of `early: operatorSteer ? "steer" : "none"`; `70e47552` is an ancestor | 0 matches at `70e47552^`, which declared steer-only inside a conditional; the reversed ancestor test exits 1 |
| P-4 | The Antigravity wrapper declares no delivery modes at join; the server echoes `v1` only for valid modes; the wrapper then reports `legacy` | 0 matches of `interAgentDeliveryModes` / `inter_agent_delivery_modes` in `wrapper/antigravity/src`; `server/lib/kaoiro_server_web/channels/wrapper_channel.ex:143`, `:200`, `:226`; `wrapper/core/src/transport.ts:2012` | 0 in Antigravity; 1 echo expression; 1 `?? "legacy"` | 1 in `wrapper/claude-code/src`, 1 in `wrapper/codex/src` (same search) |
| P-5 | An omitted Codex backend means exec | `wrapper/codex/src/cli.ts:180`, `wrapper/codex/src/host.ts:295`, `runner/src/supervisor.ts:499`, `runner/src/runner-cli.ts:473`; docs `docs/reference/configuration/runner.md:181` | 1 match at each of the four sites; 7 omitted-setting exec defaults in all non-test source under `wrapper/codex/src`, `wrapper/core/src` and `runner/src`. The other three are `wrapper/codex/src/cli.ts:665`, `wrapper/codex/src/host.ts:337` and `wrapper/codex/src/host.ts:1494`; enumerating them is the C4B sweep | 0 app-server defaults in the same source |
| P-6 | Issue 346 and issue 489 are closed; issue 469 is open; the three flag keys shipped in `5b78697d`, an ancestor of the baseline | `gh issue view` states; `runner/src/behaviour-settings.ts:54-59`, `:273-279` | 346 CLOSED, 489 CLOSED, 469 OPEN; ancestor test exits 0 | issue 541 reads OPEN in the same run; the reversed ancestor test exits 1 |
| P-7 | The per-agent policy store is not implemented: `delivery_policies`, `set_delivery_policy`, `delivery_policy_applied` and `in_flight_defaults` do not occur outside docs | `git grep` over the tree excluding `docs` and `tmp` | 0 matches | `delivery_modes` and `delivery_ack` are both found |
| P-8 | The code is unchanged between the plan's pins and the baseline | `git diff --name-only 0bfede23 867696cb -- . ':!docs' ':!tmp'` | `AGENTS.md`, `CLAUDE.md` only | `bf02a928..0bfede23` lists 7 files (all tests, none under a `src` or `lib` path) |
| P-9 | Production configures `claude_code.phase2_delivery: true`, `codex.operator_steer: true`, `codex.backend: "app-server"` | production runner config, three keys only (section 2) | the three values as stated | an absent key (`codex.no_such_key`) reads as absent |
| P-10 | Production runs release `bf02a928` with Codex native 0.161.0, the binary recorded in the 0.161.0 evidence | release id, `--version` line, native SHA-256 (section 2) | release id as stated; `codex-cli 0.161.0`; SHA-256 equals the value at AG61:16-18 | comparator only: expecting 0.160.0 fails (a production binary may not be swapped for a control) |
| P-11 | Phase 4 is tracked at issue 567; issues 541, 416 and 412 are open | `gh issue view` states; plan `:456-460` | all four OPEN | issue 346 reads CLOSED in the same run |
| P-12 | The Claude R3 measurement was taken on SDK 0.3.280 / CLI 2.1.280 and again on CLI 2.1.284; it has not been repeated on the current SDK pin | `docs/evidence/issue-429/2026-09-28-claude-fold-measurements.md:12`, `:22`; `docs/evidence/issue-429/2026-09-29-claude-2-1-284-remeasurement.md:206-209`; lockfile `pnpm-lock.yaml:105` resolves `@anthropic-ai/claude-agent-sdk` to 0.3.293 | no evidence page names 0.3.293 together with R3 or receipt-root | the 09-28 page is found by `0.3.280` plus `R3`; the 09-29 page by `2.1.284` plus `R3` |
| P-13 | Operator decision E3 is recorded in the issue 463 comment of 2026-10-08T15:23:54Z | `gh api repos/sakuraiyuta/kaoiro/issues/463/comments` | comment 6063194859 exists and names `phase2_delivery: true` | the comments of 2026-10-02 do not |

The claims that need a different check are P-9 and P-10: they read production, so
their only control is the comparator, and the configured keys show configuration,
not effective behavior (an environment variable overrides a key, see
`docs/reference/configuration/wrapper.md:128-129`). Section 2 therefore adds the
observable state.

## 2. Production observations

Read on 2026-10-09 around 03:25 JST (2026-10-08 18:2x UTC). Read-only; only the
items below were read.

| Item | Observation | Artifact |
|---|---|---|
| Runner release | `~/.local/share/kaoiro/current` resolves to release `bf02a928b9bd170d94aa3a0c049cd4197c1b0a91` | claim P-10 |
| Codex native in that release | `codex-cli 0.161.0`; SHA-256 begins `9a820c17865fa825` and equals the full value recorded at AG61:16-18 | claim P-10 |
| `claude_code.phase2_delivery` | `true` | `runner.config.json`, last modified 2026-10-03 11:12 JST |
| `codex.operator_steer` | `true` | same file |
| `codex.backend` | `"app-server"` | same file |
| Effective delivery modes (Codex peers, `list_agents` at 2026-10-08T18:27Z) | `early: steer`, `yield: none` for two Codex peers (models gpt-6-luna and gpt-6.1-sol), both with `build.revision` `bf02a928`, `dirty: false` | observed state |
| Effective delivery modes (Claude peers) | `early: fold`, `yield: tool_boundary` for three Claude peers and for the author's own `whoami`, same build | observed state |
| Control: Antigravity peer | no `delivery_modes` field in its `list_agents` entry, same build | observed state |

Limits: the three config keys were read without the environment overrides; the
override variable names were not inspected. The `list_agents` fields are the
effective state of the running peers and the strongest observation available
without reading production files. They do not observe hooks, credential refresh
or compaction behavior, so they fill no Codex requirement row except the model
column of N12 (the Codex peers were running turns on release `bf02a928` with the
two models listed, session start 2026-10-08T15:33Z).

## 3. Codex evidence inventory

### 3.1 Requirement register

The rows come from the sentences below. Each row names its source, so a reader can
check that no sentence was dropped.

| Source at 867696cb | Requirement | Rows |
|---|---|---|
| ADR-0058 `:277-280` | Pin the executable, generate bindings, check protocol compatibility on upgrades | N1 |
| ADR-0058 `:281-283` | The spike does not prove production MCP, hooks, resume, approval or recovery parity | N6, N8, N9, N10, N13 |
| ADR-0058 `:284-286`, Status "Default backend" | Configuration capture, account/model defaults, hooks, credentials refresh and compaction must be measured before changing the default adapter | N11 to N15 |
| ADR-0058 `:287-289` | Synthetic tests: terminal races, non-steerable rejection, lost acknowledgments, FIFO fallback, attachment cleanup, unchanged IA leases; production composition paths and negative controls | section 3.5 |
| ADR-0058 `:290-293` | Repeat both live steering probes on the production artifact; exercise review/compact fallback, resume and interruption | N2 to N7 |
| Plan `:328-334` (Codex 4a) | Audit thinking/tool-running probes, review/compact fallback, resume and interruption against their actual artifact | N2 to N7 |
| Plan `:336-345` (Codex 4b) | Configuration capture, account/model defaults, hooks, credential refresh, compaction; production selection supports a row only as a dated, artifact-bound observation | N11 to N15, production-observed |
| Plan `:356-363` (C4B grounding) | Resume across a backend transition: measured only app-server to exec on 0.153.4 with a loopback provider; no reverse measurement; production auth/model behavior not covered | N16a, N16b, N12 |
| PLAN:29 (current-state row), PLAN:474 (stage 4a row) | Inter-agent steer is enabled for the app-server backend subject to existing admission and order checks; stage 4a makes it default-on | N17 |

Row definitions (N1 to N17; 16 native rows plus the two transition rows):

| Row | Subject |
|---|---|
| N1 | Executable identity, bindings and protocol compatibility |
| N2 | Steer while the model is generating (the "thinking" probe) |
| N3 | Steer while a tool runs |
| N4 | Steer rejection on a review turn |
| N5 | Steer rejection on a compact turn |
| N6 | Resume: steer on a resumed thread (resume alone is noted in the cell) |
| N7 | Steer crossed with interrupt (interrupt alone is noted in the cell) |
| N8 | Approval: steer while an approval is pending; decline capture |
| N9 | MCP parity (a tool call through the MCP bridge) |
| N10 | Recovery: child death, state snapshot restore, corrupt state |
| N11 | Configuration capture by a long-lived process |
| N12 | Account and model defaults |
| N13 | Hooks |
| N14 | Credential refresh |
| N15 | Compaction |
| N16a | Resume across a backend transition: app-server to exec |
| N16b | Resume across a backend transition: exec to app-server |
| N17 | Inter-agent steer end to end |

### 3.2 Status vocabulary

| Status | Meaning |
|---|---|
| `M` measured-on-pin | Measured with that pin's binary against a live model |
| `L` local-provider-only | Measured with that pin's native against a local provider only |
| `O` other-pin-only | A record exists only for another pin; it is not counted for this pin |
| `S` schema-only | A schema or catalog check only |
| `A` absent | No record on that pin in the files of section 3.4 |
| `P` production-observed | A dated, artifact-bound observation of production (section 2) |

`P` does not satisfy an `M` requirement unless the plan row says so. The three
configuration keys fill configuration rows only. A cell with two statuses lists
both.

### 3.3 Matrix

Page keys are defined in section 3.4. Citations are `key:line` (or a line range) in
that page at 867696cb. The column "0.161.0" is the production artifact (P-10).

| Row | 0.153.4 / 0.154.0 | 0.156.1 | 0.159.2 | 0.159.3 | 0.160.0 | 0.161.0 |
|---|---|---|---|---|---|---|
| N1 | M TS:25-30 (0.153.4); 0.154.0 host install TS:116-124 | M ST2:15-21 | M EV2:78 | M AG3:15-32 | M AG60:24-25 | M AG61:9-25, AG61:53-64 |
| N2 | M TS:62 (reasoning item observed on 0.153.4) | M ST2:60-61 (no reasoning item on gpt-6-luna low; steer at turn start, then during output) | M EV2:283 (live, first output delta); L EV2:215 | M AG3:64; P3N:38 | L AG60:32 | L app_server_steer.integration.test.ts:114 @8feca417; I539, reported, log not retained |
| N3 | M TS:61 | M ST2:27, ST2:59 | M EV2:282; L EV2:214 | M AG3:63; P3N:38 | L AG60:32 | L app_server_steer.integration.test.ts:90 @8feca417; I539, reported, log not retained |
| N4 | A | S ST2:36 ("review turns are schema-only") | A (EV2:329-331: live compact/review not repeated) | A | A | A |
| N5 | A | M ST2:29 | L EV2:218 (held compaction; EV2:329-331) | A (schema equals 0.159.2, AG3:26-28; behavior not re-measured) | A (schema byte-identical, AG60:25) | A |
| N6 | resume alone O S1C:81 | M ST2:30 | M EV2:275-283 (L2 resumes in a fresh process) | M AG3:64; P3N:38 | resume alone L AG60:41; steer on a resumed thread A | resume alone L app_server_session.integration.test.ts:14 and :197 @8feca417; I539, reported, log not retained; steer on a resumed thread A |
| N7 | A | M ST2:28, ST2:61 | M EV2:284-285 | M AG3:65-66 | A (interrupt alone L AG60:41) | A (interrupt alone L app_server_control.integration.test.ts:12 @8feca417; I539, reported, log not retained) |
| N8 | A | M ST3:53 (steer while pending), ST3:54 (decline) | M decline EV2:286; steer while pending A | M decline and file change AG3:67-69; L P3N:35 (inter-agent input does not resolve a pending selection) | L AG60:31 (decline capture) | L AG61:26-41 (decline capture) |
| N9 | A (SB:37 describes the bridge wiring; no live MCP call recorded) | M ST3:56-57 | A | A | A | L app_server_session.integration.test.ts:14 @8feca417; I539, reported, log not retained |
| N10 | A | A | A | L P3N:34 (watchdog fail-stop); L AG3:116-147 (built state-aware update and restore); NS:1-6, BK2:1-11, BK3:1-8 and HCL:6-12 support the snapshot design | A (AG60:44: snapshot round trip not repeated) | A (AG61:89-96: corrupt-state recovery not measured) |
| N11 | A (near-misses: BRA:25-26 states that config reload does not replace running children, a design statement; S1C:105-112 is a fixture-config pass-through probe) | A | A | A | A | A |
| N12 | A | A (model was set explicitly, EV2:256) | A | M GATE5:8-20 (two models on both backends); AG3:48-50 | A (AG60:42: credentialed part not run) | S AG61:73-82 (unauthenticated introspection: default model GPT-6.1 Sol, effort low); signed-in defaults unverified AG61:93-95; P see section 2 |
| N13 | A | A | A | M I464N:40-43, I464N:57-60 (model-profile hook ran on start and on resume, authenticated) | A | A |
| N14 | A | A | M (weak) EV2:259 (no authentication or refresh failure in ten turns) | M (weak) GATE5:8-13; AG3:52-54 | A (AG60:3-5: credentialed part not run) | A (AG61:93-95: credentialed checks unverified) |
| N15 | A | A | A | M CU1:35 (five turns and one explicit compaction); CU2:34-46 (three compactions, one automatic) | A | A |
| N16a | L BRA:32-38 (0.153.4, loopback provider) | A | A | A | A | A |
| N16b | A | A | A | A | A | A |
| N17 | A | A (non-live gates only, P3L:17-18) | A | M P3N:33-38 (local provider and authenticated; kaoiro source `d575184b`) | A | A, see 3.3.1 |

"M (weak)" in N14 means the record shows the absence of an authentication or
refresh failure over several live turns; no token refresh was induced.
N2 note: the "thinking" probe is a steer during generation. The only recorded steer
during an actual `reasoning` item is TS:62 on 0.153.4; on gpt-6-luna at low effort
no reasoning item appeared (ST2:60).

#### 3.3.1 The 0.161.0 local-provider cells

In the matrix, `I539` is the issue 539 landing comment described here, and the
test files are under `wrapper/codex/test/`.

The 0.161.0 page says the existing native suites separately cover steer, interrupt
and resume (AG61:50-51) and that final gates are repeated on the final artifact
(AG61:127-129); its record and companion JSON contain no such run. The nearest record
is the landing comment of issue 539
([comment](https://github.com/sakuraiyuta/kaoiro/issues/539#issuecomment-6052987745)):
the reviewer San ran the wrapper test on the landed commit `8feca417`, exit 0, 3636
passed, 6 skipped, including both new native `runCodexCli` cases. It is an
aggregate, reported by the reviewer in a comment, with no retained log or per-file
result.

Conditions checked by reading, at `8feca417` (no test was run):

1. The pin at `8feca417` is `@openai/codex` and `@openai/codex-sdk` 0.161.0
   (`wrapper/codex/package.json`); `8feca417` is an ancestor of `bf02a928` and of
   `867696cb`.
2. The vitest include is `test/**/*.test.ts` and `wrapper/package.json`'s test script
   fans out to the Codex package.
3. The steer integration test has two plain `it(...)` cases
   (`wrapper/codex/test/app_server_steer.integration.test.ts:90` steers while its
   command runs; `wrapper/codex/test/app_server_steer.integration.test.ts:114` steers
   while the model is still streaming) with no `skipIf`, `.skip` or environment guard.
   The interrupt and resume integrations cited below have none either; the only skip
   markers in the wrapper tests at that commit are Linux-only guards, live-engine
   environment guards and ssh-agent probes in other files.

Cells filled from this record (all test lines read at `8feca417`): N2
(`wrapper/codex/test/app_server_steer.integration.test.ts:114`), N3
(`wrapper/codex/test/app_server_steer.integration.test.ts:90`), interrupt alone
(`wrapper/codex/test/app_server_control.integration.test.ts:12`), resume alone
(`wrapper/codex/test/app_server_session.integration.test.ts:14`,
`wrapper/codex/test/app_server_session.integration.test.ts:197`,
`wrapper/codex/test/app_server_resume_notice.integration.test.ts:111-155`), MCP bridge
(`wrapper/codex/test/app_server_session.integration.test.ts:14`). Source of the claim: the issue 539
landing comment and `8feca417`; remark for every one of these cells: "reported by the
reviewer, log not retained". Test titles were read; assertions were not audited.

Not filled from it: N17. `git diff --stat 8feca417 bf02a928` shows that
`wrapper/codex/src/cli.ts` (the inter-agent steer path), `agent-common` and `core`
changed before the production release, so a run at `8feca417` does not cover the
kaoiro source that runs in production. The filled cells are bound to "native 0.161.0,
kaoiro source `8feca417`".

### 3.4 Evidence file ledger

Every file under `docs/evidence/codex-app-server/` (27 Markdown, 14 companion
records) and `docs/evidence/issue-464/` (2 Markdown, 1 companion record) is listed.
A `source` entry names the rows it supports; an `excluded` entry gives the reason. A
companion record follows its Markdown page.

| Key | Page | Disposition |
|---|---|---|
| TS | `transport-spikes-2026-09-14.md` | source: N1, N2, N3 |
| S1C | `stage1-compatibility.md` | source: N6 (resume alone), N11 (near-miss) |
| BRA | `backend-rollback-artifact.md` | source: N11 (near-miss), N16a |
| SB | `session-and-bridge.md` | excluded as a measurement (Stage 1 increment record, 0.153.4); cited at N9 for the wiring statement |
| SP | `settings-and-permission.md` | excluded: Stage 1 increment record (settings and permission tests) |
| HC | `host-composition.md` | excluded: Stage 1 increment record (wrapper test coverage) |
| PH | `projection-and-history.md` | excluded: Stage 1 increment record (projection and history tests) |
| ISR | `initialize-sqlite-race-2026-09-30.md` | excluded: bounded `initialize` retry for concurrent starts on 0.156.1; not an ADR-0058 row |
| ST2 | `stage2-steer-probes-2026-09-30.md` | source: N1 to N7 |
| ST3 | `stage3-approval-probes-2026-09-30.md` | source: N8, N9 |
| EV2 | `pin-0.159.2-evaluation-2026-10-01.md` (+ `pin-0.159.2-evaluation-2026-10-01.json`, `pin-0.159.2-approval-decline-2026-10-01.jsonl`) | source: N1 to N3, N5 to N8, N14 |
| AG3 | `pin-0.159.3-adoption-gates-2026-10-01.md` (+ json) | source: N1 to N3, N6 to N8, N10, N12, N14 |
| GATE5 | `pin-0.159.3-gate5-2026-10-01.md` (+ json) | source: N12, N14 |
| NS | `pin-0.159.3-native-state-2026-10-01.md` (+ json) | source: N10 (supporting; a historical partial record) |
| BK2 | `pin-0.159.3-backup-r2-2026-10-01.md` (+ json) | source: N10 (supporting; zero live turns) |
| BK3 | `pin-0.159.3-backup-r3-2026-10-01.md` (+ json) | source: N10 (supporting; zero live turns) |
| HCL | `home-classification-2026-10-01.md` (+ json) | source: N10 (supporting; no model turn) |
| P3N | `phase3-native-0.159.3-2026-10-01.md` (+ json) | source: N2, N3, N6, N8, N10, N17 |
| P3L | `phase3-nonlive-gates-2026-10-01.md` | source: N17 (non-live gates on 0.156.1), section 3.5 |
| P3F | `phase3-fallback-reservation-2026-10-01.md` | source: section 3.5 (scripted tests; no authenticated turn, P3F:12-15) |
| P3R | `phase3-review-r1-fixes-2026-10-01.md` | excluded: review-round fixes verified with 0.156.1 tests |
| AG60 | `pin-0.160.0-adoption-gates-2026-10-04.md` (+ json) | source: N1, N2, N3, N6, N7, N8, N10, N12, N14 |
| AG61 | `pin-0.161.0-adoption-gates-2026-10-08.md` (+ json) | source: N1, N8, N10, N12, N14; section 3.3.1 |
| CU1 | `context-usage-2026-10-02.md` (+ json) | source: N15 |
| CU2 | `context-usage-qualification-2026-10-03.md` (+ json) | source: N15 |
| CM | `context-meter-implementation-2026-10-03.md` (+ json) | excluded: implementation verification of the context meter with local tests |
| RL | `rate-limit-refresh-2026-10-02.md` | excluded: account rate-limit telemetry on 0.159.3; not a credential refresh |
| I464N | `../issue-464/codex-home-isolation-native-0.159.3-2026-10-01.md` (+ json) | source: N13 |
| I464L | `../issue-464/codex-home-isolation-nonlive-2026-10-01.md` | excluded: non-live package gates and mutations; its hook mentions are test coverage |

### 3.5 Synthetic coverage (ADR-0058 `:287-289`)

These are not artifact measurements, so they are not rows. Each item is located by
test title at 867696cb. Assertions were not audited and no suite was run for this
page.

| ADR item | Test (file:line, title) | Status |
|---|---|---|
| Terminal races | `wrapper/codex/test/app_server_steer.test.ts:91` "an observation after the terminal is ignored"; `wrapper/codex/test/host_app_server.test.ts:209` "keeps queued text after token-fenced interrupt and omits the reset-authorizing terminal" | test present |
| Explicit non-steerable rejection | `wrapper/codex/test/app_server_steer_transport.test.ts:175` "classifies the measured non-steerable rejection from its data as P" | test present |
| Lost acknowledgments | `wrapper/codex/test/cli_inter_agent_steer.test.ts:155` "marks accepted but unobserved input uncertain and tells the sender to wait"; server ledger tests recorded at P3N:41 | test present |
| FIFO fallback | `wrapper/codex/test/cli_inter_agent_fallback_reservation.test.ts:272` "Kohaku review control: one queued successor stays behind the fallback"; `wrapper/codex/test/host_app_server_steer.test.ts:125` "inserts an exceptional fallback slot at its original arrival before later input" | test present |
| Attachment cleanup | `wrapper/codex/test/inter_agent_turn_coordinator.test.ts:283` "removes a terminal fallback slot before dispatch and ignores late attachment"; `wrapper/codex/test/host_app_server_steer.test.ts:312` | test present (title match is partial) |
| Unchanged IA leases | `wrapper/agent-common/test/inter_agent.test.ts:1254` (an accepted reply from another turn does not remove an earlier inbound lease) | test present |
| Production composition paths | `wrapper/codex/test/cli_delivery_composition.test.ts:798` "runCodexCli の実組成が watchdog を turn-start に接続し、attribution failure を host へ返す"; `wrapper/codex/test/cli_app_server_lifecycle.test.ts:44`; native `cli_sdk_native.integration.test.ts` (AG61:43-49) | test present |
| Negative controls | recorded in the evidence pages: P3N "Negative controls and evidence limits", AG60:32 (A8), AG61:105-121 | recorded |

### 3.6 Gaps

- Gap 1. The production pin (0.161.0) has no live steer measurement (N2, N3, N6, N7). Its local-provider cells depend on the conditions in 3.3.1 and carry the remark "reported, not retained".
- Gap 2. N4 (review turn) is schema-only on 0.156.1 and absent elsewhere.
- Gap 3. N5 (compact rejection) was measured live on 0.156.1 and locally on 0.159.2 only.
- Gap 4. N11 (configuration capture) has no measurement on any pin.
- Gap 5. N13 (hooks), N14 (credential refresh) and N15 (compaction) were measured only on 0.159.3, and N14 only as an absence of failure.
- Gap 6. N9 (MCP parity) was measured live on 0.156.1; on 0.161.0 only a local bridge test title exists.
- Gap 7. N10 (recovery): corrupt-state recovery is explicitly unmeasured on 0.161.0 (AG61:89-96); the snapshot round trip was not repeated on 0.160.0 (AG60:44).
- Gap 8. N16b (exec to app-server resume) has no measurement; the plan chooses not to migrate sessions automatically (plan `:356-363`).
- Gap 9. N8: steer while an approval is pending was measured only on 0.156.1; later pins have the decline capture.
- Gap 10. Handed to C4B (issue 564, [comment](https://github.com/sakuraiyuta/kaoiro/issues/564#issuecomment-6066199583)):
  the conditions in `docs/plans/adr-0063-phase3-codex-early-delivery.md:36` and `:439`
  about the Codex default flip.

### 3.7 Rows that need a separately approved native run

No native run is authorized by this page. The rows below are the ones whose absence
the plan says must be filled by a separately approved run. Counts are estimates from
the recorded runs (one live turn per scheduling case, as in AG3:63-66 and EV2:282-285),
not a budget request.

| Rows | Reason | Estimate |
|---|---|---|
| N2, N3, N6, N7 on 0.161.0 with the production kaoiro source | Gap 1 | 4 live turns |
| N4, N5, N8 (steer while pending) on 0.161.0 | Gap 2, Gap 3, Gap 9 | 3 live turns; N4 needs a probe design first |
| N13, N14, N15, N11 | Gap 4, Gap 5 | not estimated; each needs a probe design first |
| N16b | Gap 8 | not estimated; blocked by the C4B compatibility choice |

## 4. Limits

- Section 1 checks that a claim holds in the tree; it does not run the code.
- The matrix cites what each page records. A page's own caveats apply (for example,
  EV2:222-225 and AG3:134-147).
- `L` cells read from test titles are not assertion audits.
- No production file other than the three configuration keys, the release path and the
  packaged native's version and hash was read. No process was enumerated or stopped.
