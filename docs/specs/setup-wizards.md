---
title: Setup wizards (configuration / env generation)
description: Specification for interactive question-and-answer wizards that generate the server .env and runner configuration (runner.config.json / runner.env).
status: accepted
last_updated: 2026-07-27
related: [protocol, threat-model]
---

# Setup wizards (configuration / env generation)

## Purpose

Initial setup by hand-writing tokens and connection settings is hard to read,
add, and revise. Interactive question-and-answer wizards generate valid
configuration files to reduce effort and transcription mistakes, especially
omitted fail-closed client-authentication settings.

The deployment guide ([#137](https://github.com/sakuraiyuta/kaoiro/issues/137))
is the **source of truth for manual steps**; wizards are **its automation**.
They do not restate the guide, only output generated configuration and “next
steps.”

## Two wizards

Their artifacts and locations are separate, and they operate independently.

| Wizard | Invocation | Artifact | Location |
|---|---|---|---|
| server env | `mix kaoiro.env` | `.env` | server side |
| runner configuration | `deploy/kaoiro-runner-setup.sh` | `runner.config.json` / `runner.env` | each agent host |

Their implementation forms differ because their distribution forms differ. The
server runs in an Elixir environment and can use a Mix task; the runner is
distributed as a tarball ([ADR-0018](../adr/0018-runner-distribution.md), revised
2026-07-25), whose destination has **neither Mix nor pnpm**, so it uses a Node
implementation (`runner/src/setup.ts`) plus a bundled shim.

## Common policy

- **Tokens**: For every token, choose “manual entry / automatic generation.”
  Automatic generation is **32-byte hex** (the same form as
  `openssl rand -hex 32`; implemented with Node's `crypto.randomBytes` or
  Erlang's `:crypto.strong_rand_bytes`, with no dependency on an openssl binary).
- **Existing files**: Confirm before overwriting an existing destination. Keep
  files whose overwrite is declined and report which were retained.
- **Independent operation**: Do not automate token handoff between the two
  wizards. Since the runner's `KAOIRO_RUNNER_TOKEN` and the server's
  `KAOIRO_RUNNER_TOKENS` share the same token, the wizard guides “generate in one
  → paste into the other” operation (automatic linkage is out of scope).
- **Interactive only**: Refuse to run in a non-interactive session. To avoid
  silently blocking without a TTY when called by systemd / launchd, the runner
  checks `process.stdin.isTTY` and exits 78; the server aborts with `Mix.raise`
  if stdin is closed. Flag-driven unattended deployment is handled in
  [#141](https://github.com/sakuraiyuta/kaoiro/issues/141).
- **Do not launch automatically on first run**. When configuration is absent,
  the launch shim exits 78 (`EX_CONFIG`) and only **directs the user to the
  wizard command** (avoiding the non-interactive failure above). This overrides
  [ADR-0018](../adr/0018-runner-distribution.md)'s “automatically launch the
  wizard on first run” decision.

## Server env wizard (`mix kaoiro.env`)

Generated env names and meanings follow `server/config/runtime.exs` and
`server/.env.example`. `.env` is the source of truth read by Docker Compose's
`env_file` (`server/docker-compose.yaml`). For a standalone `mix phx.server`,
load it with `set -a && . ./.env && set +a` (do not emit a separate `export`
snippet, to avoid two sources of truth).

| Item | env | Required | Notes |
|---|---|---|---|
| Secret key | `SECRET_KEY_BASE` | Required in production | 64-character base64. Same generation as `mix phx.gen.secret` (32-byte hex is too short). |
| Hostname | `PHX_HOST` | Required in production | Missing value raises on start (fail-fast, issue #134). |
| Port | `PORT` | Optional | Default: 4000. |
| Bind IP | `KAOIRO_BIND_IP` | Optional | `:prod` (release) only. Default: all interfaces. Dev always fixes loopback (issue #134). |
| Client authentication | `KAOIRO_CLIENT_TOKENS` | Effectively required | Multiple `token:role` values. role = `operator` / `viewer`. Missing value rejects all clients (fail-closed). |
| Wrapper authentication | `KAOIRO_WRAPPER_TOKENS` | Required when exposed | Multiple `agent_id:token` values (reverse order of client tokens). |
| Runner authentication | `KAOIRO_RUNNER_TOKENS` | Required when exposed | Multiple `host_id:token` values ([ADR-0023](../adr/0023-host-runner-architecture.md)). |
| OAuth identity authentication | `KAOIRO_OAUTH_*` / `KAOIRO_OAUTH_ALLOWLIST_PATH` | Optional | Google / GitHub / Nextcloud. Details: [deployment guide 1.6](deployment.md). |
| Standing-illustration directory | `KAOIRO_PERSONA_DIR` | Optional | Path within the container. |
| Footer directory | `KAOIRO_FOOTER_DIR` | Optional | Emits a comment hint without asking. |
| Persona cache directory | `KAOIRO_PERSONA_CACHE_DIR` | Optional | Emits a comment hint. |

- For each of the three token types, repeatedly ask “add one?” and “add another?”
  to build multiple entries. In production, all three are required (missing
  values reject connections, issue #133).
- **Do not ask for the nine DETS paths**. The bundled `docker-compose.yaml`
  already sets them under `environment:`; they are needed only outside Compose.
  Keep them as comments in generated files and defer their meaning and inventory
  to the deployment guide (#137).
- Do not add questions for `KAOIRO_FOOTER_DIR` or `KAOIRO_PERSONA_CACHE_DIR`.
  `mix kaoiro.env` renders their unset behavior and Compose configuration example
  as comment hints, preserving defaults while presenting necessary operational
  guidance without questions.
- Emit optional fields not collected as **comment lines, not empty assignments**
  (preventing confusion between unset and empty strings).
- After the existing questions, ask **“Configure OAuth login?”**, defaulting to
  No. On No, emit no OAuth env, allowlist, or next steps, preserving prior
  artifacts and guidance.
- On Yes, ask whether to enable Google / GitHub / Nextcloud individually. For an
  enabled provider, **manually enter** the client ID / client secret issued by
  its provider console (do not generate them). Nextcloud also requires its base
  URL. Treat all-disabled as no OAuth configuration. Never redisplay a secret
  after entry.
- When one or more providers are enabled, write `oauth-allowlist.txt` in the
  same server directory as `.env`. Include a format comment and require at
  least one `provider:identifier[:role]` (viewer when role is omitted). Show
  during entry that an empty or missing allowlist fail-closes all OAuth logins.
  Generate both `.env` and the allowlist at 0600, and confirm before overwriting
  an existing allowlist as for `.env`.
- Write `KAOIRO_OAUTH_*` only for enabled providers, and set
  `KAOIRO_OAUTH_ALLOWLIST_PATH=/etc/kaoiro/oauth-allowlist.txt`. For Compose,
  direct the user to add
  `- ./oauth-allowlist.txt:/etc/kaoiro/oauth-allowlist.txt:ro` under
  `docker-compose.yaml`'s `volumes:`. For standalone operation outside Compose,
  rewrite `KAOIRO_OAUTH_ALLOWLIST_PATH` to the allowlist's actual path. For
  provider-console registration, see deployment guide 1.6. Google cannot be
  used for plain-HTTP deployments except on localhost.

## Runner configuration wizard (`deploy/kaoiro-runner-setup.sh`)

Artifact schema and validation follow the runner-side loader
(`parseRunnerConfig()` in `runner/src/config.ts`). Before writing, the wizard
always runs the loader so it **cannot generate content the runner rejects at
startup**.

| Item | Destination | Required | Default / constraint |
|---|---|---|---|
| Host ID | `runner.config.json` `host_id` | Required | `^[A-Za-z0-9._-]+$` (used in the channel topic). |
| Server URL | Same, `server_url` | Required | `ws://` or `wss://`. Production requires `wss://` through `force_ssl`. |
| Launch-permitted cwd | Same, `cwd_allowlist` | Required | At least one absolute path; a blank line finishes input. |
| Capabilities | Same, `capabilities` | Optional | Enable/disable `claude-code` / `codex` independently. Fall back to `claude-code` if all are off. |
| Codex auth mode | Same, `codex.auth_mode` | Optional | Only if capabilities include Codex. An explicit value avoids running `codex doctor` (phase-24). |
| Runner token | `KAOIRO_RUNNER_TOKEN` in `runner.env` | Required when exposed | Manual entry / automatic generation. **Never write it to config JSON.** |
| Node path | Same, `KAOIRO_NODE` | Optional | systemd user units / launchd start with a minimal PATH, so fix it to an absolute path when using a version manager. |

- **Use OS-specific user configuration directories** (Linux
  `${XDG_CONFIG_HOME:-~/.config}/kaoiro`; macOS
  `~/Library/Application Support/kaoiro`). `KAOIRO_RUNNER_DIR` can override it.
  Match the resolution order of the launch shim
  (`deploy/kaoiro-runner-launch.sh`), or the wizard writes where the service
  does not look.
- **Generate `runner.env` at 0600** because it contains a token (issue #136).
  The launch shim `source`s it, so write its values quoted.
- `runner.config.json` is the source of truth for `server_url`. When its env
  override (`KAOIRO_RUNNER_SERVER_URL`,
  [#135](https://github.com/sakuraiyuta/kaoiro/issues/135)) arrives, add a
  comment example to `runner.env`.
- Wrapper configuration is generated by the runner at spawn
  ([ADR-0024](../adr/0024-agent-instance-identity-and-spawn-auth.md)), so it is
  outside the wizard.

## Out of scope

- **Wrapper configuration wizard** (`kaoiro.config.json`)—in production, the
  runner generates temporary configuration at spawn
  ([ADR-0023](../adr/0023-host-runner-architecture.md) /
  [ADR-0024](../adr/0024-agent-instance-identity-and-spawn-auth.md)), so people
  write it only for standalone development launches. Engine-specific examples
  (`wrapper/kaoiro.config.claude-code.example.json`, etc.) exist for that. It is
  deferred as **development-only and low priority**.
- **Non-interactive mode** (flags in bulk)—
  [#141](https://github.com/sakuraiyuta/kaoiro/issues/141)。
- **Automatic token handoff between the two wizards**—independent operation
  (manually align tokens based on
  [ADR-0011](../adr/0011-phase3-reliability-and-auth.md)'s token scheme).
- **Uploading artifacts to Gitea releases**—
  [#140](https://github.com/sakuraiyuta/kaoiro/issues/140)。

## See Also

- Related specs: [protocol](protocol.md), [threat-model](threat-model.md)
- ADRs: [0011](../adr/0011-phase3-reliability-and-auth.md)—token authentication;
  [0018](../adr/0018-runner-distribution.md)—distribution form;
  [0023](../adr/0023-host-runner-architecture.md)—runner residency;
  [0024](../adr/0024-agent-instance-identity-and-spawn-auth.md)—`agent_id` /
  token allocation at spawn
- Guide: the deployment guide (#137) is the source of truth for manual steps
