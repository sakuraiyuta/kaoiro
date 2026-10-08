---
title: "Issue 559 C1S: server policy and placement evidence, 2026-10-09"
status: recorded
last_updated: 2026-10-09
---

# C1S server policy and placement evidence

Tracking: [issue 559](https://github.com/sakuraiyuta/kaoiro/issues/559), C1S of
[the delivery rollout plan](../../plans/issue-463-default-inflight-delivery.md).
This records implementation measurements on an unmerged branch. Independent
r1 review approved the original implementation; the pre-landing correction
awaits delta review and landing. It authorizes no deployment.
The current contracts are in [channels](../../reference/protocol/channels.md#per-agent-delivery-policy),
[server configuration](../../reference/configuration/server.md) and the
[update runbook](../../operations/server-update-and-rollback.md).

## Target and archive

Base: `9d9f8ed8dd6aa9ff471a4d198ad5e86895fa65a2`.
A: `962f457e` and `4719a4a7`. Integrated B+C:
`95ea6524a99b9bf73e3c7930e01dc067f5771f23`. Generated-env fixture correction:
`502e05c8e4ca122c47cc6ae12f9fb95edc139e8c`.
A may land first; B and C must land together. The image below was built from
the clean B+C commit. At the original gate commit, later changes affected only
an excluded test fixture and documentation. The pre-landing channel correction
below changes channel/AgentStates source; the release observations remain bound
to the measured commit and the unchanged store, placement and Docker source.

[Observations and file hashes](2026-10-09-c1s-observations.json) bind the gate
outputs, 51 individual mutations, image, live cases and crash results.
[The original placement artifact](2026-10-09-c1s-placement.json) has SHA-256
`c4a3616684104f724e6a4c23fb9fbbb9b421e744102bdbe81ab13b49d40b503b`.
Original temporary paths in recorded references identify the experiment;
their bytes are preserved here and in the archive, not at a live temporary path.

The non-secret logs and raw Docker inspections are stored at
`/home/yuta/Nextcloud/storage.hktypeb.jp/kaoiro/fuji/2026-10-09-issue-559/implementation/`.
The observations file lists every archived filename, byte count and SHA-256.
Working copies remain in `tmp/reviews/issue-559/` for review.

## Original gates

Commands run in `setsid -w`; Node deploy process tests and owned-child crash
measurements additionally run in a fresh user/PID namespace with its own
`/proc`. No process-enumerating or kill mutation ran on the real host.

| Gate | Output transcribed from its log | Exit |
| --- | --- | --- |
| `server/`: `mix precommit` | `Result: 2109 passed, 1 excluded` | 0 |
| `server/deploy/`: `LC_ALL=C node --test test/*.test.mjs` | tests 359; pass 359; fail 0; skipped 0 | 0 |
| Protocol, wrapper packages and runner typecheck | `Scope: 7 of 8 workspace projects`; all seven done | 0 |
| Focused policy/config/AgentStates tests | `Result: 93 passed` | 0 |
| Generated-env fixture test | `Result: 23 passed` | 0 |
| Production Dockerfile build, including dashboard | Private image built from the clean B+C commit | 0 |
| Live placement/release measurement | Seven cases; all assertions satisfied | 0 |
| Owned child BEAM crash/recovery measurement | Two boundaries; both reopen without revision reuse | 0 |

`mix precommit` also runs compile with warnings as errors, unused-lock cleanup
and format. The one excluded case has the existing `dashboard_build` tag;
the image build compiles the actual dashboard. Dashboard uses its own protocol
mirror and has no import of this changed shared package. Wrapper/runner runtime
implementations and their full suites were not changed or rerun by C1S.

## Original independent mutations

Each product fix was committed before mutation; each mutant ran separately,
then its original bytes were restored. The final positive gates ran after
restoration. All 51 counted mutations are red in actual suites/compiler output,
not scratch assertions standing in for the product test.

| Area | Red controls | Evidence |
| --- | --- | --- |
| Deploy gate and references | 15 | Actual update/resume call, registry, constructor, longest mount, backed-up source, `Tmpfs`, image VOLUME, aliases, digest, registration/image binding, module, contained exit, writability, legacy resume cache |
| Store and server admission | 33 | Role and queued-role checks, known agent, CAS/unchanged value, integer/exhaustion, both syncs and ordering, notification, revocation/delete/purge, existing-row preservation, join/spawn, defaults, unknown/off/unconfirmed/legacy, operator and IA routes, ack revision/owner/view/reset, delete wiring, fresh snapshot and viewer privacy |
| Shared types | 3 | Widen write policy to unknown, engine names to arbitrary strings, defaults to strings; each leaves its own `@ts-expect-error` unused (`TS2578`), exit 2 |

DETS sync/order controls use a real traced DETS table and consume the trace
messages in actual order. Channel cases exercise the production handlers,
actual WorkStore/DETS owners and authenticated server role resolution. They
assert delivered envelopes, policy pushes, revision/ack state, early quota
and yield-token cleanup. A supporting incarnation is unconfirmed until its
own exact-current ack; legacy on is the sole no-ack exception.

Two initial B+C attempts are excluded: an instruction-clamp replacement did
not match the formatted source, and removing the earlier viewer `ext` strip
stayed green because the policy branch replaces the entire extension map.
The actual instruction call and the policy branch's private-field merge
were then mutated separately; they fail five and one tests respectively.
The initial legacy-cache attempt in A was an unpinned, non-equivalent cut,
rather than an equivalent mutant. The production-resume test committed in
`4719a4a7` kills the intended cut; that final red result is included in the
15 placement controls. It is not an outstanding survivor.

The initial mutation result classifier expected a different ExUnit failure
spelling. The final checker reads actual `Failed: N tests` output and hashes
the immutable logs; its negative control substitutes a green suite log and
must refuse it. The unsuccessful attempts remain archived and are excluded
from the red count.

## Real release and Docker observations

Image: `sha256:d9c10b84b6d7fef830a9c5f87c97e393a60c7d13138156359fbb6820e16ec0e4`.
Docker Engine 29.8.2, API 1.56; Compose 5.6.0. The final disposable measurement
contains 52 forwarded real Docker commands and nine orchestration commands,
all exit 0, including removal of its volume and private image tag. The wrapper
records argv and raw output and forwards them unchanged to `/usr/bin/docker`.

| Case | Observation |
| --- | --- |
| Correct named volume plus non-shadowing sibling tmpfs | Accepted; runtime path equals Compose, selected volume is writable in the target declaration and read-only/nocopy in inspection |
| Same transaction/artifact resumed | Accepted after fresh target registry, namespace and mount observation; identical recorded binding |
| Tmp fallback | Refused before maintenance/stop; outside the named state volume |
| Nested service-key tmpfs containing the policy path | Refused; the deepest containing mount is not the backed-up named volume |
| Actual symlink under the state volume | Refused by target-release `File.lstat` observation |
| Actual application/default constructor | No constructor injection; registered store resolves to the configured persistent path, file mode 600, off revision 2 after repeated CAS |
| Fresh release process against the same owned volume | Default on backfill preserves the existing off row at revision 2 |

Six raw before/after inspection snapshots put the service-key sibling tmpfs
in `HostConfig.Tmpfs`, absent from `.Mounts`. The policy gate reads both.
The released image declares no VOLUME; the image-at/below-state refusal is
pinned by fake-Docker suite cases. The earlier approved four-case Docker
design measurement covers image and long-form tmpfs report shapes; no
unmeasured image override precedence is accepted.

The first live fixture lacked a sibling mountpoint under the read-only
state mount. Docker refused to create it. The fixture then explicitly created
that directory on its own disposable volume, and the complete measurement
reran. This conservative refusal is documented in the runbook; inspection
does not create a mountpoint in production state.

## Crash observations and limits

The driver starts each child itself, checks its reported PID equals the
returned child PID, and signals only that PID inside the isolated namespace.
Seed and recovery processes use their own DETS files and no production state.

| Boundary | Recovery |
| --- | --- |
| Counter sync for revision 2; before row write | Old off row revision 1 remains; next CAS allocates 3 |
| Accepted same-value off revision 2 | Off revision 2 remains; next CAS allocates 3 |

Both signalled children exit -9; both seed and recovery commands exit 0.
This measures abrupt process death, not power loss or disk-controller failure.
Initial disposable-driver dependency startup errors preceded any crash;
those logs are retained but supply no durability evidence.

The release path was measured with isolated Docker evaluation/application
startup. Whole transaction update/resume and both env-consistency branches
are pinned through real CLI processes with fake Docker; there was no live
production update, published port, authenticated browser session or native
model run. The live component probe supplies a fixture environment digest;
the CLI's actual environment-file hashing is covered by the process suite.
C1W applies wrapper policy, C2 renders pending, and later children
retire engine flags. C1S does not claim those stages shipped or change the
ordering rules effective at its fixed base. Independent implementation
review and a later operator rollout remain required.

Owned disposable containers, volume, private image tags and large temporary
probe directories were removed. The feature worktree and archived evidence
remain available for review and landing.

## Pre-landing availability correction

Independent r1 review observed a 1001 ms state-change reply at `943e93f4`
with WorkStore suspended, versus 0 ms at base `9d9f8ed8`. These are Ao's
measurements, not a repeated base probe by Fuji. The correction is
`8c59412d98c8374215387ecaba871ed8edeaf9d3`; the final receive-budget test
correction is `8ca1dcd49b4e09f9864b345a66257534c89de0a6`.

State/permission/question ingestion now selects and returns AgentStates'
cached server view atomically. The initial envelope uses the join/ack view,
and a newer stored view wins over that seed. Retention and broadcast use
the same result. Omitted/normal IA and explicit-normal operator commands
skip policy reads; default operator intent and non-normal admission remain
fresh. Twelve added tests include an authenticated viewer's well-formed
unknown-agent command returning forbidden without a row or counter.

| Final correction gate | Output from log | Exit |
| --- | --- | --- |
| `mix precommit` | `Result: 2121 passed, 1 excluded` | 0 |
| Focused policy/AgentStates/receive convention | `Result: 101 passed` | 0 |
| Same focused tests with `CI=1` | `Result: 101 passed` | 0 |
| Deploy, `LC_ALL=C node --test test/*.test.mjs` | tests 359; pass 359; fail 0; skipped 0 | 0 |

The final full-suite log records suspended-WorkStore replies of 138 us for
the initial unconfirmed state, 146 us after a pre-state ack, 94 us for a
subsequent state, 113 us for a permission request, and 273 us for a question.
The receive wait uses the shared CI-scaled budget; a separate monotonic
duration check requires less than 250 ms. The first full attempt found four
literal receive budgets and failed only the existing convention test. They
were corrected without relaxing the duration check; the table uses the
final rerun. Initial attempts remain archived and supply no final gate.

Eleven single changes were replayed against the final tests, all exit 2:
restore ingestion snapshot (5 failing tests), remove initial seed (4), prefer
seed to newer cache (1), make missing seed on (1), remove join seed (2),
remove ack seed (1), restore normal IA snapshot (2), restore explicit-normal
operator snapshot (1), remove viewer entry guard (2), broadcast the original
wrapper envelope instead of the retained result (5), and trust wrapper
policy before server view (2). Three additional `CI=1` runs repeat ingestion,
normal IA and explicit-normal operator cuts: respectively 5, 2 and 1 failures.
The CI ingestion cut fails the measured duration check at 1000333–1010982 us;
the blocked policy-owner cuts miss the 2500 ms receive wait. No surviving cut
is counted as red. Every cut was restored before the final positive gate.

Logs, exact changes and hashes for this delta are archived in
`/home/yuta/Nextcloud/storage.hktypeb.jp/kaoiro/fuji/2026-10-09-issue-559/implementation-r2/`.
All new test processes use `setsid` inside an owned user/PID namespace.
Suspend/resume targets are captured PIDs in that test application's BEAM;
there is no host process enumeration or signal, production deployment,
Docker probe or native model turn.

This fixes the extra per-envelope dependency, not every channel wait.
Join, ack and queued policy refresh still read policy/owner state, and an IA
send retains its pre-existing WorkStore work-stamp dependency. A cached view
can lag changes or outages and is display-only; fresh snapshots and admission
never grant permission from it. Previous Docker/store/placement observations
remain limited to their recorded source; the changed channel was not rebuilt
into that measured image. C1W's wire contract and the fixed-base ordering
rules are unchanged. Delta review remains required before landing.
