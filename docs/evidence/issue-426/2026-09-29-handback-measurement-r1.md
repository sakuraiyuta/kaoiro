---
title: Claude CLI 2.1.284 hand-back availability and origin measurement
description: Auto-mode contrast, same-ID notification folds and replay-origin observations on the fixed release.
status: measured
last_updated: 2026-09-29
---

# Claude CLI 2.1.284 hand-back availability and origin measurement

Date: 2026-09-29. Owner: Kogane. Director: Kuroe.
Status: historical measurement of the named baseline, not implementation
or release approval. No production server/runner/peer access or admission
guard changes occurred during the experiment.

## Decision

**Hand-back: available in auto mode.** The previous 2.1.284 measurement's
`bypassPermissions` composition explains its missing SubagentHandback tool.
Using the same installed CLI in `auto`, with empty settings sources and an
isolated HOME, exposes the tool and produces native hand-back hooks and
peer-origin results. ai-settings hooks/skills are not necessary for this
positive case. This is a measured sufficient condition, not an exhaustive
list of feature gates for every account, agent type or deployment.

**Incident mechanism: available / reproduced.** With two native background
Agents and staggered completion, the first hand-back opens a native turn.
A subsequent task notification folds into that turn with the same hook
`prompt_id`. Its result retains the opener's peer origin. The unchanged
production release host then logs `notification result lacks task-notification
ownership; closing admission`, closes the SDK and prevents the second
Agent from finishing. Runs A4 and A6 reproduce this without a real API.

**Origin hypothesis: partly available, insufficient alone.** Native
`origin.senderTaskId` matches the native `task_started.task_id`, child
hook `agent_id`, and peer result sender. But in the production-default
stream it is not present on a root user message: only the result carries it.
With `extraArgs: {"replay-user-messages": null}`, a native SDK user frame
also carries it before the observed root PreToolUse hook. That frame lacks
`prompt_id`, and its `uuid` differs from the hook's `prompt_id`. The
transcript has both. Therefore origin is a useful native provenance witness,
but the complete admission-time binding to the hook/call epoch is
**unmeasured**, not a proven replacement for D6/D9 guards.

## Fixed composition and evidence

Release commit: `1f9ec026f4cc2d94c6424c7afb3247bf44b0b473`.
The probe imports that release's `runClaudeCli`, real `AgentHost`, and SDK
0.3.284. It explicitly uses that release's Linux x64 CLI 2.1.284 executable.
There is no local rebuild or host instrumentation delta. A local ServerLink
recorder replaces the network link; hook/frame/callback recorders forward
without altering their native values or product admission decisions.

Key SHA-256 values (local artifact inventory retained privately):

| Artifact | SHA-256 |
| --- | --- |
| wrapper cli.js | `65e909beb0b87e472d90b8d8738c03029a47e546350f6cbb19ff35e4ea9b7e80` |
| wrapper host.js | `c65ba67dd6ac24368d053e892850532a0e4326a05d2c510fe2b476e26e81f007` |
| SDK sdk.mjs | `32d062c37b03e10870fbf839f54694545ee01bc0ec719e47078fbed76e30ef71` |
| SDK core.mjs | `eaaef071750c68f168588c817f964ea756e11620554e715d15e8ab267b189355` |
| native CLI | `5cd90aabd83f8a15136c35aa37bb1d92b348993573316643dc3fe4e04afbf88f` |

The ten entries in `artifacts.json` were hashed before the runs and matched
afterward (`artifacts-final-check.json`). Supplemental SDK module hashes
are recorded after measurement in `sdk-module-hashes.json`; those modules
are not entries in the release's MANIFEST.json, so that manifest does not
independently verify them. No claim of a verified full dependency closure.

Raw directory: `tmp/reviews/issue-426/kogane-measure-r1/`.
`manifest.json` binds the raw events, endpoint requests, transcripts, source
revisions, settings inventory, measurements and checks. Its hash is recorded
at the end of this report. `run-revisions.json` maps each run to its exact
probe and endpoint-helper revision. Model credentials are a local dummy;
request authorization headers are excluded from recording. All model and
classifier requests use the owned 127.0.0.1 endpoint. Real provider credentials
are not inherited. The endpoint emits only fixed model text/tool calls and
classifier responses; native task frames, hooks, origins and folds are never
fabricated. Network isolation is by the sanitized process environment and
endpoint configuration, not a measured kernel firewall.

## Production versus previous loopback composition

| Dimension | Production launch / inspected configuration | Prior loopback | This measurement |
| --- | --- | --- | --- |
| Entry | Runner resolves wrapper dist/cli.js and inherits its environment | runClaudeCli + real AgentHost + local link | Imports exact production release's same composition entry |
| Permission mode | Assigned incident premise: auto | bypassPermissions | A3/A2/A4/B1/A5/A6 auto; P1 bypass control |
| Settings sources | Wrapper does not set settingSources | Explicit [] | [] except A5, where option is omitted as in production |
| User settings / HOME | User settings and ai-settings hooks/skills | Empty owned HOME | Empty owned HOME, plus A5 sanitized copied settings and prompt hooks/skills |
| Tools | claude_code preset and wrapper allowlist | Preset and explicit Agent/Bash/SubagentHandback allowlist | Same explicit allowlist for controlled local tools |
| Model | Incident agent's live model behavior | Fixed loopback responses | sonnet alias resolved by CLI; deterministic local responses including auto classifier |
| Session persistence | Normal production persistence | Disabled | Enabled only in owned scratch; transcripts retained as evidence |
| Root user echoes | No replay-user-messages extra argument | Default | Default except A6 explicit replay-user-messages |

A5 used a sanitized private copy of user/project settings, selected prompt
hooks and skills. External integrations and unrelated hooks were excluded;
the fixed model never invoked Skill. The copy is not published. This was a
partial configuration comparison, not complete production parity. A3's
positive result with empty settings establishes that this copied material
was not necessary for that observed hand-back path.

Static corroboration in the fixed executable (`cli-excerpts.txt`): the
hand-back gate checks `mode === "auto"` and the native feature gate
`CLAUDE_CODE_SENDMESSAGE_HANDBACK` / `tengu_lively_waffle`. The Agent setup
also checks the child's effective auto mode and other eligibility conditions.
No feature flag was forced on in these runs. Enumeration of every gate and
account-specific rollout state remains unmeasured.

## Observations

Counts and durations below are copied from `measurements.json`.
`null` means an absent result origin, not a synthetic human-origin assertion.

| Run | Scenario | Requests | Started / notified | Hand-back / notification hooks | Result origin sequence | Exit | ms |
| --- | --- | ---: | --- | --- | --- | ---: | ---: |
| A1 | Auto, initial classifier-response bug | 4 | 0 / 0 | 0 / 0 | null | 2 | 98517 |
| A3 | Auto, one Agent | 8 | 1 / 1 | 1 / 1 | null, peer, task-notification | 0 | 2948 |
| A2 | Auto, two Agents, staggered | 14 | 2 / 2 | 2 / 2 | null, peer, task-notification, peer, task-notification | 0 | 7782 |
| A4 | Auto, two Agents, fold at root Bash boundary | 10 | 2 / 1 | 1 / 1 | null, peer | 0 | 5676 |
| B1 | Auto, background Bash | 3 | 1 / 1 | 0 / 1 | null, task-notification | 0 | 5473 |
| P1 | Bypass, one Agent, same hand-back attempt | 5 | 1 / 1 | 0 / 1 | null, task-notification | 0 | 5914 |
| A5 | Auto, copied settings/prompt hooks/skills | 8 | 1 / 1 | 1 / 1 | null, peer, task-notification | 0 | 3053 |
| A6 | A4 schedule plus replay-user-messages | 10 | 2 / 1 | 1 / 1 | null, peer | 0 | 5643 |

A1 mistakenly answered auto classifier requests as child-agent requests and
used a streaming response for non-streaming classifier requests. The CLI
refused Agent with `Classifier unavailable`; no subagent started. This is a
probe failure and consumes a root attempt. Later runs recognize the actual
classifier request (no tools) and return the requested harmless local
`<severity>0</severity>` response as ordinary JSON. This permits only the
controlled scratch actions; it measures neither classifier accuracy nor
real-model behavior.

P1 exposes no SubagentHandback child tool and returns an unavailable-tool
error to the attempted call, then delivers an ordinary task notification
when the child finishes as text. A3 exposes and successfully executes the
native tool with otherwise matching empty settings. A2 demonstrates that
a hand-back and its notification can each have independent native turns.
B1 is the non-hand-back background-task control.

## Fold and native identity example (A6)

Native values:

- Session: `1b2a25bc-ebe6-4196-bca8-a2c39f97222c`.
- Task A: `a7b7ee4f297d6d193`.
- Root Agent tool-use ID: `toolu_7b0c64a0444a407f9352208db7d0e878`.
- Child hand-back tool-use ID: `toolu_45c9fd542c964b9b9bc21d6789183793`.
- Hand-back root hook prompt ID: `43f44fb3-0405-40fd-95c1-ec1106c4bb6f`.
- Echoed root user UUID: `5340c293-1db6-4fb4-83f2-fc88fe629079`.

The native task_started record binds the task to the parent Agent tool call.
The child Pre/PostToolUse records bind SubagentHandback to `agent_id=Task A`
and its own native tool-use ID. Its SDK tool result uses the parent Agent's
ID as `parent_tool_use_id`; the PostToolUse response says success=true.

Timeline, milliseconds from probe start:

1. 2133: child PreToolUse SubagentHandback.
2. 2148: child PostToolUse reports successful delivery.
3. 2212: root UserPromptSubmit for the hand-back, with new prompt ID above.
4. 2241: loopback endpoint emits root Bash response. The model request has
   already happened at this point.
5. 2244: SDK emits replayed root user message with `origin` below.
6. 2247: SDK emits root assistant tool call; 2249: its PreToolUse hook uses
   the hand-back root prompt ID.
7. 2468: native task_notification frame for Task A.
8. 3314: notification UserPromptSubmit reuses the hand-back prompt ID.
9. 3319: SDK echoes the folded notification with task-notification origin.
10. 3338: result origin is still Task A's peer origin. Host subsequently
    closes admission and its SDK process; Task B has started but does not
    produce its scheduled completion or hand-back.

Observed hand-back origin (body omitted here, retained raw):

```json
{"kind":"peer","from":"a7b7ee4f297d6d193","senderTaskId":"a7b7ee4f297d6d193","handback":true}
```

The echo has `isReplay=true`, `isSynthetic=true`, null parent_tool_use_id,
session_id and uuid. It has **no prompt_id**. The hook has prompt_id but
**no origin** (nor prompt_source in these actual hook payloads). The
transcript's root user row carries origin, uuid and promptId together;
reading the transcript is a different surface and its availability before
a tool call was not measured. A4 reproduces the same fold/close without the
replay option, ruling out that option as necessary to trigger the failure.

## D6/D9 implications and limits

| Capability / claim | Verdict | Boundary |
| --- | --- | --- |
| Native hand-back with empty settings in auto | available | Actual CLI hooks, task/result records; P1 negative mode control |
| Root user origin in default SDK stream | unavailable in measured composition | Positive hand-backs exist but root user echoes do not |
| Root user origin with replay-user-messages | available | A6, native echo before observed root tool hook |
| senderTaskId to native task/child lifecycle correlation | available | A6 values match without parsing model-authored body |
| Peer opener retains result ownership when notice folds | available | A4 and A6 same-ID fold, peer result |
| Full admission-time root prompt/call binding using only origin | unmeasured | Echo lacks prompt_id; hook lacks origin; ordering is not a general cross-channel contract |
| Strong unique per-occurrence terminal key | unmeasured | senderTaskId identifies a task, not necessarily a unique resumed turn |
| Result-origin-only admission before a tool call | unavailable | Result arrives after calls and cannot authorize them retrospectively |
| Full production hooks/plugins, resume/repeat/replay adversaries, cross-session peers, child SendMessage | unmeasured | Outside this bounded comparison |

Kuroe's hypothesis is supported as a native provenance component. It is not
supported as a complete standalone replacement for the completed-input
ledger, immutable call bindings, session/generation checks, root/child
isolation, retirement, same-ID fold behavior or opener-owned terminal rule.
The implementable direction should preserve those invariants and specify
exactly where the host joins the origin witness to the root hook epoch.
Do not equate every peer origin with an in-process subagent; require a
validated native task relation, not only kind=peer. No guard removal or
rollout is authorized by this report.

## Verification, budget and cleanup

- Eight root attempts consumed, including A1. SDK window:
  `2026-09-29T10:42:03.402Z` to `2026-09-29T10:44:57.935Z`, 174.533 seconds,
  below the announced 20-minute total limit. B1/P1 overlapped briefly;
  budget.json retains both reservations.
- **Per-run budget deviation:** A1's 89-second in-process timer actually
  fired at 98190 ms and the run finished at 98517 ms. This exceeded the
  announced 90-second per-run wall-clock limit. The in-process timer was
  not an effective hard wall-clock boundary; no cause of its delay was
  established. No additional root attempt was made after the eighth.
- `python3 .../check.py`: exit 0, no warnings/unhandled errors. It reads
  the actual native recordings and checks mode contrast, sender/task/child
  identity, fold IDs, result origin, the real host close diagnostic, and
  finished process counts.
- `python3 .../check.py --negative`: exit 1 with the expected AssertionError
  after changing only the echoed senderTaskId to an unknown task in memory.
  Raw files remain unchanged. Restored invocation: exit 0, no warnings or
  unhandled errors (`check-restored.json`). This is a disposable evidence
  checker, not a production admission guard.
- All runs emitted SDK allowedTools/canUseTool shadowing warnings. Native
  host invariant diagnostics and unrecognized task_updated warnings are
  retained in run logs and `diagnostics.json`; A4/A6 additionally contain
  the expected ownership-close diagnostic. Exit 0 for those probes means
  the observation process finished, **not** healthy product behavior.
- Every SDK child had exited at probe finish (zero retained children).
  Owned HTTP listeners were closed. Runtime scratch HOME/config/skills,
  caches and task outputs were removed: 10700420 bytes. No worktree was
  created. Retained raw evidence and transcripts are intentional review
  artifacts under the directory above; the director removes them when
  this review/issue closes. `cleanup.json` records the removed path.

Raw manifest: 63 files, SHA-256
`c2e09e05dd3c3bffd66da4e3c2dd2fad9618a104e75a578bb435e3e4d26d149a`.

## Related evidence and source binding

This auto-mode measurement follows the earlier
[background-task shape report](2026-09-29-cli-2-1-284-shapes.md), whose
non-occurrence conclusion remains scoped to its bypass-permission runs.
[Round 2](2026-09-29-handback-measurement-r2.md) tests ordering and resume;
the [direction-review record](2026-09-29-handback-direction-review.md)
separates measured facts from the implementation decision.

This publication is a sanitized adaptation of
`tmp/reviews/issue-426/measure-r1-kogane.md`, SHA-256
`f5a39ee0787852bb855ddaa2aeb141424c9689cacd780bc59e63ee4839eb2e27`.
Local raw references are provenance pointers, not downloadable repository
artifacts. Raw logs, configuration copies and probe scripts are deliberately
not committed. The manifest identifies the retained evidence; it does not
make that private material publicly available.
