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

ローカルスタックは [`scripts/dev.sh`](../../scripts/dev.sh) が server / dashboard /
runner を一括起動する。runner は `tsx watch` で動き、環境変数
`KAOIRO_WRAPPER_DEV=1` のとき **spawn する wrapper も `tsx watch` で起動**するため、
wrapper のソース編集が稼働中エージェントへホットリロードされる(本番は dist を
直接起動、ADR-0018)。

## See Also

- [Runner install and distribution](../operations/runner-install.md).
- [Multi-host deployment architecture](../architecture/deployment.md).
