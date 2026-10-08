---
title: Transactions and identity
description: Build-identity provenance verification for a completed server/runner update -- what proves the running code matches the target commit.
status: accepted
last_updated: 2026-10-09
related: [deployment]
---

# Transactions and identity

## Provenance verification (build identity, issue #218, [ADR-0053](../../adr/0053-build-identity.md))

Build identity verifies that “the running JS / image derives from the target
commit” through a health endpoint returning the **full SHA** and runner
registration information.

| Item | Verification |
|---|---|
| Server `build_revision` equals target SHA | `build_revision` from `curl <server-url>/api/health` |
| Server `build_dirty` is intentional | `build_dirty` from `curl <server-url>/api/health` (`false` for a clean build at target SHA) |
| Server OCI label equals target SHA | `docker inspect kaoiro-server:latest --format '{{index .Config.Labels "org.opencontainers.image.revision"}}'` |
| Runner `build_revision` equals target SHA | Dashboard host list (LaunchDialog), or the `rev=<full SHA>` line in runner startup logs |
| Runner `--version` returns target identity | Release profile: `<install-root>/current/deploy/kaoiro-runner-launch.sh --version` (same path the unit starts, so missed `current` switches surface). Checkout-direct: `<repo-path>/runner/dist/cli.js --version`. Both work without config and print `kaoiro {channel} runner v{version} / <short-hash>` |

**mtime is still not evidence of success.** A `dist` directory mtime does not
change when files are only rebuilt in place. During the 2026-08-12 rollout, all
packages had been rebuilt but three directory mtimes still pointed ten days back,
nearly causing a false conclusion. Build identity removes any reason to use mtime.

**This is not cryptographic proof.** It relies on the builder honestly passing the
SHA it built as `KAOIRO_BUILD_REVISION`; a tampered value passes the “equals target
SHA” check. Signed attestation is outside this issue. A SHA mismatch is not itself
a deploy-rejection condition (ADR-0053)—docs-only commits, backports, and rolling
windows can legitimately differ; equality is only the **success check for this
runbook**.

## Delivery policy placement artifact

A prepare targeting the delivery policy store records
`policy-store-placement.json`, schema version 1, under its transaction.
The optional `policy_store_placement` path/SHA-256 reference is checkpointed
in the journal, included in `maintenance_gate_passed.observation`, and copied
to the final manifest. Readers accept legacy records without this field;
present references must have valid shape, refer to the same transaction file,
match its bytes, and name the correct target image when read from a manifest.

The artifact binds target image ID, effective Compose/environment digests,
the observed target runtime path, the complete normalized mount table, the
selected named state mount and Docker/Compose versions. Resume rechecks this
binding and the actual placement before maintenance. The journal phase by
itself is no evidence of placement for a transaction prepared by an older CLI.
See [the placement procedure](../../operations/server-update-and-rollback.md#delivery-policy-store-placement).

## See Also

- [Server update and rollback](../../operations/server-update-and-rollback.md).
- [Server deploy configuration](../configuration/server-deploy.md).
