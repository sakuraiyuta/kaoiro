---
title: Reduce release publication and native Codex state protection to what releases and wrapper start/resume need
status: proposed
date: 2026-10-22
opened: 2026-10-22
supersedes: []
superseded_by: null
related_specs: [deployment]
related_adrs: [53, 66]
---

# ADR-0069 — Reduce release publication and native Codex state protection

## Context

[ADR-0066](0066-tag-derived-lockstep-build-identity.md) derives build identity
from a landing tag issued for every develop push, and adds a production
completion receipt published through an operator-dispatched workflow. The
native Codex state layer
([issue #468](https://github.com/sakuraiyuta/kaoiro/issues/468)) grew
acceptance receipts, restore lineage, legacy handling and evidence-gated
retirement around its snapshot and restore. The runner's six Codex state test
files account for 90.2% of its accumulated test time
([issue #704](https://github.com/sakuraiyuta/kaoiro/issues/704)).

On 2026-10-22 the operator chose option A of
[issue #709](https://github.com/sakuraiyuta/kaoiro/issues/709) and asked that
native Codex state protection be reduced to what a wrapper needs to start and
resume. The receipt-to-dispatch path has never published (0 workflow runs, no
`release/*` tag, measured 2026-10-22).

## Decision

Proposed; the inventory, boundary, landing units and measurements are in the
[issue #709 plan](../plans/issue-709-release-reduction.md).

1. **Keep** lockstep updates (server and runner at one commit), full-SHA build
   identity with one frozen identity per coordinated build, reader-format
   compatibility checks, the exact-tag requirement for production builds and
   activation, and the immutable tag ruleset.
2. **Replace** the landing tag as the version source with a production
   release tag `vYYYY.MM.DD.N`, created at release time on the released commit
   with a schema-2 annotation and no claim ref. Historical schema-1 landing
   pairs stay valid. Release records are the release tag and the release note.
   The reader lands first and changes nothing by itself. Using schema-2 tags
   and stopping allocation wait until every server and runner installation is
   confirmed not enrolled (or is de-enrolled with the current tools) and tag
   creation by the intended principal is measured in a disposable repository
   with the same ruleset.
3. **Retire** per-push landing allocation, hourly reconciliation and landing
   repair; the completion receipt, enrolled release authority, canonical
   history, retained worker and lifecycle commands; the
   `production-release.yml` dispatch; and the `KAOIRO_*` repository-variable
   gates.
4. **Bound** native Codex state protection by nine invariants (plan section
   4.1): usable home at launch; a differing native binary only as a safe
   forward over a verified snapshot, a return before the candidate's start
   was requested, or a restore when the start was requested or is unknown,
   told apart by a durable start intent; credentials never rolled back; no credentials in snapshots and fail-closed classification; copy and
   replace only with the runner stopped and its cgroup empty; verified
   snapshots; resumable, non-destructive replacement; the live home, the
   next-start home and the snapshotted or restored home are the same path; the snapshot's release is kept and a harmless failure
   restarts the unchanged source.
5. **Retire** outside that boundary: acceptance evidence and binding receipts,
   restore lineage, legacy and barrier handling, the pre-stop foreign-UID walk,
   migration diagnostics, file-identity binding of the unit and `runner.env`
   (the home path checks stay), and evidence-gated retirement and
   abandonment. The phase machine shrinks to eight states and records move to
   `codex-state/v2/`; old records are never converted. State-aware operations
   require explicit next-start `CODEX_HOME`; an absent explicit home refuses
   Codex spawn during replacement. Retained snapshots protect their source;
   unfinished forwards also protect target/tool, and restores protect the
   admission release/tool. Explicit terminal snapshot prune keeps records and
   every aside, with retryable durable deletion intent.

## Consequences

- Non-release develop builds are `untagged`. A production update first
  creates the release tag. Hand-made `v*` tags are the intended authority, so
  claim-based detection of them ends.
- No machine-checked completion evidence or unfinished-attempt admission block
  remains; deployments rely on the existing per-operation health, attestation
  and registration checks and on the release note.
- A pin update completes when the updater's own start check passes; the
  operator's first-turn and resume check becomes a runbook step, not a gate.
  The updater's own check does not prove that a turn ran or a thread resumed.
  Editing `runner.env` without changing the home path no longer strands
  rollback points. Restoring an older
  snapshot is allowed and quarantines newer threads.
- The four receipt/lineage/legacy suites retire after their retained invariants
  pass in replacement tests, including interruption and boot boundaries. The
  CI effect is measured after the native units land.
- [Issue #707](https://github.com/sakuraiyuta/kaoiro/issues/707) should not start; closing or re-scoping it is proposed. Its target is retired only when N2 lands.
  [Issue #695](https://github.com/sakuraiyuta/kaoiro/issues/695) L1b, L4 and L5
  are unaffected by the boundary; L2 and L3 are re-scoped to the smaller
  machine; their open defects are carried into the reduced contract.
- Each landing unit is a separate issue. Disabling workflows, changing
  repository variables and production steps remain operator operations with
  their own approval.

## Status gates

This ADR stays `proposed` until the design review passes and the operator
records the decision points of plan section 8. Using schema-2 tags and
stopping allocation additionally wait for the enrollment check (U2) and the
tag-creation measurement (U6) of plan section 9.

## Cutover record

Cutover C of the plan completed on 2026-10-24. C1 (U2) and C2 (U6) passed on
2026-10-22; C3 stopped tag allocation on develop landings; C4 created the first
schema-2 release tag, `v2026.10.24.1`, on
`d0c43ed3c54016df8f5cb520aa6c286890922c16`. `v*` tags before that commit mean
"landed" and tags from it on mean "released"
([release notes](../release/README.md)). This record does not change the
ADR's status, which still follows the gates above.
