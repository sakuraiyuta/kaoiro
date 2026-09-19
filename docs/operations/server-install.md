---
title: Server install runbook
description: Issue authentication tokens, create the server .env, and start with docker compose.
status: accepted
last_updated: 2026-09-19
related: [deployment]
---

# Server install runbook

The normative reference for why each step is shaped this way is
[Multi-host deployment architecture](../architecture/deployment.md); the
env variable reference is
[Server configuration](../reference/configuration/server.md).

## 1. Deploy the server

### 1.1 Issue authentication tokens (three required)

For public operation on an arbitrary host, configure all three
([auth-and-authz](../architecture/security-boundaries.md)). Generate them with
`openssl rand -hex 32` (32-byte hex).

```sh
openssl rand -hex 32   # KAOIRO_CLIENT_TOKENS の token 部分に使う
openssl rand -hex 32   # KAOIRO_WRAPPER_TOKENS の token 部分に使う
openssl rand -hex 32   # KAOIRO_RUNNER_TOKENS の token 部分に使う
```

### 1.2 Create `.env`

```sh
cd server && cp .env.example .env
```

See [Server configuration](../reference/configuration/server.md) for the full
env variable list, DETS persistence paths, and footer/persona-cache mount
examples.

`scripts/dogfood.sh` uses `server/docker-compose.dogfood.yaml` only for its
local launcher-owned runner pair. Production deployments must use
`docker-compose.yaml` alone; dogfood's override leaves `server/.env` unchanged.

### 1.3 Start with docker compose

**The build context is the repository root** because `dashboard/` is outside
`server/` (issue #44). `docker-compose.yaml` already sets `context: ..`, so start
normally from `server/`. For a manual `docker build`, run
`docker build -f server/Dockerfile .` from the root.

```sh
cd server
docker compose up -d --build
```

By default it binds only to `127.0.0.1:4000` (the compose `ports` mapping). nginx
reaches it through the same host's loopback.

## See Also

- [Multi-host deployment architecture](../architecture/deployment.md).
- [Server configuration](../reference/configuration/server.md).
- [Network and login runbook](network-and-login.md).
- [Production deployment manual](production.md).
