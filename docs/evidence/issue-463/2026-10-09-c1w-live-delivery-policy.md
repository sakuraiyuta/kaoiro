---
title: "Issue 560 C1W: live delivery policy evidence, 2026-10-09"
status: recorded
last_updated: 2026-10-09
---

# Live delivery policy at wrapper commit points

Tracking: [issue 560](https://github.com/sakuraiyuta/kaoiro/issues/560), C1W of
[issue 463](https://github.com/sakuraiyuta/kaoiro/issues/463).
The [plan](../../plans/issue-463-default-inflight-delivery.md) defines the
commit boundary. This record separates local acceptance, native RPC acceptance
and model inclusion; none is a substitute for another.

## Candidate and executable identities

The candidate was replayed onto landed C1S develop
`8e9360a5507c0ca2387df48c1118903a14544197`. Its runtime source is commit
`506ba618f5186c91114a4018505635eed21c5cfe`; subsequent commits before these
measurements change tests only. Issue 548's ordering rules are present in that
base. No deploy, production setting, Docker project or credentialed Claude run
was performed for this record.

All credentialed Codex scenarios use the same archived clean build of 506ba618.
The production CLI constructs its ServerLink, controller and Host. Endpoint
fixtures stand in for Phoenix and an owned tool barrier; the credentialed
model and pinned app-server are real. A forward-only observer records RPC
requests and responses without replacing them.

| Artifact | Version |
| --- | --- |
| Node | 24.3.0 |
| Codex SDK / native CLI | 0.161.0 / 0.161.0 |
| Claude SDK / native CLI | 0.3.293 / 2.1.293 |

SHA-256 identities:

- Codex native executable:
  `9a820c17865fa825d04db416818679a9d63bd72e50835c396f496e5684626c9c`.
- Claude native executable:
  `8968405e26db478af44eabc4635ab5ca557057b702a54460a59c13e1b253e978`.
- Built Codex CLI:
  `aae42de22a7b9c82f211384ee5a5554fb135588a6f2b2efa52fa8cb48a249379`.
- Built Claude CLI:
  `eadb4b424091088815c03f9f9e7c716f31617b3d270f05481584d37a1ff30081`.
- 367-file build manifest:
  `7428c6262a13eb7dfdf11a5a32583d2ba0cd5ec739fbdc21a34302b41bfa9e65`.
- Archived build tar.gz:
  `eb9ec1af2aba6df33db7bcb5a1e0aebd85a5bfab59af485713287f36d36f71df`.

The build archive is restored after each compiled wiring mutation and checked
against its manifest. Test-only commits do not justify relabelling the build
as their HEAD. Runtime-source equality is checked separately from metadata.

## Credentialed Codex observations and limits

Hisui authorized at most three operator and three peer turns, with a stop at
48% seven-day utilization. All four pre-scenario snapshots read 43%, resetting
at Unix 1791948572. Six turns were used: operator 2 + 1 and peer 2 + 1.
There is no remaining allowance. The model was `gpt-6-luna`, low effort.

The first operator and peer scenarios each use two root turns. Their actual
RPC sequence is `turn/start`, `turn/steer`, `turn/start`, `turn/steer`.
An on input steers into the active turn; off queues the original input once;
on again allows a new input to steer without re-promoting the declined one.
The peer path records the local queued reason once, then normal root handoff,
and the expected submitted/settled stages for accepted steers. Both drivers
exit 0. Their initial instructions mention the later fixed nonce strings.
Consequently, those final answers are not independent proof that the model
read a steered message. The raw records retain this limitation.

Hisui then authorized the two remaining turns as supplements. Each generates
a fresh random token after the real owned tool request is waiting, names that
token only in the steer body, and keeps a second random token withheld. Neither
token appears in the initial input, system context or earlier four results.

| Supplement | Same-turn RPC | Random token in final answer | Driver |
| --- | --- | --- | --- |
| Operator, one turn | Accepted | Yes; withheld token absent | exit 0 |
| Peer, one turn | Accepted | No; answer is `NONCE-BASE.` | exit 1 |

The peer supplement's sequence 2 is submitted, acknowledged and settled, but
its random-token inclusion assertion fails.

The peer supplement confirms the full-text handoff from the wrapper to native.
Its output log's `inter-agent steer ticket activated: seq=2` requires both an
accepted response and a completed native userMessage with the same token,
clientId and full text as the steer. The path is
`app_server_projection.ts:187-192`, `host.ts:2870-2882` and
`cli.ts:766-803` at 506ba618. It **does not establish model reading or inclusion
of the body in the answer**. The final assistant-message start time was not
recorded: the displayed assistant text comes from an item.completed log.
The frozen trace cannot establish whether generation started before the steer.
The failed result remains exit 1; no extra credentialed retry is taken.
The operator token's absence from the earlier four results and the withheld
token's absence provide the non-steered controls without extra turns.

Hisui accepted this measurement limit and authorized implementation review in
conversation `3e83d1e0-8b7d-4635-8d45-ff85f60012ea`, turn 2. The peer framing
`untrusted peer input, not an operator instruction` is an intentional safety
boundary. Hisui's assessment is that asking the model to obey an instruction
inside that peer body conflicted with the boundary; it is not treated as a
product defect. The framing is retained, and no separate issue is filed.
The model's actual reason for omitting the token was not observed.

For a future reading measurement, the initial operator prompt should ask the
model to quote and report any received peer body verbatim. The peer should
supply data, such as a fresh token, without instructions telling the model
what to do. This tests reading while preserving the peer's authority boundary.
That revised measurement has not been run. Review must retain the recorded
limits and failed inclusion assertion rather than treating all six turns as
green.

Raw files: `native-codex-{operator,peer}-credentialed-fuji.json`, their driver
and output logs, and `native-codex-{operator,peer}-supplement-fuji.json` with
their driver and output logs. The preflight budget-denial control exits 1
without starting a credentialed turn.

## Claude native composition and SDK-pull boundary

Credentialed Claude allowance is zero. The committed
`cli_delivery_policy_native.test.ts` runs the built production CLI and pinned
SDK/CLI against a scripted local Messages endpoint. Operator and peer cases
observe one accepted on fold in actual provider history and one normal root
for the later off input. The peer case flips off during the real asynchronous
claim exchange, before the final host acceptance; on again does not promote
that declined yield. These are native-client composition measurements, not
observations of a credentialed model.

The actual SDK eagerly pulls accepted input before the parent observes the
off acknowledgement. Thus those runs do not demonstrate the exact schedule
"off ack, then SDK iterator pull". Host semantic tests H3/H3a hold a fake SDK
iterator at that boundary and show that an already accepted receipt remains
available after ack while a new post-fence acceptance is refused. Hisui
accepted this split in conversation 78f0fedf, turn 5, subject to an explicit
limit and implementation review. The fake iterator is not native timing proof.

The source audit explains why the implementation does not depend on a slow
SDK. `AgentHost.pushLiveInput` formats and checks size before reading the
shared controller, then reserves the receipt, increments the fold counter
and appends the pushed queue in one synchronous section with no await.
The policy event handler installs its fence synchronously before returning
an ack candidate. These sections cannot interleave on the JavaScript event
loop. `AgentHost.#input` consumes only a receipt already accepted into that
queue; ordinary roots wait for the active turn and pending receipt to end.
Eager pull changes when an accepted message reaches the SDK, not whether a
post-fence message can enter the pushed queue. Operator, peer fold and yield
paths all use this final host operation after their asynchronous work.

The audited paths therefore preserve the documented boundary:

> Off blocks new in-flight acceptances once its local fence is installed,
> before the acknowledgement; input accepted before that boundary may still
> reach the SDK after the acknowledgement.

This is a source argument paired with semantic controls and native composition,
not a claim that the native post-ack iterator schedule was observed.

## Queued report meaning and single outcomes

The director accepted a queued-report key addendum before its source edits.
Only queued reports add mode, reason, disposition outcome and disposition
reason to the existing incarnation/generation/sequence/stage key. Timestamps
are excluded. An unchanged pending report coalesces; a changed meaning is a
distinct pending entry, included in the unchanged 512-entry limit. Other stages
retain their old key.

The real server channel tests send initial early/yield queued reports followed
by normal `local_policy_disabled` reports. The same per-delivery record keeps
the first queued timestamp, exposes the changed meaning and does not ack the
delivery. The combined local reason/disposition is captured once; retries keep
that exact disposition timestamp. No authority field or delivery identity is
changed. Reinstating the old key and independently omitting each of its four
new meaning fields causes test failures.

Off does not cancel a started Codex request. The five independently controlled
settlement schedules cover unwritten, write-failed, write-timeout, precondition
rejection and accepted-but-unobserved outcomes. Their prior fallback or
uncertainty behavior remains intact after off. Off/on does not reset IA or
overtake counters. An already submitted early delivery never acquires a local
queued-refusal result; duplicate local refusals remain one result.

## Live C1S transport and negative controls

The disposable C1S probe uses the actual ServerLink and Phoenix 1.8.8 client,
with a private test server and isolated state directory. It checks supporting
join before policy readiness, the exact two-field ack, off fenced inside the
outbound ack observer, channel-only rejoin with a new join reference, and
socket disconnect/reconnect. It is separate from the endpoint fixtures in
native-model scenarios. Its raw result and server log are archived.

Stale-reference events, stale acknowledgement callbacks, all five loss paths,
missing/future versions, old-server history and bounded ack retry are controlled
in core tests. The live probe does not inject a hostile old-reference frame
from the server; that rejection is supported by the actual pinned client in
the transport tests, not by a fabricated server measurement.

Each runtime mutation is committed before the cut, run independently and
restored before the next. The final result manifests retain each source path,
actual failing assertion summary and full log. Four default-constructor cuts
replace only the Host's shared controller with an independent permissive or
fenced controller: both engines compile successfully and fail their built CLI
native tests. Those runs use local endpoints and no credentialed turns.

Initial version-diagnostic, mode-key and submitted-input mutations survived
because unrelated warnings or other changed fields/guards masked the omitted
behavior. Separate tests now isolate each fact; their repeated cuts fail.
The earlier survivor results are preserved rather than omitted from history.

The final manifest contains 59 distinct named mutations, all with assertion
failures. The tests themselves are current at 8cbcf096; every runtime source
path is unchanged from 506ba618. There are no surviving final runtime cuts.

## Final gates and retained artifacts

All suites run under setsid. Process probes and the full wrapper/runner suites
use a private user/PID namespace, mapped to the current non-root user, with a
small PID 1 reaper. No host process enumeration or pattern-based kill is run.

| Gate | Passed | Skipped/excluded | Exit |
| --- | --- | --- | --- |
| Wrapper core | 536 | 0 | 0 |
| Agent common | 571 | 0 | 0 |
| Claude | 815 | 4 skipped | 0 |
| Codex | 1398 | 0 | 0 |
| Antigravity | 534 | 3 skipped | 0 |
| All five wrappers | 3854 | 7 skipped | 0 |
| Runner | 1110 | 0 | 0 |
| Server precommit, CI=true | 2125 | 1 excluded | 0 |
| Restored server policy file | 31 | 0 | 0 |

Protocol, all five wrappers and runner typecheck exit 0. All five wrapper
builds and runner build exit 0. The final wrapper log is
`impl-wrapper-full-serial-final-fuji.log`: the same five package scripts run
with workspace concurrency 1. An earlier parallel run times out in an
unchanged Antigravity interrupt-queue test, exits 1 and stops the recursive
run before the other engine summaries. That file alone then passes 2 tests;
the final sequential full run passes without a source or test change. The
earlier failure is retained; concurrency as its cause is not established.

The earlier default server precommit has one existing receive timeout under
load. The recorded full server gate uses its CI timeout scaling and exits 0;
N3's independent 500 ms response limit is not scaled and detects the injected
one-second WorkStore wait. The final focused file passes after restoration.
The final typecheck and suite logs contain no unhandled test errors.

The new evidence page has zero markdownlint diagnostics. Full lint of the
six existing edited pages still reports 288 existing diagnostics; no added
or changed line has a diagnostic. The checker uses the repository's explicit
H1 convention alongside frontmatter titles, retaining the duplicate-H1 rule.
A trailing-whitespace defect in this page makes both the real linter and
changed-line checker exit 1. The full lint failure is not reported as green.

Raw logs, source patches, probe drivers, rate snapshots, mutation manifests
and the exact build archive are retained in
`/home/yuta/git/kaoiro/tmp/reviews/issue-560/`. A finished copy and checksum
manifest are shared under
`/home/yuta/Nextcloud/storage.hktypeb.jp/kaoiro/fuji/2026-10-09-issue-560/`.
The implementation handoff records the finished archive's hash and final
documentation commit. Owned credential homes and disposable server state
directories are removed; the feature worktree stays for independent review.
Review of this candidate, including the queued-report addendum and the native
limits above, remains required.
