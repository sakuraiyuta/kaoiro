---
title: Runner artifacts
description: The release-profile install-root layout and the activation contract governing what may become `current`.
status: accepted
last_updated: 2026-09-19
related: [deployment]
---

# Runner artifacts

#### Layout

```text
<install-root>/
  releases/<revision>[-dirty]/   # tarball expansion; immutable thereafter
  current  -> releases/<revision>   # unit ExecStart goes through this
  previous -> releases/<revision>   # rollback target
```

The default `<install-root>` is Linux `${XDG_DATA_HOME:-~/.local/share}/kaoiro`
and macOS `~/Library/Application Support/kaoiro`. Override with
`KAOIRO_RUNNER_INSTALL_DIR` or each script's `--install-dir`.

**Estimate disk space.** An expanded release is **about 1 GB each** (measured
993 MB linux-x64 on 2026-09-18); the engine CLI itself is about 920 MB. The
default retention is three generations (`--keep`), using about 3 GB in
steady state.

`.lock.*` (exclusive locks) and `.staging.*` (expansion/build work areas) are
created directly under the install root. Staging from a run that missed its EXIT
trap (for example SIGKILL) is **garbage-collected immediately after the next run
acquires the lock**, so it does not accumulate.

**GC is prefix-scoped; each script targets only what it created**—install only
`.staging.install.*`, update only `.staging.build.*`. Deletion is justified only
when no other run of that script is active, within the scope guaranteed by its
lock. Install and update have separate locks, and update calls install; a glob
spanning both once let a **nested install delete an update's in-use build
directory** (`--from-repo` failed entirely; issue #219 review round 2). Lock
directories use the `.lock.*` prefix and match neither glob.

#### Activation contract (what may become `current`)

| Target | Contract |
|---|---|
| ID eligible for `current` | **Only a clean 40-digit hex**. `-dirty` / `unknown` require explicit `--allow-dirty` on a dev host |
| Reinstall a clean release | **Cannot replace** (content-addressed; reinstall is a no-op and has no override flag) |
| Reinstall dirty / unknown | Rejected by default; `--allow-dirty` permits replacement, but not while pointed to by `current` / `previous` |
| Rollback | No gate; `previous` was activated once already |

**Before a production update, confirm `git status --porcelain` is empty.** A build
from a dirty tree produces a `-dirty` ID and is rejected **before stopping the
runner** (the release-identity contract in [ADR-0018](../../adr/0018-runner-distribution.md)).
`--allow-dirty` is for development hosts; in production it makes `current` a name
whose contents are not fixed.

## See Also

- [Runner update and rollback](../../operations/runner-update-and-rollback.md).
- [Multi-host deployment architecture](../../architecture/deployment.md).
