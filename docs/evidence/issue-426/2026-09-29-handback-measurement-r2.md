---
title: Claude CLI 2.1.284 hand-back ordering and lifecycle measurement
description: Two-child folds, same-task resume, foreground delivery, fail-stop and early-input observations.
status: measured
last_updated: 2026-09-29
---

# Claude CLI 2.1.284 hand-back ordering and lifecycle measurement

Date: 2026-09-29. Owner: Kogane. Director: Kuroe.
Baseline: `1f9ec026f4cc2d94c6424c7afb3247bf44b0b473`, SDK 0.3.284,
CLI 2.1.284. Historical measurement only; no product changes during the experiment.
This page is not implementation or release approval.

## Decision

**Keep stage 2 disabled.** A native task-origin witness before a root tool
is available on the measured schedules. A complete, ambiguity-safe join
from that witness to the *opener and occurrence* remains **unmeasured**.
The echo has no hook `prompt_id`, and a later hand-back can produce an
otherwise similar peer echo while folding into someone else's turn.
This is not a finding that every possible native admission design is
unavailable; the proposed enabling gate has not been established.

New native facts that affect the design:

- Two hand-backs can share one root hook ID and retain the first sender
  on the result. An interposed notification does not change that owner.
- Same-task `SendMessage` resume produces distinct hand-back call IDs
  with the same task ID and identical report text. Restarting the SDK with
  session resume preserves the session/task IDs but resets `result_index`.
- Foreground Agent also exposes and uses SubagentHandback. In the measured
  foreground schedule its report folds into the wrapper-owned turn;
  the result has no peer origin.
- Actual fail-stop closes input and visibly emits `error`, but does not
  immediately kill the native process. Its child subsequently attempts a
  report, receives a tool refusal, finishes **without delivering that
  report**, and the CLI exits normally. Child survival is not report
  preservation. Runner restart behavior remains unmeasured.
- An ordinary wrapper input queued after a successful child hand-back
  but before its root hook can be admitted by the old host, then actually
  fold into the peer-origin turn. The old host ends that wrapper token
  on the peer result. A consumed-input receipt is not opener ownership.

## Availability by premise

Here, available means observed for the stated scope; unavailable means
absent or contradicted in that scope; unmeasured means no adequate answer.
None of these labels grants production send authority.

| Premise / surface | Verdict | Evidence and limit |
| --- | --- | --- |
| P13: native peer origin before first root PreToolUse | available | R01, R02, R04, R05, R06: echo precedes the tool hook by 4–6 ms |
| P13: explicit hook/echo occurrence key in the root user frame | unavailable | Those echoes contain task origin and UUID, but no `prompt_id`; UUID differs from hook ID |
| P13: production-default echo | unavailable | R03 disables replay and has no peer user echo; peer result still exists |
| P13: universally stable ordering / safe opener-and-occurrence join | unmeasured | No genuine simultaneous fresh-ID root overlap, native enabled-echo loss/delay, or unrelated ownerless opener with a pre-first-tool hand-back fold was reproduced |
| P13: ordinary input / forged body separation | available | R02/R04: ordinary input folds after hand-back; R12: forged wrapper body has no native peer origin, genuine report later folds under wrapper ownership |
| P13: standing replay option cost | unmeasured | R04 bounds a large-prompt, multi-turn example; R08 covers one session resume. Neither is a production performance gate |
| P12: two-task folds and opener-owned result | available | R05/R06: two native echoes, same hook ID, first sender retained on terminal |
| P12: child PreToolUse FIFO is a root ordering key | unavailable | R05's child PreToolUse order is reversed relative to successful delivery/root echo order |
| P11: same-task resume occurrence shapes | available | R07/R08: three distinct child hand-back call IDs, same task/report, new echo UUIDs |
| P11: late/old report exclusion during a new pending occurrence | unmeasured | No native replay of an old report while the next occurrence is pending |
| P9: foreground Agent report delivery | available | R09: successful hand-back, same wrapper prompt ID, originless wrapper result; broader workaround safety remains unmeasured |
| P10: fail-stop to EOF, child completion and CLI exit | available | R10 uses the actual ambiguous-result fail-stop branch, without modifying the host |
| P10: preserves the pending child's report / leaves CLI waiting indefinitely | unavailable | R10's report is refused and never delivered; CLI exits 0 after completion |
| P10: runner restart policy in execution | unmeasured | No isolated runner was launched; no inference from production anecdotes |
| P6: current cooperative-push gate / queued notice boundary | available | R11 rejects both foreign and admitted-notification live folds; queued wrapper starts after notice result |
| P6: safe barrier relaxation and receipt-to-request authority | unmeasured | R02/R04 expose wrong terminal accounting in the old host, not a replacement binding |
| P8 | available, carried forward | Existing r1 raw remains the source; no new P8 run was allocated |

## Composition, scope and provenance

The probe imports the fixed release's `runClaudeCli`, actual `AgentHost`
and installed SDK, and uses its native Linux CLI executable. `paths.json`
and `artifacts.json` retain the private local inventory and SHA-256. All eight pinned
entries matched again after the runs (`artifacts-final-check.json`).
The SDK entry/core and native executable are pinned; this is not a claim
that every transitive dependency was independently verified.

The ServerLink seam is an in-process recorder. Model and auto-permission
classifier responses come from an owned `127.0.0.1` endpoint. A sanitized
environment supplies dummy credentials, isolated HOME/config/cwd/tmp and
nonessential-traffic disable flags. No real API credentials are inherited.
This is configuration isolation, not a measured kernel network firewall.
No production server, runner or peer is contacted. Native SendMessage in
R07/R08 addresses only the exact task ID observed in our owned run.

Settings sources are empty; permission mode is `auto`. The r1 A3/A5
comparison already established that copied ai-settings hooks/skills are
not required for the positive hand-back case. This round does not claim
complete production-settings equivalence. Replay is enabled except R03.
Persistence is enabled only in owned scratch so R08 can resume R07.

Hook/frame/callback observation forwards native data without fabricating
origins, hook IDs, task lifecycle events or results. Additional inputs use
public `host.send` or `host.pushLiveInput`; there is no raw SDK input bypass
and no host guard removal. The endpoint controls model outputs and timing.
For P10 it continues emitting bounded fixed child text after the refusal;
that is a harness behavior, not a claim about what a live model would do.

Each `RNN.probe.mjs` is the exact executed source, with its hash in
`budget.json`. `common.mjs` contains the endpoint/environment helper.
`supervise.py` runs each attempt in its own process group, counting failed
launches and SDK session resume as roots. Scripts are disposable
measurement tools, not proposed product code.

## Run ledger and budget

The director approved the allocation before execution; the run ledger and
stop conditions were communicated before the first launch.
Limit: 12 root launches / 90 minutes. Internal timeout: 110 seconds;
independent supervisor: TERM at 120 seconds, KILL after 5 seconds if needed.
The supervisor also checks the overall deadline. A conservative deadline
of 88 minutes from local budget initialization leaves room for the earlier
notification. No timeout was reached; timeout enforcement was not forced
as a separate native experiment.

Exactly 12 roots ran. First launch to final finish: **295.099502 seconds**.
Sum of supervisor run durations: **53,297 ms**. All native probe processes
and supervisors returned 0, with no supervisor group cleanup required.
These are successful measurements, not twelve successful admissions.

| Run | Planned purpose / realized schedule | Outer duration ms | Model/classifier requests | Task starts / notices | Peer echoes | Result origins in order |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| R01 | P13, one hand-back then root tool/notification fold | 4224 | 8 | 1 / 1 | 1 | none, peer |
| R02 | P13, ordinary wrapper queued after E2 | 4173 | 8 | 1 / 1 | 1 | none, peer |
| R03 | P13, native replay-disabled control | 3975 | 8 | 1 / 1 | 0 | none, peer |
| R04 | P13, eight prelude turns plus large prompt and wrapper overlap | 4979 | 16 | 1 / 1 | 1 | nine none, peer |
| R05 | P12, near-simultaneous child reports | 4475 | 12 | 2 / 2 | 2 | none, peer |
| R06 | P12, reversed delay order; notification interposed | 4375 | 12 | 2 / 2 | 2 | none, peer |
| R07 | P11, same-task SendMessage resume, identical report | 4925 | 14 | 2 / 2 | 2 | none, peer, notice, peer, notice |
| R08 | P11/P13, actual SDK session resume and same-task restart | 3372 | 7 | 1 / 1 | 1 | none, peer, notice |
| R09 | P9, foreground Agent | 3272 | 6 | 1 / 1 | 1 | none |
| R10 | P10, real fail-stop while child model request waits | 8132 | 9 | 1 / 1 | 0 | none, notice |
| R11 | P6, cooperative push attempts and queued wrapper | 3222 | 9 | 1 / 1 | 1 | none, peer, notice, none |
| R12 | Reserve: P13 forged wrapper body then native fold | 4173 | 8 | 1 / 1 | 1 | none, none |

“Notice” means `origin.kind = task-notification`; “none” means no origin
field. Task starts count native start events, including same-task resumes,
not unique children. R12's body-based `rootHandbacks` debug counter also
counts its deliberately forged wrapper text; the table uses native peer
origin instead. No retry was performed. A refused R13 supervisor invocation
failed before spawning and left the launch count at 12 (`budget-negative.log`).

## P13: what is available before the tool

All times below are run-relative milliseconds. `RNN.events.jsonl` line
references and extracted values are in `check.json` → `order`.

| Run | Root hook | Endpoint model response | Native echo | Root PreToolUse |
| --- | ---: | ---: | ---: | ---: |
| R01 | 2010 | 2034 | 2036 | 2041 |
| R02 | 1866 | 1893 | 1895 | 1901 |
| R04 | 2645 | 2682 | 2685 | 2691 |
| R05 | 2499 | 2531 | 2534 | 2539 |
| R06 | 2391 | 2415 | 2418 | 2422 |

The recorder does **not** timestamp root request arrival separately.
The response timestamp proves that the request was already received by
then. Thus these echoes are before PreToolUse but **after the model
request has already begun**. They cannot retroactively change the prompt
or completed-input snapshot used by that request.

R01 lines 55/58/59/63 provide the compact example. Echo fields include
`isReplay: true`, `isSynthetic: true`, null parent, session ID, UUID and
`origin: {kind: peer, handback: true, senderTaskId, ...}`. The sender joins
to native `task_started` and child hook `agent_id`. There is no explicit
hook ID or hand-back call ID in that echo. Task provenance is available;
opener/occurrence ownership is a separate claim.

R02's ordinary wrapper input is yielded at 1826 ms, after successful E2
but before the hand-back root hook at 1866 ms. The wrapper hook actually
arrives at 2962 ms under that hand-back's prompt ID, and the peer result
at 2990 ms ends the wrapper token (`onTurnEnd`, line 93). R04 repeats this
with preceding history. These runs do not produce the requested opposite
case of an unrelated **ownerless** opener receiving a pre-first-tool fold.
They do show why stage 1 must handle an already allocated wrapper token
when a different native root hook appears; an ownerless-only flag is not
the whole overlap policy.

R12 supplies forged wrapper text naming a real native task. Its replayed
user frame at 890 ms has **no origin**. The genuine peer echo arrives at
2961 ms under the same wrapper prompt ID; the result at 2978 ms is
originless. Text resemblance is not native provenance, and native task
provenance later in a turn is not evidence that the task opened it.

R03 is a real missing-echo configuration control. For artificial delayed
or dropped observations, `check.py` also records a deliberately limited
offline calculation: R01's observed echo is before its tool; removing it
or placing it after that first tool leaves no pre-tool observation. This
is **not** a native loss/delay experiment, nor an implemented admission
guard test. Genuine enabled-replay loss/delay and simultaneous fresh-ID
root overlap remain unmeasured. No script introduces an origin-bearing
fake frame to claim otherwise.

R04 uses eight prelude turns and an initial 8,000 repetitions of a local
history token. Python JSON serialization of its replay frames totals
118,192 bytes (`check.json`); this is neither exact wire traffic nor RSS,
latency overhead, token billing or a long-session production benchmark.
R08 has one new peer echo; old R07 peer echo UUIDs are not replayed in that
sample. Other resume/history behavior is unmeasured.

## P12: two hand-backs and an interposed notification

R05 child PreToolUse hooks arrive for `a0f324118b933ffb4` at 2380 ms,
then `a86f499c0117017d7` at 2385 ms. Successful PostToolUse order reverses:
`a86...` at 2404 ms, `a0f...` at 2406 ms. Root echo order follows those
successful deliveries, not PreToolUse FIFO. Two samples do not prove a
universal PostToolUse FIFO either.

R05 root hooks at 2499 and 3601 ms share prompt ID
`01cd5088-62c4-41d5-9b0b-32bbade8ad53`. Echoes name different senders
at 2534 and 3609 ms. Result at 3627 ms names the first sender, `a86...`.
Both task-notification hooks fold into the same prompt ID.

R06 has a notification echo at 3490 ms, then the second peer echo at
3490 ms, then another notification echo at 3491 ms (lines 117–119).
The terminal still names the first peer sender. Consequently a second
peer echo can be a legitimate fold. A rule that always treats it as a
new opener, or accepts any sender seen during the turn on the result,
is contradicted. Stage 2 still needs one explicit policy for the second
echo; the contradictory alternatives in r2 §2.4 cannot both govern it.

## P11: same task and session resume

R07 starts `ac17305901b0cf07d`, receives a report, and resumes it through
native SendMessage from the notification turn. A second `task_started`
names the same task but a new root SendMessage tool-use ID. Each child
hand-back has a distinct call ID. Both peer echoes and peer results name
the same task; report text is identical. R08 starts a new SDK process with
`--resume=ebf90b12-522a-4cf0-b74d-0f7df9815d78`, addresses that same owned
task, and produces a third report. `check.json` binds all three child
call IDs and raw line numbers; all three echo UUIDs differ.

R07 result indices are **0, 1, 2, 3, 4**; R08 indices are **0, 1, 2**,
with the same session ID. Index monotonicity is per SDK run here, not
per persisted session. Host generation must therefore scope retirement,
occurrence accounting and terminal checks. Repeated text/task identity
cannot distinguish occurrences. No late old echo while another occurrence
is pending was generated; occurrence-replay rejection remains unmeasured.

## P9, P10 and P6 operational consequences

**P9:** R09 native `task_started.is_backgrounded` is false. The foreground
child has SubagentHandback available, delivers successfully at 1884 ms,
and completes at 2065 ms. Its hand-back hook at 2072 ms uses the original
wrapper prompt ID. The peer echo at 2077 ms folds; the sole result at
2100 ms has no origin. There is also a native task-notification frame,
but no separate notification root hook in this sample. Foreground did
not reproduce the close failure here. This does not establish safety for
all foreground schedules, multiple children, interruptions or live sends.

**P10:** R10's initial wrapper prompt contains literal notification-tag
prose, intentionally reaching the unchanged host's known false-positive
ambiguous-result branch. No private method is replaced or directly called.
The real `onAdmissionFailStop` fires at 677 ms and state `error` is emitted;
SDK input EOF is observed at 678 ms. The child request is still in flight.
It later attempts SubagentHandback, but receives an error tool result
(`R10.events.jsonl` line 46 onward) instead of delivering its report.
The native completed notice at 7305 ms explicitly says no report was
delivered. The CLI exits **0** at 7375 ms, before harness cleanup, and
`runClaudeCli` closes its local link. This supports neither “immediate
abort” nor “stable manual-recovery session preserving the report.”
It shows process continuation followed by normal CLI exit, with lost
report delivery. There is no runner measurement and no P10-based approval
of step 0b in this report.

**P6:** In R11, `pushLiveInput` returns false for the foreign hand-back
at 1881 ms (no active token) and for the admitted notification at 2027 ms
(notification token present). A normal wrapper input is queued at 2027 ms;
notification terminal accounting ends at 2081 ms, then its wrapper token
starts, and its root hook is admitted at 2104 ms. No successful live-fold
receipt was produced. R02/R04's old-host wrapper misaccounting, described
above, is an additional negative example; it does not authorize a barrier
relaxation or advance a peer reply basis.

## Validation, cleanup and retained evidence

`check.py` was run against all actual raw events and executed source
revisions: exit 0, no stderr warnings or unhandled errors. Its negative
control replaces R01's observed echo sender **in memory only** with a
nonexistent task: exit 1 at the native task-binding assertion. The restored
run exits 0 (`check-negative.log`, `check-restored.json`, `validation.json`).
This pins an evidence check, not product admission. The artificial
missing/delayed-echo calculation is explicitly separate from native results.

The eight fixed artifact hashes matched after measurement. Every CLI has
an owned exit record. No broad process lookup or signal was used. The owned
runtime scratch directory was removed: **5,139,722 bytes**,
with transcript copies retained first (`cleanup.json`). No runtime scratch
remains. Raw evidence is intentionally retained for the review/issue
lifetime under `tmp/reviews/issue-426/kogane-measure-r2/`.

`manifest.json` binds **89 files / 18,560,719 bytes**: native event logs,
endpoint request bodies, transcripts, exact probe revisions, budget,
artifact hashes, checker outputs and cleanup records. Its SHA-256 is:

`76bfaf409526f6358beb0e0f34c8a3f2f21ac71745e0a055a78d1da30f002c13`

No new runs remain in this allocation. The unmeasured cases above require
a separate decision if further measurement is wanted; stage 2 stays
disabled without treating those unknowns as proof of impossibility.

## Related evidence and source binding

[Round 1](2026-09-29-handback-measurement-r1.md) records the mode contrast
and fixed binary hashes. The
[direction-review record](2026-09-29-handback-direction-review.md) records
the final stage-1 decision and the still-disabled stage-2 boundary.

This publication is a sanitized adaptation of
`tmp/reviews/issue-426/measure-r2-kogane.md`, SHA-256
`dbc921c2c3fe6575ba2129eb5fadfbb8dfd331c43fef31f3ee2877d75bdc0304`.
Local raw references are provenance pointers, not downloadable repository
artifacts. Raw logs, transcripts and probe scripts are deliberately not
committed. The manifest binds retained private evidence, not a public raw
dataset. No additional native run was performed for this publication.
