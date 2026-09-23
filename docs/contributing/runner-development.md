---
title: Runner development
description: Building, testing, and running the runner package locally, including the wrapper hot-reload dev stack.
status: accepted
last_updated: 2026-09-19
related: [deployment]
---

# Runner development

```sh
pnpm -C runner typecheck
pnpm -C runner test
pnpm -C runner build
```

For the local stack, [`scripts/dev.sh`](../../scripts/dev.sh) launches the
server / dashboard / runner together. The runner runs under `tsx watch`, and
when the environment variable `KAOIRO_WRAPPER_DEV=1` is set, **spawned wrappers
also launch with `tsx watch`**, so edits to wrapper source are hot-reloaded into
running agents (production launches dist directly, ADR-0018).

## See Also

- [Runner install and distribution](../operations/runner-install.md).
- [Multi-host deployment architecture](../architecture/deployment.md).
