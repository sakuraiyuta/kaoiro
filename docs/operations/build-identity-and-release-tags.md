---
title: Build identity and release tags
description: Immutable build identities (landing pairs and release tags), deployment completion and recovery.
status: accepted
last_updated: 2026-10-25
related: [deployment, protocol]
---

# Build identity and release tags

[ADR-0066](../adr/0066-tag-derived-lockstep-build-identity.md) supersedes the
manual root VERSION/channel decision. Protocol version remains 0. Install the
reader bridge on server, dashboard, runner and every wrapper before starting a
new-format runner. Historical `YYYY.M.PATCH` artifacts remain readable.

## Identity

Production identity is an exact `v*` tag at HEAD. The reader accepts two forms:
a historical landing pair (an annotated `vYYYY.MM.DD.N` tag plus a same-object
`identity/landing/<full-SHA>` claim, issued for develop push tips by a retired
workflow) and a schema-2 release tag (see [Release tags](#release-tags)).
Landing pairs are immutable and stay readable; no new ones are issued.

`scripts/build-identity.mjs` is the only producer of version and branch. It
requires an exact HEAD tag (a landing pair or a release tag), not an ancestor. Tagged builds retain
the annotation's landed branch even on main or a detached ref. Untagged builds
use the build ref. Dirty, shallow, absent or inconsistent tag observations do
not claim a tagged production build. Labels are `vYYYY.MM.DD.N / branch / hash`
or `untagged / branch / hash`; the label hash has seven characters. Machine
records retain the full 40-character revision and dirty flag. `channel` remains
for old readers and does not authorize a production release.

## Release tags

A schema-2 release tag
([ADR-0069](../adr/0069-reduce-release-publication-and-native-state-protection.md))
is created at release time on the released commit and is the production version
source for commits released after the cutover recorded in the
[release notes index](../release/README.md).

A release tag is an annotated, unsigned `vYYYY.MM.DD.N` tag whose message is
exactly one compact JSON object with exactly these keys:
`{"schema":2,"kind":"release","repository_id":1343265983,"revision":"<40-hex>","branch":"develop","version":"YYYY.MM.DD.N"}`.
The tag object is at most 4,096 bytes, its `object` and `tag` header lines
must equal `revision` and `v<version>`, and no
`identity/landing/<revision>` claim may exist. The selection of tags at HEAD
is unchanged: only `v<YYYY.MM.DD>.*` names count, and two of them refuse.
A lightweight or signed tag, an unknown schema or kind, an extra or missing
key, or a claim beside the tag degrades the identity, so `--require-tagged`
refuses. `--require-tagged` also reads the tag back from origin and refuses if
a claim appears there. A commit that already has a landing pair is released
under that tag. Frozen identities carry `release` instead of `landing`, never
both; the version string and `build_identity_formats` are unchanged, so
runtime readers need no bridge.

Plan the next tag with the read-only helper. It never creates, pushes or
fetches; it refuses a dirty checkout, a commit that already has a calver tag
or a landing claim locally or on origin, and it prints the commands for the
release operator:

```sh
node scripts/release-tag.mjs plan [--revision <40-hex>] [--day YYYY-MM-DD]
```

`N` is one more than the highest number among origin's tags of that UTC day.
A local-only tag of the same name on another commit makes the printed
`git tag` fail rather than create a second tag; remove the stray local tag
after checking it.

## Coordinated production builds

From a clean, reviewed checkout, fetch the exact landing or release tag before downtime.
Freeze one JSON outside the checkout and consume it across the complete build:

```sh
node scripts/with-build-identity.mjs --require-tagged -- sh -c 'pnpm -C wrapper build && pnpm -C runner build'
./scripts/build-runner-tarball.sh --require-tagged --target linux-x64
```

The tarball builder coordinates its own fan-outs. For a pre-frozen identity,
pass `KAOIRO_BUILD_IDENTITY_FILE` and its SHA-256; consumers must not recompute.
The server deploy builder passes that same document as
`KAOIRO_BUILD_IDENTITY_JSON` and all five compatibility scalar fields into
Compose. The Docker Node stage writes `/app/build-info.json` with a JSON
serializer and Vite consumes the same document. The final image copies that
file rather than reconstructing it with shell interpolation. Source checks
before and after a coordinated build refuse a changed revision or dirty state.

Generated archive VERSION/revision files, manifests, physical release IDs and
Codex transaction IDs remain in use; the manually maintained repository VERSION
is removed. `--allow-dirty` explicitly selects development activation. Rollback
of an already retained release keeps its recovery contract.

Use `current/deploy/kaoiro-runner-launch.sh --version --json` for full-SHA
attestation. A legacy CLI may instead use the pinned physical release's baked
JSON and matching archive VERSION. A human label is never parsed as authority.
Health and register must independently match the target full SHA: running a
CLI subprocess alone does not prove the live runner registered.

## Reader compatibility and rollback

Health reports `build_identity_formats`. Before stopping the old runner, the
updater checks this server declaration for a new-format candidate. Deploy
checks the target image declaration against a fresh connected host/wrapper
snapshot before STOPPING and before each rollback path. Unknown/missing registered
versions refuse even if the target accepts both known formats. Refresh that
runner/wrapper's registration using a bridge-capable release, inspect the
reported machine identity and retry; do not relabel an unknown version as
legacy. If refresh is unavailable, stop and confirm the incompatible fleet
before explicitly using `--fleet-stopped`. The snapshot uses
bounded registry calls and an outer Docker timeout; failure releases the lock.

A server predating the bridge cannot be restored under incompatible live
runners/wrappers. `--fleet-stopped` is a separate explicit execution-card
statement: the operator must stop/revert the incompatible fleet first.
`--maintenance-approved` and `--confirm-restore` do not imply this permission.
Invalid target image identity is never waived. Restore known old artifacts;
do not move a landing tag to make rollback pass.

For the first bridge upgrade from a server without `ReleaseFleet`, the execution
card must order these steps: stop every required runner and confirm that their
cgroups contain zero wrappers and every dashboard tile is offline; update the
server with `--fleet-stopped`; update the runners; then run the canary. Use the
flag only after both stop observations pass. A missing legacy RPC fails closed
without the flag. Subsequent upgrades from a bridge server omit the flag and
must obtain the live compatibility snapshot. Never carry this first-upgrade
exception into ordinary execution cards.

## Deployment completion and legacy descriptors

Use the ordinary server update/rollback and runner update/rollback procedures.
Completion requires the server health identity, runner registration and required
wrapper acceptance to match the reviewed target. Detached `ENQUEUED` means only
that submission succeeded: inspect the worker result and perform those checks.
High-risk changes also require the [canary](high-risk-change-release.md#4-release-with-a-canary-stage).
Release tags and release notes record the operator's release decision; there is
no completion collector, common receipt or enrolled admission gate.

Server build/start/update/rollback/status checks only whether the fixed
`.kaoiro-release-authority.json` descriptor exists under the server directory.
Runner bootstrap/update/switch does the same for `release-authority.json` under
the install root. A file, directory or dangling link emits one fixed stderr
warning that enrollment is retired and the legacy descriptor is ignored.
Metadata-read failure also warns without blocking the ordinary operation.
The code neither parses the descriptor nor starts an exporter, consults old
history, or removes old files. Each entrance warns at most once; a nested
updater/switch can each warn. Stdout remains machine-readable.

Legacy completion records, release locks, descriptors and tool directories are
inert to these commands. They do not waive ordinary locks, artifact checks,
health checks or native-state restrictions. Do not use old release-specific
flags: they fail as unknown arguments before mutation. Returning to older tools
can reactivate their enrollment behavior if descriptors are restored into active
paths; keep archived enrollment state out of those paths.

Machine consumers must no longer expect status `lockAuthorityError`,
release-kind entries in `locks[]`, or update dry-run `releaseReconciliation`.
Ordinary deployment lock/status fields remain. New server journals omit
`release_context` and `release_reconciliation`. They retain the fixed
`invocation.release_authority: null` literal permanently so pre-retirement
readers can discover an unfinished journal. This field does not authorize an
operation. Current recovery ignores old release metadata and renders ordinary
repo/config/target/transaction arguments; phase and explicit restore approval
restrictions still apply. See [server recovery](server-update-and-rollback.md).

## Repairing a malformed reserved tag

Do not move a valid `v*`, `identity/landing/*`, `release/*` or
`identity/release/*` ref to another commit. Preserve `git ls-remote --tags origin`
plus the annotation of the exact bad ref, and compare it with the release note
before deciding whether it is malformed. A production build refuses a malformed
reserved ref rather than skipping it.

If a malformed ref must be removed, the operator first exports the active tag
ruleset and its bypass identities with `gh api repos/sakuraiyuta/kaoiro/rulesets`.
The operator temporarily excludes only the exact reviewed malformed ref from
the immutable tag rule, without adding a principal-wide bypass, then deletes
only that ref with
`git push origin :refs/tags/<reviewed-malformed-ref>`. Restore and independently
verify the original ruleset immediately. Record the old object ID, evidence,
approver and restored ruleset in the incident. A missing ruleset, ambiguous
identity or a valid ref stops this procedure; agents do not change rulesets or
delete public tags. Issue a new build only after the tags at HEAD read cleanly
again.
