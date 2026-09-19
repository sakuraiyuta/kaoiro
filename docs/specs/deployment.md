---
title: Multi-host deployment guide
description: Canonical manual procedure for operating a server (separate host, docker compose + nginx) and runners on multiple hosts. Covers nginx locations, env variables, DETS paths, auth token issuance, wss constraints, and updating existing deployments (interim until automation).
status: accepted
related: [security-boundaries, setup-wizards, security-threat-model]
---

# Multi-host deployment guide

## Purpose

Moved to [Multi-host deployment architecture](../architecture/deployment.md#purpose).

## Overall architecture

Moved to [Multi-host deployment architecture](../architecture/deployment.md#overall-architecture).

## 1. Deploy the server

Moved: 1.1-1.3 to [Server install runbook](../operations/server-install.md), the env variable table to [Server configuration](../reference/configuration/server.md), and 1.4-1.6 to [Network and login runbook](../operations/network-and-login.md).

### 1.1 Issue authentication tokens (three required)

Moved to [Server install runbook](../operations/server-install.md#11-issue-authentication-tokens-three-required).

### 1.2 Create `.env`

Moved to [Server install runbook](../operations/server-install.md#12-create-env) (steps) and [Server configuration](../reference/configuration/server.md) (env variable table and DETS paths).

### 1.3 Start with docker compose

Moved to [Server install runbook](../operations/server-install.md#13-start-with-docker-compose).

### 1.4 nginx reverse proxy

Moved to [Network and login runbook](../operations/network-and-login.md#14-nginx-reverse-proxy).

### 1.5 Direct VPN deployment (no nginx, plain HTTP, 2026-07-26)

Moved to [Network and login runbook](../operations/network-and-login.md#15-direct-vpn-deployment-no-nginx-plain-http-2026-07-26).

#### Boot order for a VPN publish address

Moved to [Network and login runbook](../operations/network-and-login.md#boot-order-for-a-vpn-publish-address).

### 1.6 Configure OAuth login (optional, ADR-0042 / issue #65)

Moved to [Network and login runbook](../operations/network-and-login.md#16-configure-oauth-login-optional-adr-0042--issue-65).

## 2. Deploy runners (multiple hosts)

Distribution currently uses tarballs (issue #70, revised 2026-07-25 in
[ADR-0018](../adr/0018-runner-distribution.md)); expand one on each agent host.
The full procedure and service setup (systemd user unit / launchd LaunchAgent)
are canonical in [runner/README.md](../../runner/README.md); this section covers
only points specific to multi-host deployment.

```sh
# ビルドホスト(1 台)で対象アーキテクチャごとに生成
./scripts/build-runner-tarball.sh --target linux-x64
./scripts/build-runner-tarball.sh --target darwin-arm64

# 各エージェントホストへ転送し、release として install する
# (展開先は <install-root>/releases/<rev>/、ADR-0018 2026-08-16 改訂)
./kaoiro-runner-install.sh kaoiro-runner-<rev>-linux-x64.tar.gz
./kaoiro-runner-switch.sh <release-id>
```

The install / switch scripts are in the package's `deploy/`. For the first
installation, expand the archive once and run from there
(`tar xzf ... && cd ... && ./deploy/kaoiro-runner-install.sh ../<archive>`).
Afterward use `<install-root>/current/deploy/`. Section 4.6 is canonical for
layout, updates, and rollback.

### `runner.config.json` example (`wss://` required)

For prod deployments through nginx, `server_url` must be `wss://` (`ws://`
direct connections receive 301 under the 1.4 constraint). Only the direct VPN
deployment (1.5) uses `ws://<PHX_HOST>:<PORT>/runner`. Make `host_id` unique per
host: the server's `HostRegistry` registers by host ID, so duplicates overwrite
one host with the other.

```json
{
  "host_id": "lab-pc-1",
  "server_url": "wss://kaoiro.example.com/runner",
  "cwd_allowlist": ["/home/agent/repos"],
  "capabilities": ["claude-code", "codex", "antigravity"]
}
```

Set `KAOIRO_RUNNER_TOKEN=<token issued in 1.1>` in `runner.env` (pair it with
`<host_id>:<token>` in server-side `KAOIRO_RUNNER_TOKENS`) and run `chmod 600`.
Override `server_url` with `KAOIRO_RUNNER_SERVER_URL` in `runner.env` as well
(issue #135; env takes precedence over the config file).

For local launchers, `runner/runner.env` is a separate gitignored file that
contains only `KAOIRO_RUNNER_TOKEN=<64 lowercase hex>`. `scripts/dev.sh` and
`scripts/dogfood.sh` create it with mode 0600 when absent and append its pair
to the server list for the configured host; a preset environment token wins
after validation.

### Run as a service

Templates for systemd user units (Linux) and launchd LaunchAgents (macOS) ship
in `runner/deploy/`. See the “Run as a service” section of
[runner/README.md](../../runner/README.md) for installation, exit codes, and
troubleshooting. In the release profile set `@@DEPLOY_DIR@@` to
`<install-root>/current/deploy`; starting the unit through the symlink is what
makes switching atomic. **Restarting a runner (including service restart) stops
all wrappers beneath it** (`supervisor.stopAll()` on SIGTERM), so
`systemctl --user restart` / `launchctl kickstart -k` with active agents
disconnects every agent on that host.

## 3. Connectivity checks

Moved to [Server update and rollback](../operations/server-update-and-rollback.md#3-connectivity-checks).

## 4. Update an existing deployment

Sections 1–2 cover **initial deployment**. This section is canonical for moving
an already-running deployment to a new version.

> **The server side is a CLI** (`server/deploy/kaoiro-server-deploy.mjs`,
> issue #306), driven by a transaction manifest + journal — 4.3/4.4 below
> document it. **The runner side remains a separate, still-manual (or
> checkout-direct) procedure** interleaved with the CLI calls; 4.6 covers the
> release-profile automation for it. Automation does not remove the 4.1
> limits by itself — they remain until their own resolving condition is met.

### 4.1 Known limits

The In-place build limit row moved to
[Multi-host deployment architecture](../architecture/deployment.md#build-and-restart-boundaries);
the remaining status paragraphs below stay here (to be moved in U20).

Moved to [Server update and rollback](../operations/server-update-and-rollback.md#update-related-resolved-limits).

### 4.2 Preconditions

Moved to [Server update and rollback](../operations/server-update-and-rollback.md#42-preconditions).

### 4.3 Update procedure

Moved to [Server update and rollback](../operations/server-update-and-rollback.md#43-update-procedure) (CLI overview, config keys -- see [Server deploy configuration](../reference/configuration/server-deploy.md) -- dry-run semantics, prepare/commit split, and the update-flow diagram).

Server steps (1)(2)(5)(5-a)(5-b)(5-c)(6) moved to U20's page above. Runner steps (3)/(4)/(7) below moved to U21's page.

Moved to [Server update and rollback](../operations/server-update-and-rollback.md#43-update-procedure) ((1) Save the old image, (2) Prepare the server image, including the issue #220 persistence-path/env-consistency check).

Moved to [Runner update and rollback](../operations/runner-update-and-rollback.md#46-migrate-to-the-release-profile-and-update-thereafter-issue-219).

Moved to [Runner update and rollback](../operations/runner-update-and-rollback.md#46-migrate-to-the-release-profile-and-update-thereafter-issue-219).

Moved to [Server update and rollback](../operations/server-update-and-rollback.md#43-update-procedure) ((5) Stop the server and determine whether it stopped cleanly, (5-a) Resolve the volume, (5-b) Migrate the user ledger, (5-c) Archive and verify DETS, (6) Start the server with the prepared image).

Moved to [Runner update and rollback](../operations/runner-update-and-rollback.md#46-migrate-to-the-release-profile-and-update-thereafter-issue-219).

Moved to [Server update and rollback](../operations/server-update-and-rollback.md#43-update-procedure) (status command output, transaction phases, and container-branch classification are now in [Server deploy configuration](../reference/configuration/server-deploy.md#transaction-states-and-status)).

### 4.4 Failure handling

Moved to [Server update and rollback](../operations/server-update-and-rollback.md#44-failure-handling) ((0) A prepare-phase abort left latest pointing at the wrong image, (0a) another run holds <lock-path>, (1) The commit step failed before reaching done).

Moved to [Runner update and rollback](../operations/runner-update-and-rollback.md#46-migrate-to-the-release-profile-and-update-thereafter-issue-219).

Moved to [Server update and rollback](../operations/server-update-and-rollback.md#44-failure-handling) ((3) Roll back a committed transaction, (4) Runner does not restart, (5) Operational checks are incomplete).

### 4.5 Verification and its limits

Moved to [Server update and rollback](../operations/server-update-and-rollback.md#operational-success-the-success-criteria)
(the "Verification has two layers" intro is folded in there too).

#### Operational success (the success criteria)

Moved to [Server update and rollback](../operations/server-update-and-rollback.md#operational-success-the-success-criteria).

#### Provenance verification (build identity, issue #218, [ADR-0053](../adr/0053-build-identity.md))

Moved to [Transactions and identity](../reference/deployment/transactions-and-identity.md#provenance-verification-build-identity-issue-218-adr-0053).

### 4.6 Migrate to the release profile and update thereafter (issue #219)


Moved to [Runner update and rollback](../operations/runner-update-and-rollback.md#46-migrate-to-the-release-profile-and-update-thereafter-issue-219).

#### Layout


Moved to [Runner artifacts](../reference/deployment/runner-artifacts.md#layout).

#### Activation contract (what may become `current`)


Moved to [Runner artifacts](../reference/deployment/runner-artifacts.md#activation-contract-what-may-become-current).

#### 4.6.1 Migrate from checkout-direct (operator action, once per host)


Moved to [Runner update and rollback](../operations/runner-update-and-rollback.md#461-migrate-from-checkout-direct-operator-action-once-per-host).

#### 4.6.2 Subsequent updates


Moved to [Runner update and rollback](../operations/runner-update-and-rollback.md#462-subsequent-updates).

#### 4.6.3 Rollback


Moved to [Runner update and rollback](../operations/runner-update-and-rollback.md#463-rollback).

#### 4.6.4 What tests do not guarantee (verify once on real hardware)


Moved to [Runner service verification](../operations/runner-service-verification.md#464-what-tests-do-not-guarantee-verify-once-on-real-hardware) (the reusable self-test procedure) and [Runner service isolation](../evidence/deployment/runner-service-isolation.md) (the dated measurement it produced).

## 5. Troubleshooting

Moved to [Deployment troubleshooting](../operations/deployment-troubleshooting.md).

### Container does not start after a reboot

Moved to [Deployment troubleshooting](../operations/deployment-troubleshooting.md#container-does-not-start-after-a-reboot).

## See Also

- [auth-and-authz](../architecture/security-boundaries.md) — details of unset behavior for the three tokens
- [setup-wizards](setup-wizards.md) — interactive wizard automating env / config
  generation for **initial deployment**; section 4 updates are out of scope
  (automation in #218 / #219 / #220)
- [runner/README.md](../../runner/README.md) — full service and tarball-distribution guide
- [server/README.md](../../server/README.md) — local development and Docker basics
- [threat-model](../architecture/security-threat-model.md) — risk assessment for dev fallback / unset tokens
- [docs/operations/production.md](../operations/production.md) — Codex
  `codex.backend` selection and its rollback procedure, not covered here
