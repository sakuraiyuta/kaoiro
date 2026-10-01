---
title: "Codex 0.159.2 pin evaluation, 2026-10-01"
status: recorded
last_updated: 2026-10-01
---

# Codex 0.159.2 pin evaluation

Tracking: [issue #462](https://github.com/sakuraiyuta/kaoiro/issues/462).
Writer: kogane. Director: hisui. Production adoption requires the operator's
separate decision.

## Recommendation: adopt later

Keep production on **0.156.1** until the remaining adoption gates below are
closed. Paired unauthenticated and authenticated measurements found no
incompatibility in the exercised Stage 1, operator-steering and command-denial
contracts. The candidate still fails two explicitly version-bound Codex tests;
the current production fixtures have deliberately not been replaced by this
evaluation. This is not a release approval or a green-suite claim.

The isolated candidate requires the existing SDK stream patch. Upstream
0.159.2 without that patch fails the existing reproduction; the unchanged
patch restores it. The patch must not disappear during a future bump.

Outstanding adoption gates:

1. Incorporate the newly measured Stage 3 command-approval decline evidence
   into the version-bound test fixture as part of the approved pin change.
   The new capture is linked below; changing the expected version alone is
   insufficient. Record the advertised decisions versus the accepted `decline`
   response, and distinguish documented protocol support from an undocumented
   fallback; this evaluation establishes behavior only.
2. Update the catalog's bundled-version assertion, obtain a green complete
   suite, and complete peer review of the resulting candidate.
3. Before production adoption, establish the required network/filesystem
   enforcement evidence. The measured denial and read-only `sleep` commands
   do not establish every shared-worktree Git or network restriction.
4. Obtain the operator's adoption decision. This branch's dependency commit
   must not be merged into `develop` merely to publish this evaluation.

## Candidate and isolation

- Baseline: `3794baa7f71f4736138ef6e3a9bfbb37743764ee`.
- Candidate dependency commit: `d1b403ba05a66ac047047243a0c48a3ecbd8e7c1`.
- Branch: `issue-462-codex-pin-eval`.
- Worktree: `<operator-home>/git/kaoiro/worktrees/kogane-462`.
- Evaluation scratch: `/tmp/kogane-462-eval.BgbjI8`.
- Both candidate packages are exactly 0.159.2. The SDK patch is renamed for
  that version with byte-identical content. Product TypeScript and existing
  tests are unchanged from the baseline.
- No change has been merged to `develop`, deployed, or made in the main tree.
  No new binary has opened either production Codex home. This work therefore
  adds no version to the set of binaries that have migrated production state;
  it does not independently reconstruct that state's earlier history.

All Codex processes use a task-owned isolated `HOME`, and probes additionally
set an isolated `CODEX_HOME`. Authenticated homes are described separately
below; they were created and logged into by the operator. The final full suites leave `CODEX_HOME` unset
while retaining an isolated `HOME`, so tests exercising the default
`HOME/.codex` path can do so. API-key variables are absent. In the unauthenticated runs, loopback Responses
providers supply scripted responses, with analytics and plugins disabled.
Those runs use no live model service or account credential. CLI startup may still
attempt external update traffic; these runs are not proof of zero outward
traffic. Local dev-server state, tokens, cache and DETS files are isolated.

The initial frozen offline install exited 0 with warnings for an unbuilt
Claude probe executable and an ignored `tesseract.js` build script. An asdf
shim invocation under the isolated home exited 126 before building; later
commands use `<operator-home>/.asdf/installs/nodejs/24.3.0/bin` directly.

## Binary identities and schemas

Both versions were obtained from the published Linux x64 packages. Their
`--version`, `features list`, stable schema generation and experimental schema
generation all exited 0 under isolated homes. The candidate extracted from
`npm pack` and the installed candidate have the same binary SHA-256. Native helper executables are retained alongside each binary.

| Native binary | SHA-256 |
| --- | --- |
| 0.156.1 | `0b2e9301d6100dddda3b9d5c80ebaeaa3a2f1962388f2f36f6b96a9f08b1f33f` |
| 0.159.2 | `1748767b230ebfc3d4ab7e4e254920d0c0ad9691fd8c11f190e7d44511a4a92e` |

Commands: `<binary> app-server generate-json-schema --out <directory>`,
with a separate invocation adding `--experimental`. Manifest construction
follows [Stage 1](stage1-compatibility.md): sorted relative JSON paths and
`SHA256(file) + "  " + relative_path + "\n"`, then hash the manifest.

| Bundle | Files | Manifest SHA-256 |
| --- | ---: | --- |
| 0.156.1 stable | 310 | `d66a1b1c52622a4f78fc87c9acf3a58e608e3ae53c308c455a9f49b9c9e0c248` |
| 0.159.2 stable | 314 | `d5f51be102b9c790f960f074b0974a4c78956896cdcdaf45225755a7c7bfeafb` |
| 0.156.1 experimental | 436 | `41d9449edf4e04771b9f351186ef2d267a8f1655addb0e068138ce485a0474b2` |
| 0.159.2 experimental | 440 | `e587a3d5ffab12e528589e14d385b04d1192b9ae6914ce008cd3ea507e5aa455` |

Stable: four gateway OAuth files added, none removed, 29 existing files
changed (including aggregate bundles). Inspection includes nested definitions.
The adapter-relevant changes are additive:

- Optional `InitializeCapabilities.explicitGatewayOauth`.
- `thread/items/list.cursor` also accepts an item anchor. String/null cursors
  remain valid; the response still returns a string continuation cursor.
- Optional item-history `startedAtMs` and `completedAtMs`.
- Additional `CodexErrorInfo` variants `flexUnavailable` and `tooManyDenials`,
  and plan type `promax`. The projection does not exhaustively reject these
  enums. `Turn.error` now documents interrupted as well as failed turns;
  the existing projection already reads an error message for either status.
- Optional MCP resource/discovery fields on surfaces outside this adapter's
  required request path.

`ThreadStartParams`, `ThreadResumeParams`, `ThreadReadParams`,
`TurnStartParams`, `TurnSteerParams`, `TurnSteerResponse`,
`TurnInterruptParams`, `TurnInterruptResponse`, `ItemStartedNotification`,
`ItemCompletedNotification` and `CommandExecutionOutputDeltaNotification`
are byte-identical between stable bundles. Schema compatibility is not used
as a substitute for execution.

Negative control: remove `expectedTurnId` from both `required` and
`properties` in a copied `TurnSteerParams`. The same `diff -u` comparison
exits 1 and shows the missing identity field. This validates the comparison
operation, not an automatic general-purpose compatibility checker.

## Stage 1 and backend rollback

The existing real-binary integration tests were run unchanged on both pins:
`app_server_transport`, `app_server_session`, `app_server_history`,
`app_server_permission`, `app_server_control`, `app_server_host_runtime`,
`host_app_server`, `cli_app_server_history`, and `backend_rollback`, all
`.integration.test.ts` under `wrapper/codex/test/`.

Both runs: **9 files, 11 tests, exit 0**. These exercise default production
transport/session/host composition, sequential turns, restarted resume,
paginated history, settings, permission rollout, bridge activity and
app-server-to-exec resume with retained identity/history. The rollback uses
the same candidate pin in both backends; it does not test downgrading a
production database from 0.159.2 to 0.156.1.

Negative control on each pin: temporarily omit `turn/completed` from
`AppServerTransport.#deliver`'s stream, preserving stream completion. The
unchanged transport integration test fails with exit 1. Restore the source;
its test passes, and the candidate's full nine-file Stage 1 selection passes
again after rebuild. No mutation remains in the branch.

The tests emitted the expected isolated-home warning that auth mode is
unknown and the model catalog is empty. They did not report a Vitest
unhandled-error summary. Application diagnostic output is preserved in logs;
these runs are not described as warning-free.

## Stage 2: paired replacement probes

The original [pre-implementation](https://github.com/sakuraiyuta/kaoiro/issues/366#issuecomment-5894716113)
and [post-implementation](https://github.com/sakuraiyuta/kaoiro/issues/366#issuecomment-5896269682)
probe scripts were discarded. With the director's approval, **new minimal
scratch tools were written** and the same tools run against both binaries.
They are not committed. Comparisons below are between these paired runs;
they do not claim to reproduce the earlier authenticated measurements.

- `rpc-probe.mjs`: production `AppServerRpc`, exact production launch flags,
  `experimentalApi: false`; L0/L5/L4 requests with a held loopback response.
- `host-probe.mjs`: built `CodexHost`, default session factory and production
  spawn arguments. A forwarding tap selects the compared native executable
  and captures stdio. No server behavior is simulated inside the adapter.
- `l6-probe.mjs` plus `select-binary.mjs`: real isolated Phoenix dev server,
  built wrapper CLI, `KAOIRO_CODEX_OPERATOR_STEER=1`, real Phoenix operator
  client and loopback model provider. First instruction explicitly normal;
  second instruction omits `delivery_intent`.
- `check-rpc.py`, `check-host.py`, `check-l6.py`: assertions on the actual
  captured output. All tools remain verification-depth tier (c), disposable
  task tools, not product deliverables.

Reproduction invocations (absolute paths supplied; each output directory is new):
`node host-probe.mjs <worktree> <native-binary> <output-dir> L1|L2|L3|L3b`,
`node rpc-probe.mjs <worktree> <native-binary> <output-dir>`, and
`node l6-probe.mjs <worktree> <native-binary> <output-dir> <dev-server-port> <select-binary.mjs>`.
The L6 server runs `MIX_ENV=dev mix phx.server` with task-owned `TMPDIR`,
`MIX_BUILD_PATH`, a loopback port and a scratch operator token.
Check with `python3 check-host.py <output-dir>/trace.jsonl`,
`python3 check-rpc.py <output-dir>/trace.jsonl`, or
`python3 check-l6.py <output-dir>`.

| Case | Observation on both pins |
| --- | --- |
| L0, active steer | Wrong turn ID rejected with `-32600`, message-only `expected active turn id ...`; valid steer accepted into the started turn; idle steer rejected with `-32600`, `no active turn to steer`. Negative input is absent from history. This replacement L0 holds model output; L1 covers the command timing. |
| L1, command in flight | A real `sleep 8` command runs through code mode. One start, one accepted steer, one completed terminal; matching `clientId` appears after command completion. Host reports accepted then included, and one final result contains `STEERED_462`. |
| L2, model output in flight | Held first output completes as `ORIGINAL`; the same turn then emits `STEERED_462`. Both assistant log rows survive in order, and the single result uses the latter. This is scripted output timing, not a live reasoning-phase observation. |
| L3, command then interrupt | Interrupt two seconds after steer acceptance. Terminal is interrupted; accepted steer is not observed; Host reports unknown/not_observed and does not resend. Command completion arrives after terminal with the old turn ID. No extra turn starts in the 25-second observation window. |
| L3b, model output then interrupt | Interrupt 50 ms after acceptance. Same unknown/no-resend outcome, one interrupted terminal, no extra turn during 25 seconds. |
| L4, manual compact | `-32600`, `cannot steer a compact turn`, structured `data.codexErrorInfo.activeTurnNotSteerable.turnKind = compact`. The probe closes the held compaction after measuring rejection; successful compaction/model summarization is not claimed. |
| L5, new-process resume | Resume with `excludeTurns: true`; steer correlation survives, and `thread/read(includeTurns: true)` retains both old and new `clientId` values. `thread/items/list` retains the current turn's input. Full read triggers the expected full-history deprecation notice. |
| L6, server and wrapper | Omitted intent becomes same-turn steer through the negotiated operator mode. One `turn/start`, one `turn/steer` targeting that turn, one result. Accepted/included lines reach the operator lobby before `STEERED_L6_462`. |

Host cases are one sample per case/pin, with bounded observation. Absence of
another turn for 25 seconds does not prove it can never appear. No unexpected
server-initiated request was captured in the approval-never RPC/Host cases.
This is narrower than proving every elevated-command scenario request-free.

All final drivers and output checkers exited 0. Negative controls run on
copies: remove steer records (L1/L2), inject another `turn/started` (L3/L3b),
rename `activeTurnNotSteerable` (RPC), remove the lobby's included line (L6).
Each checker exits 1. For the checker-gated subsequent step, the negative
invocation exits nonzero and its next-step marker count is zero. Checkers
are not used to deploy or modify production.

Two setup failures were corrected before the final paired captures: copying
only the old native binary omitted `codex-code-mode-host`, and the first L6
client waited for `waiting_input` although the no-prompt CLI was `idle`.
The final runs use complete native distributions and accept the actual
initial idle state. Their earlier failing logs are retained separately.

## Authenticated comparison and Stage 3 denial

The operator separately logged into two scratch homes using device auth; the
director then authorized ten live model turns in total. Every invocation
explicitly paired the binary hash above with its allowed `CODEX_HOME`:

- 0.156.1 only: `<scratch>/codex-462-v156`.
- 0.159.2 only: `<scratch>/codex-462-v159`.

`<scratch>` denotes the operator-managed scratch authentication directory;
`<operator-home>` denotes the operator home. These are publication placeholders,
not literal reproduction paths. Both directories were checked as mode 0700. The evaluator did not read, copy,
print or compare either `auth.json`, and did not open a production Codex home.
Each process used a separate scratch `HOME`; API-key variables were removed.
`thread/start` or `thread/resume` explicitly selected `gpt-6-luna`, and every
`turn/start` specified `effort: low`. The raw wire and a reservation ledger
both contain **10 model turns**: five on each pin. No additional turn is
approved or attempted. No authentication or refresh failure was observed.

The offline tools were preserved unchanged. `live-host-probe.mjs` is a
separate adaptation using the same built production Host/session/transport
composition and forwarding binary-selection tap. It asserts the binary/home
mapping, captures the wire, and reserves budget before writing `turn/start`.
`live-approval-probe.mjs` uses built `AppServerRpc` with production launch
arguments and `experimentalApi: false`, then requests `on-request` for the
probe thread/turn. Its sandbox is `workspaceWrite` with only the probe's
`work` directory writable, no network, `excludeSlashTmp` and
`excludeTmpdirEnvVar`. The sibling `outside` target belongs to this probe.
No production permission setting is changed.

Reproduce using `node live-host-probe.mjs <worktree> <binary> <new-output-dir>
L1|L2|L3|L3b <allowed-home> [resume-thread-id]` and
`node live-approval-probe.mjs <worktree> <binary> <new-output-dir> <allowed-home>`.
Use the same script on both pins. L2 resumes the thread from that pin's L1
in a fresh process. Check with `python3 check-live-host.py <trace.jsonl>` or
`python3 check-live-approval.py <trace.jsonl>`. Fresh authentication and a new
explicit model budget would be required for any repeat.

| Case, one live turn per pin | Observed on both pins |
| --- | --- |
| L1, tool running | Ask for exactly `sleep 12`; steer after the command starts. The command finishes normally, then the complete user input item matches the submitted text and client ID. The same turn answers `STEERED_462`. |
| L2, resumed generation | Ask for integers 1–500, steer at the first output delta. The first answer finishes through 500, then the same turn emits `STEERED_462`. Two assistant items survive, and one final Host result uses the latter. |
| L3, tool then interrupt | Interrupt two seconds after acceptance. The turn is interrupted, the accepted input remains unobserved, and Host records `unknown(not_observed)`. The sleep completion arrives about 9.9 seconds after terminal. No additional turn starts during the 25-second passive observation. |
| L3b, generation then interrupt | Interrupt 50 ms after acceptance. One interrupted terminal, no matching input, Host `unknown(not_observed)`, no replay or additional turn during 25 seconds. |
| P2, command approval denial | One escalation request for `touch <outside>/denied.txt`; `availableDecisions` offers accept, an exec-policy amendment, and cancel, but no decline. Replying `decline` resolves the request, leaves the item `declined`, and the turn completes. The file is absent. |

All ten final drivers and their output checks exited 0. The ten negative
captures also exercise the same checkers: remove steer writes (L1/L2), add a
foreign turn start (L3/L3b), or change the denied command's item status to
`completed` (P2). Each negative invocation exits 1 and prevents the next-step
marker from being created (mutation count 0). These are capture mutations;
they do not claim that a live foreign turn was induced in the service.

The new P2 request/reply/resolution/item/terminal excerpt is preserved in
[the 0.159.2 denial capture](pin-0.159.2-approval-decline-2026-10-01.jsonl).
It is an actual wire capture, not a hand-built replacement fixture. Both
pin captures and all tool/output hashes are bound in the manifest. The current
built `parseApprovalRequest` accepts the new capture; removing its `turnId`
returns null in the paired parser check (exit 0).

The Host emits its existing unknown-catalog warning because these probe
configs omit account catalog hints; this did not omit the explicit model
or effort on the wire. Both P2 stderr logs contain the expected
`Rejected("rejected by user")` diagnostic. No other native stderr lines
were captured in these ten final runs.

A preliminary old-pin L1 attempt stopped before `turn/start` because the
probe's budget guard incorrectly required the model on that request instead
of allowing its explicit thread-level inheritance. It sent no model turn.
The guard was corrected before all ten final measurements; its failed log
is retained separately. This was a probe defect, not an upstream regression.

These live runs do not repeat live compact/review schedules or the full
Phoenix operator route. L0/L4/L5 history checks and L6 default omitted-intent
routing remain the paired real-binary/local-provider evidence above. P2 is
a narrow remeasurement, not a rerun of all Stage 3 approval combinations.

## Interruption defaults

The tagged [feature definitions](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/features/src/lib.rs)
and 0.159.2's actual `features list` both report `instant_interrupt` and
`defer_mailbox_preemption` disabled by default. Neither feature is enabled by
these probes. `features list` was also run with the candidate
authenticated home and confirmed both false (exit 0); the old binary lists
neither flag. `KAOIRO_CODEX_OPERATOR_STEER` enables kaoiro's operator lane,
not either upstream feature.

The [conditional interruption change](https://github.com/openai/codex/pull/47340)
introduces a separate `InterruptIfNoPendingInput` operation. The tagged
[app-server turn processor](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/app-server/src/request_processors/turn_processor.rs)
still sends `Op::Interrupt` from `turn_interrupt_inner`. That source
inspection and the paired L3/L3b observations support compatibility for the
measured default path, including the authenticated L1–L3b samples. They do
not establish every possible service-side continuation or timing schedule.

## SDK patch and complete suites

The first normal candidate install failed with `ERR_PNPM_UNUSED_PATCH`
because the workspace still declared the 0.156.1 patch. For the unpatched
negative control only, the install command allowed unused patches without
changing that workspace setting. The director then authorized the candidate
workspace mapping and patch-path update.

The published 0.159.2 SDK still uses the affected `readline` iteration.
`pnpm exec vitest run test/host.test.ts -t 'finishes a real SDK stream'`
failed unpatched (1 failed, 133 skipped, exit 1), with `Failed to parse item`
at output containing U+2028/U+2029. With the unchanged patch, the same test
passed (1 passed, 133 skipped, exit 0). This tests the real SDK and a fake
native-output process; it is evidence about the SDK reader, not model output.

Patch SHA-256:
`faafbd6188ec0466bd5d3dfd02ed642304b5e09be1986b58533577b8456dbd0c`.
Unpatched SDK `dist/index.js` SHA-256:
`d62ed107033bdba802b283c77d875e4bec3deb2704a910bb7e3f95059473b16f`.
Patched SDK `dist/index.js` SHA-256:
`72d4e07babc1a3173c1e8efc016f92c42a00056fa62e3b0ecf739f19d7668521`.

| Final candidate command | Result | Exit |
| --- | --- | ---: |
| `cd wrapper && pnpm build` | All wrapper packages built | 0 |
| `cd wrapper/codex && pnpm typecheck` | Passed | 0 |
| `cd wrapper/codex && pnpm test` | 77 files passed, 2 failed; 1191 tests passed, 2 failed | 1 |
| `cd runner && pnpm build` | Passed | 0 |
| `cd runner && pnpm typecheck` | Passed | 0 |
| `cd runner && pnpm test` | 35 files, 787 tests passed | 0 |

The two Codex failures are `catalog.test.ts:159` (bundled version remains
asserted as 0.156.1) and `app_server_rpc_server_request.test.ts:87` (Stage 3
fixture freshness). Neither assertion was weakened or edited. The first full
run also failed five HOME-path expectations because the evaluator exported
`CODEX_HOME`; the clean isolated-HOME rerun removed those five failures.

Build/typecheck commands emitted no warnings or unhandled errors. Suites
emitted fixture diagnostics and expected configuration warnings; runner also
emitted Node's experimental SQLite warning. Neither final suite reported a
Vitest unhandled-error summary. The Codex suite is explicitly **not green**.

## Evidence retention and limits

Executable/driver/checker identities, final artifact hashes, command exits
and output hashes are recorded in the
[companion evaluation manifest](pin-0.159.2-evaluation-2026-10-01.json). Scratch
is retained at `/tmp/kogane-462-eval.BgbjI8` pending review clarification;
kogane owns its eventual cleanup. The two authenticated homes listed above
were deleted with the director's authorization after the measurements. The
scratch home reserved for issue 461 was not used or removed. Probe/server
child processes were stopped through their owning scripts.

The evaluation does not cover all network or Git enforcement permutations,
Windows/Darwin execution, production database migration/downgrade, or
deployment. Historical 0.156.1 evidence and production reference statements
are unchanged pending an adoption decision.
