---
title: "Issue 559 C1S: server policy and placement evidence, 2026-10-09"
status: recorded
last_updated: 2026-10-09
---

# C1S server policy and placement evidence

Tracking: [issue 559](https://github.com/sakuraiyuta/kaoiro/issues/559), C1S of
[the delivery rollout plan](../../plans/issue-463-default-inflight-delivery.md).
This records implementation measurements on an unmerged branch; independent
implementation review and landing are pending. It authorizes no deployment.
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

## Gates

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

## Independent mutations

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
