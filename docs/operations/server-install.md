---
title: Server install runbook
description: Issue authentication tokens, create the server .env, and start with docker compose.
status: accepted
last_updated: 2026-09-27
related: [deployment]
---

# Server install runbook

The normative reference for why each step is shaped this way is
[Multi-host deployment architecture](../architecture/deployment.md); the
env variable reference is
[Server configuration](../reference/configuration/server.md).

## Prerequisites

Confirm all of these before starting.

- **SSH access** to the server host and every runner host, with each host's
  key already in `known_hosts`.
- **Docker Engine and the Docker Compose plugin** on the server host.
- **Elixir `~> 1.15` with Phoenix** on the server host, with dependencies
  fetched once (`cd server && mix deps.get`) before the `.env` wizard in 1.2.
- **Node.js 22 or later** on the server host (the deploy CLI
  `server/deploy/kaoiro-server-deploy.mjs` requires it) and on every runner
  host ([Runner install and distribution](runner-install.md#installation-on-the-target-host)).
  The host that builds the runner tarball needs the full toolchain instead
  ([Creating distribution tarballs](runner-install.md#creating-distribution-tarballs)).
- **GNU tar** on the deploy host (the deploy CLI's archive-listing parser
  assumes it; see [Server update and rollback](server-update-and-rollback.md#42-preconditions)).
- **A decision on how the server is reached**, made before writing `.env`: the
  default is `127.0.0.1` behind nginx
  ([1.4](network-and-login.md#14-nginx-reverse-proxy)); a direct VPN address is
  the alternative (1.5 in the same runbook).

## 1. Deploy the server

### 1.1 Issue authentication tokens (three required)

For public operation on an arbitrary host, configure all three
([auth-and-authz](../architecture/security-boundaries.md)). Generate them with
`openssl rand -hex 32` (32-byte hex).

```sh
openssl rand -hex 32   # Used for the token part of KAOIRO_CLIENT_TOKENS
openssl rand -hex 32   # Used for the token part of KAOIRO_WRAPPER_TOKENS
openssl rand -hex 32   # Used for the token part of KAOIRO_RUNNER_TOKENS
```

### 1.2 Create `.env`

```sh
cd server && cp .env.example .env
```

See [Server configuration](../reference/configuration/server.md) for the full
env variable list, DETS persistence paths, and footer/persona-cache mount
examples.

Alternatively, run `mix kaoiro.env` to generate `.env` interactively; see
[Setup wizards](../reference/configuration/setup-wizards.md) for what it asks
and writes. Let it generate `SECRET_KEY_BASE` and the client and runner tokens,
and answer `PHX_HOST` with the public hostname. Record the runner token it
prints: the runner host's setup needs the matching `<host_id>:<token>` entry
([Runner install and distribution](runner-install.md#installation-on-the-target-host)).

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

On a host with no prior deployment, the deploy CLI does the build and start in
one command. `start --initialize` runs `docker compose up -d --build` with the
build identity passed directly (no manual
`set -a && eval "$(node scripts/build-identity.mjs)"`), and refuses outright if
it detects any prior state, so it never overwrites an existing deployment (the
state classes are in [Server deploy configuration](../reference/configuration/server-deploy.md#transaction-states-and-status)).
Clone the repository at the exact commit you intend to run first:

```sh
git clone <repo-url> <repo-path>
cd <repo-path>
git checkout <target-sha>
node server/deploy/kaoiro-server-deploy.mjs start --initialize
```

## See Also

- [Multi-host deployment architecture](../architecture/deployment.md).
- [Server configuration](../reference/configuration/server.md).
- [Network and login runbook](network-and-login.md).
- [Production deployment manual](production.md).
