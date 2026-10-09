---
title: Build identity and release tags
description: Immutable landing identities, common production checkpoints and guarded release automation.
status: accepted
last_updated: 2026-10-09
related: [deployment, protocol]
---

# Build identity and release tags

[ADR-0066](../adr/0066-tag-derived-lockstep-build-identity.md) supersedes the
manual root VERSION/channel decision. Protocol version remains 0. Install the
reader bridge on server, dashboard, runner and every wrapper before starting a
new-format runner. Historical `YYYY.M.PATCH` artifacts remain readable.

## Identity

A successful non-forced develop push tip receives one annotated
`vYYYY.MM.DD.N` tag and a same-object `identity/landing/<full-SHA>` claim. N counts
issuance order within the original workflow run's UTC day, not push order. Use
the first push run's `created_at`, including on rerun or midnight-crossing
reconciliation. No pre-activation backfill is permitted. The allocator must
read the complete namespace, detect broken pairs/gaps and push both refs with
`--atomic`; no nonatomic fallback, force or remote deletion is allowed.

`scripts/build-identity.mjs` is the only producer of version and branch. It
requires an exact HEAD tag/claim pair, not an ancestor. Tagged builds retain
the annotation's landed branch even on main or a detached ref. Untagged builds
use the build ref. Dirty, shallow, absent or inconsistent tag observations do
not claim a tagged production build. Labels are `vYYYY.MM.DD.N / branch / hash`
or `untagged / branch / hash`; the label hash has seven characters. Machine
records retain the full 40-character revision and dirty flag. `channel` remains
for old readers and does not authorize a production release.

## Coordinated production builds

From a clean, reviewed checkout, fetch the exact landing tag before downtime.
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
snapshot before STOPPING and before each rollback path. The snapshot uses
bounded registry calls and an outer Docker timeout; failure releases the lock.

A server predating the bridge cannot be restored under incompatible live
runners/wrappers. `--fleet-stopped` is a separate explicit execution-card
statement: the operator must stop/revert the incompatible fleet first.
`--maintenance-approved` and `--confirm-restore` do not imply this permission.
Invalid target image identity is never waived. Restore known old artifacts;
do not move a landing tag to make rollback pass.

## Common production checkpoint

Server DONE/stability alone, detached runner enqueue alone and source recovery
are incomplete. Before either operation, create one attempt and fix the exact
required host inventory in the execution card. Fix `codex_host_ids` separately at start: only those hosts require completed
forward Codex acceptance. Omission conservatively requires every `host_ids`
member. Explicit `--codex-hosts` must be a subset; use `[]` for no Codex update.
The immutable attempt binds both inventories. Do not fabricate an acceptance
for any other host.

The following commands operate on the reviewed tool checkout; each attempt is
outside ordinary server transaction pruning:

```sh
node scripts/collect-production-release.mjs start \
  --identity /home/yuta/kaoiro-deploy/build-identity.json \
  --hosts '["homeguard"]' \
  --root /home/yuta/kaoiro-deploy/production-releases
```

Record the returned UUID/directory in the card. On every required runner host,
collect a baseline before its updater, then collect its finished leg:

```sh
node scripts/collect-production-release.mjs runner-before \
  --attempt <attempt-directory> --host homeguard --service kaoiro-runner \
  --runner-root /home/yuta/.local/share/kaoiro --output <baseline-file>
# Run the separately reviewed state-aware update and acceptance procedure.
node scripts/collect-production-release.mjs runner-after \
  --attempt <attempt-directory> --baseline <baseline-file> \
  --runner-root /home/yuta/.local/share/kaoiro \
  --config /home/yuta/.config/kaoiro/runner.config.json \
  --codex-transaction <accepted-forward-UUID> --output <runner-fact-file>
```

`runner-after` requires a new successful actual updater invocation after the
baseline, the pinned updater's ExecStart, an active runner unit, the full baked
identity and a completed modern forward acceptance. Recovery/rollback receipts
cannot substitute. The script reads only fixed units and transaction paths;
it never enumerates host processes or kills the fleet.

After server DONE and the operator canary, `complete` rechecks the live
container/image, full health identity and live registration of every required
host. Pass the real server transaction directory and a bounded canary JSON
with `passed`, `operator`, target `revision`, UTC `completed_at` and an evidence
SHA-256:

```sh
node scripts/collect-production-release.mjs complete \
  --attempt <attempt-directory> --server-transaction <server-transaction-directory> \
  --health-url <reviewed-server-health-url> \
  --runners '["<runner-fact-file>"]' --canary <canary-file>
```

The exact bounded schema is enforced by `production-release-record.mjs`.
`completion.json` is durable and write-once. Its SHA-256 is over the compact JSON
plus one newline, exactly as written. Private evidence stays outside it; retain
only fixed success facts, IDs and hashes. Simulated service/Docker dependencies
cannot complete this production command. Credentials and arbitrary logs never
enter a receipt or tag annotation.

A receipt without `tag-ack.json` is pending. Dispatch HTTP success is not an ACK.
After publication, read both immutable remote refs and their exact landing
identity before writing the acknowledgment:

```sh
node scripts/collect-production-release.mjs ack \
  --attempt <attempt-directory> --repo /home/yuta/git/kaoiro
```

Retry is read-only to the remote. Every redeploy has a fresh UUID and retained
receipt/ACK but reuses `release/v<landing-version>` and its
`identity/release/production/<full-SHA>` claim. The first tag annotation stays
unchanged; workflow summaries retain each attempt's UUID, full identity and
reuse result. Never require a later receipt digest to equal the first one.

## Automation activation and trust

All automation is disabled by default. The host-to-Actions notification adapter
(S4) has not been selected or installed. The common receiver is
`.github/workflows/production-release.yml`; it accepts a bounded completed
receipt, validates both original and rerun actors and the required host
allowlist, and executes only fixed reviewed control code. Receipt input is
data, never shell text or an executable ref.

The actual repository default is develop. Landing the workflows there makes
dispatch discoverable; a main bootstrap or promotion is unnecessary. Main
promotion remains unrelated operator work. CLAUDE.md's description of main as
the default branch differs from this observed state; this change does not edit
that policy table or change the default branch.

Changes to the privileged workflows, allocator and central tag reader require
operator approval before landing and exact-commit V6/V9 evidence. Claims and
reconciliation are detection, not protection against someone who already owns
that code. The execution card fixes the literal reviewed control SHA and the
original push run that begins allocation. Pre-activation pushes are ignored.

Before enabling either workflow, require actual V9/V10 and append-only rules
in a throwaway GitHub repository, then operator provisioning on the real repo:

- V9: atomic ref pairs, race/read-back behavior, no update/deletion bypass,
  two develop push runs and invariant original `created_at` on rerun.
- V10: the selected S4 dispatch principal and fixed receiver, allowed actors and
  hosts, and no host Contents-write privilege. Unauthorized input must refuse
  before refs. A local bare repository is not GitHub evidence.
- V6/FS: the exact candidate's distribution shape, production config/env/Node
  and successful registration; keep the high-risk section-3 start gate.

A personal-repository probe rejected GitHub Actions app ID 15368 as a creation
bypass actor (HTTP 422). Do not assume that a creation restriction with that
actor can be installed. The creation actor arrangement requires operator
adjudication; keep the independent update/deletion prohibition without bypass.
No broadening of creation actors is implied by this implementation.

Only after these conditions and review, the operator sets on
`sakuraiyuta/kaoiro`: `KAOIRO_IDENTITY_GATES_SHA` to the exact approved control
SHA, `KAOIRO_IDENTITY_V9=true`, `KAOIRO_IDENTITY_V10=true`, the matching
`KAOIRO_LANDING_CONTROL_SHA`/`KAOIRO_RELEASE_CONTROL_SHA`,
`KAOIRO_LANDING_FIRST_RUN_ID` to the reviewed first push run,
`KAOIRO_RELEASE_ACTORS` and `KAOIRO_RELEASE_HOST_IDS` to JSON allowlists, then
`KAOIRO_LANDING_ENABLED=true` and `KAOIRO_RELEASE_ENABLED=true` last. Both job
admission and control scripts compare these gates to actual checked-out HEAD.
Do not enable with placeholders or with evidence from a different commit.

## Repair

Rerun or explicit reconciliation validates the preserved first push artifact
and repairs missing post-activation tip allocations. Missing original-event
artifacts, broken public/claim pairs, gaps or partial namespace inventories
stop for operator repair; never guess a clock or silently assign a new version.
Retries after an accepted-but-unobserved push read back existing immutable
claims. New-source races retry boundedly with a fresh complete inventory.

A failed common recorder leaves publication pending and the previous completed
record untouched. Retain attempt directories and acknowledgments independently
of ordinary deploy pruning. Release workflow retries/redeploys reuse the first
tag; never force, delete, renumber or rewrite an immutable tag to recover.
