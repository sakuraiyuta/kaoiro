---
title: Transactions and identity
description: Build-identity provenance verification for a completed server/runner update -- what proves the running code matches the target commit.
status: accepted
last_updated: 2026-09-19
related: [deployment]
---

# Transactions and identity

#### Provenance verification (build identity, issue #218, [ADR-0053](../../adr/0053-build-identity.md))

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

## See Also

- [Server update and rollback](../../operations/server-update-and-rollback.md).
- [Server deploy configuration](../configuration/server-deploy.md).
