---
title: Derive lockstep build identity from immutable landing tags
status: accepted
date: 2026-10-09
opened: 2026-10-09
supersedes: [56]
superseded_by: null
related_specs: [deployment, protocol]
related_adrs: [18, 53]
---

# ADR-0066 — Derive lockstep build identity from immutable landing tags

## Context

A manually maintained root version can describe several different commits. A
short revision in an operator label cannot attest a deployed artifact. The
server, dashboard, runner and wrappers must consume one identity even when a
tag arrives between component builds.

## Decision

The operator accepted D0–D6 in issue #571 on 2026-10-09. Count only successful,
non-forced develop push tips. An annotated `vYYYY.MM.DD.N` tag and its
`identity/landing/<full-SHA>` claim point to the same tag object. The tag's
bounded schema-1 annotation records the repository ID, full SHA, landed branch,
original push workflow run ID and that run's UTC `created_at`. This clock is
not the exact push acceptance time. Month and day are zero-padded and calendar
valid. N is positive, contiguous within the day and counts publication order;
it does not promise push order. Do not backfill pre-activation history.

Only `scripts/build-identity.mjs` decides version and branch. It verifies an
exact HEAD tag and claim, not the nearest ancestor. Tagged builds retain their
landed branch (`develop`) on promotion or detached builds. Untagged builds use
the build ref. The human label is `vYYYY.MM.DD.N / branch / short-hash`, or
`untagged / branch / short-hash`. Machine identity retains the full SHA and dirty
state. `channel` remains on the wire for compatibility and is not the source
of production release status. Remove the manually maintained root `VERSION`;
retain generated archive identity files and transaction IDs.

Freeze one validated JSON before a coordinated build. Dashboard, image,
runner, wrappers and manifest consume it; verify source identity before and
after building. Production builds and forward activation require a completed
landing tag. Explicit development builds remain available. Install all reader
bridges before emitting the new form. A rollback to an older server is refused
when connected runners/wrappers require a format that image lacks, unless the
operator explicitly confirms the incompatible fleet is stopped.

After server DONE/stability, actual runner worker completion and registration,
required Codex acceptance, and the operator canary checkpoint, retain a bounded,
write-once completion receipt outside ordinary transaction pruning. Publish
`release/v<landing-version>` and `identity/release/production/<full-SHA>`
atomically. A redeploy retains another attempt UUID/receipt and reuses the first
immutable release tag. HTTP dispatch success is not acknowledgment: read the
remote tag and claim back before writing `tag-ack.json`.

The host-to-Actions notifier is a separate adapter. Its S4 credential/operator
choice is pending; implementing the common receipt and receiver does not
provision a host token or enable automation.

## Trust and rollout

Privileged workflow code on develop, the allocator, and the central tag-domain
reader are trusted release-control code. Changing them is FS risk: operator
approval before landing and V6/V9 at that exact commit are mandatory. Reader
claim checks and reconciliation detect corruption; they do not authenticate a
malicious actor already able to replace trusted code.

Workflow allocation stays disabled until V9/V10 have passed, the approved
control SHA is fixed and the append-only tag rules are provisioned. Both GitHub
job admission and the control scripts require the exact gated control SHA.
No update/deletion bypass applies to immutable tags. Test GitHub behavior in a
throwaway repository, never by adding trial tags to production.

The actual default branch is develop, so landing workflows there permits
workflow_dispatch. Main promotion is unrelated operator work. This decision
does not change the default branch.

## Consequences

Production builders wait for the exact tag before downtime. All consumers need
the bridge before a new-version runner registers. A receipt/tag history counts
landed source commits, not deploy attempts. Untagged/unknown identities remain
visible without claiming production readiness. Updaters attest the full SHA;
seven-character label collisions have no authority.

See [Build identity and release tags](../operations/build-identity-and-release-tags.md)
for the current operational contract, activation gates and pending notifier.
