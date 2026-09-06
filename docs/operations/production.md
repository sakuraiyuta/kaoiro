# Production deployment manual

## Purpose

A step-by-step manual for an operator bringing up (or updating) a production
kaoiro deployment, without first reading
[docs/specs/deployment.md](../specs/deployment.md) end to end.
**`deployment.md` is the normative reference** — it explains *why* each step
is shaped the way it is, and covers cases this manual deliberately does not
(nginx/VPN/OAuth configuration, the full failure-handling decision tree,
verification tables, migrating a host to the release profile). This manual
only says *what to run*. When something here does not match what you observe,
`deployment.md` wins.

Each stage is: **edit** (file + key) → **run** (copy-paste command,
placeholders as `<...>`) → a one-line pointer to `deployment.md` for when
something goes wrong.

## 0. Prerequisites

Confirm all of these before starting.

- **SSH access** to the server host and every runner host, with each host's
  key already in `known_hosts`.
- **Docker Engine + Docker Compose plugin** installed on the server host;
  **GNU tar** on the server host (the deploy CLI's own archive-listing parser
  assumes GNU `tar tv*` output — bsdtar/busybox hosts fail loudly, but only
  after an archive has already been written).
- **Elixir `~> 1.15` with Phoenix** on the server host, with dependencies
  fetched once (`cd server && mix deps.get`) before running the `.env`
  wizard in step 1.
- **Node.js ≥ 22** on the server host (`server/deploy/kaoiro-server-deploy.mjs`
  requires it) and on every runner host (the tarball is self-contained — a
  runner host needs nothing but a Node runtime). Whichever host BUILDS the
  runner tarball needs the full toolchain instead (Node + pnpm; workspace
  resolution happens at build time, not on the deploy target).
- **A decision on how the server is reached**: the default is `127.0.0.1`
  behind nginx (deployment.md 1.4); a direct VPN address is the alternative
  (1.5, ships its own boot-order fix — see Troubleshooting below). Pick one
  before writing `.env`.

**The deploy CLI's own config file** (optional, but required for anything
other than its built-in defaults): a `0600` JSON file, owned by the user that
runs the CLI, passed as `--config <path>` to every subcommand. The table
below is the operator-facing subset — every key in it defaults to the value
shown, so a config file only needs to state what it overrides. (One more
key, `allow_docker_override`, exists only so the test suite can fake the
docker binary; it has no legitimate production use and is deliberately
omitted here.)

| Key | Default |
|---|---|
| `backup_root` | `~/kaoiro-deploy` (absolute path required if overridden); also selects the filesystem the capacity preflight measures |
| `keep_generations` / `retention_days` | `5` / `30` |
| `capacity_multiplier` | `10` (refuse an update when free space on `backup_root`'s filesystem < 10× the volume size) |
| `health_poll_interval_ms` / `health_poll_timeout_ms` | `2000` / `60000` |
| `stability_window_ms` | `30000` |
| `health_url` | `null` (derived from `docker compose port`; override only if wrong for this host) |
| `expected_clean_stop_exit_code` / `expected_clean_stop_oom_killed` | `null` / `null` — see below |

`expected_clean_stop_exit_code`/`expected_clean_stop_oom_killed` have no
usable default: until you measure what a normal `docker compose stop`
produces on THIS host (deployment.md 4.3 step 5), every stop is treated as
abnormal, which is the safe direction to fail in but means `update` will
refuse to proceed past the stop window on its own. Measure it once (stop the
server manually, `docker inspect <container> --format 'exit={{.State.ExitCode}}
oom={{.State.OOMKilled}}'`) and put both values in the config file before
relying on unattended updates.

## 1. Server install (first time)

**Edit**: nothing yet — clone the repo at the exact commit you intend to run.

```sh
git clone <repo-url> <repo-path>
cd <repo-path>
git checkout <target-sha>
```

**Edit**: `server/.env` — generate it interactively rather than hand-editing
`.env.example` (the wizard also issues every required token):

```sh
cd server
mix kaoiro.env
cd ..
```

Answer its prompts: `SECRET_KEY_BASE` (let it generate one), `PHX_HOST`
(public hostname), the client/runner tokens (let it generate them — record
what it prints, you will need the runner token for step 2). Optional:
nginx (deployment.md 1.4), a direct VPN address instead (1.5), OAuth login
(1.6) — none of these are covered further here; follow the linked sections.

**Run**: bootstrap the server. `start --initialize` builds the image
(`docker compose up -d --build`, with build identity passed directly — no
manual `set -a && eval "$(node scripts/build-identity.mjs)"`) and starts it
in one command, refusing outright if any prior state is detected (never
overwrites an existing deployment):

```sh
node server/deploy/kaoiro-server-deploy.mjs start --initialize
```

Stuck? → [deployment.md 1](../specs/deployment.md#1-deploy-the-server) for
token/`.env`/nginx/VPN/OAuth detail this manual skips.

## 2. Runner install (first time, per host)

**Edit**: nothing yet — build (or obtain) a tarball for the target OS/arch.

```sh
./scripts/build-runner-tarball.sh --target linux-x64   # or darwin-arm64
```

Transfer the resulting `dist-tarball/kaoiro-runner-<rev>-<os>-<arch>.tar.gz`
to the runner host, then:

```sh
tar xzf kaoiro-runner-<rev>-<os>-<arch>.tar.gz
cd kaoiro-runner-<rev>-<os>-<arch>
```

**Edit**: `runner.config.json` (`host_id`, `server_url`, `cwd_allowlist`) and
`runner.env` (`KAOIRO_RUNNER_TOKEN`, paired with the `<host_id>:<token>` the
server wizard issued in step 1) — generate both interactively:

```sh
./deploy/kaoiro-runner-setup.sh
```

`server_url` must be `wss://...` through nginx (a bare `ws://` gets redirected
and the handshake fails) — the direct-VPN deployment (1.5) is the one
exception, using `ws://<PHX_HOST>:<PORT>/runner`.

**Run**: install as a managed release, activate it, and enable it as a
service:

```sh
./deploy/kaoiro-runner-install.sh ../kaoiro-runner-<rev>-<os>-<arch>.tar.gz
./deploy/kaoiro-runner-switch.sh <release-id>
```

Then enable the service — Linux (systemd user unit):

```sh
install_root="${XDG_DATA_HOME:-$HOME/.local/share}/kaoiro"
sed "s|@@DEPLOY_DIR@@|$install_root/current/deploy|" \
  "$install_root/current/deploy/kaoiro-runner.service" \
  > ~/.config/systemd/user/kaoiro-runner.service
systemctl --user daemon-reload
systemctl --user enable --now kaoiro-runner
sudo loginctl enable-linger "$USER"
```

macOS (launchd) uses `com.kaoiro.runner.plist` the same way — see
[runner/README.md](../../runner/README.md#macoslaunchd-launchagent) (macOS
orchestration is not yet verified in production, issue #242).

Stuck? → [runner/README.md](../../runner/README.md) "常駐化" for the full
systemd/launchd reference, exit codes, and log locations; deployment.md
[2](../specs/deployment.md#2-deploy-runners-multiple-hosts) for the
multi-host specifics.

## 3. Verify

```sh
node server/deploy/kaoiro-server-deploy.mjs status
```

Confirm `container.running` is `true` and `health` reports the target's
`build_revision`/`build_dirty`. Then, mandatorily (`status` does not replace
this — deployment.md 4.5):

1. Open the dashboard at `https://<host>/?token=<a client token>`.
2. Confirm the runner's own log shows a sustained connection (no repeated
   `unauthorized` disconnects).
3. Confirm the runner's `host_id` appears in the dashboard's host list.

## 4. Update

**Server-side, this is a `--dry-run` preview plus two real invocations —
prepare, then commit — not one call.** `update` deliberately splits the real
work into a no-downtime *prepare* and an explicitly-approved *commit*,
because human-judgment points in this deploy (an abnormal stop, a lost
ledger, an ambiguous recovery) get no `--skip`/`--force` flag by design;
requiring an explicit second invocation is that same policy applied to the
routine case, not an oversight.

**Run `--dry-run` first, every time** (not only the first time this CLI ever
touches this host) — it performs only reads and prints the plan:

```sh
node server/deploy/kaoiro-server-deploy.mjs update --target <target-sha> --dry-run
```

If the plan looks right, prepare for real. This builds the target image and
runs the issue #220 persistence-path check; nothing is stopped yet:

```sh
node server/deploy/kaoiro-server-deploy.mjs update --target <target-sha>
```

It exits non-zero, naming a `<transaction-id>` and asking for approval. Once
you (or whoever signs off maintenance windows) approve the stop window,
commit — this stops the server, archives, restarts, and health-polls in one
call:

```sh
node server/deploy/kaoiro-server-deploy.mjs update --target <target-sha> \
  --transaction <transaction-id> --maintenance-approved
```

Then update the runner (one command; builds, installs, switches, and
restarts):

```sh
kaoiro-runner-update.sh --from-repo <repo-path> --target <os-arch>
```

or, from a pre-built tarball: `kaoiro-runner-update.sh --tarball <path>`.

Stuck? → [deployment.md 4.4](../specs/deployment.md#44-failure-handling).

## 5. Rollback

Only possible for a transaction the CLI itself created — a host whose
current deployment has never gone through `update` has nothing to roll back
to yet (see "First run" below).

```sh
node server/deploy/kaoiro-server-deploy.mjs rollback \
  --transaction <transaction-id> --dry-run
```

Preview first (shows whether the restore is destructive), then:

```sh
node server/deploy/kaoiro-server-deploy.mjs rollback \
  --transaction <transaction-id> --confirm-restore
```

Runner side (reverts `current` to whatever was activated before it, no
transaction id needed):

```sh
kaoiro-runner-switch.sh --rollback
```

Stuck? → [deployment.md 4.4 (3)](../specs/deployment.md#44-failure-handling).

## First run on an existing (pre-CLI) deployment

A host running from before this CLI existed has a live container but no
transaction history at all — that is a normal, safe state, not an error.
Confirm it reads that way before trusting the CLI with a real update:

```sh
node server/deploy/kaoiro-server-deploy.mjs status
```

Expect `container.running: true` and `doneTransactions: []`. Also confirm
`health.build_revision` matches `git rev-parse HEAD` in this checkout — the
CLI derives `old_sha` from the repo HEAD, not from what the running
container was actually built from, so a checkout that has since moved would
silently record the wrong `old_sha`. If they disagree, `git checkout` the
commit `health.build_revision` names before running anything else. Then
preview an update as in step 4 (`--dry-run`) before running one for real.
There is nothing else to migrate — the CLI works from whatever is currently
running, the same way a first-ever `update` on a brand-new host would.

## 6. Troubleshooting

**Container does not start after a reboot** (docker started before the VPN
address existed): confirm the boot-order drop-in is installed
(`systemctl show docker -p After` should list the VPN unit) — see
[deployment.md 1.5](../specs/deployment.md#15-direct-vpn-deployment-no-nginx-plain-http-2026-07-26)
"Boot order for a VPN publish address" and
[5. Troubleshooting](../specs/deployment.md#5-troubleshooting) for the full
recovery sequence. Only applies to a direct-VPN publish address; the default
`127.0.0.1`-behind-nginx setup is unaffected.

**Runner does not start, exit code 78 (`EX_CONFIG`)**: a configuration
error — restarting will not fix it. Check
`systemctl --user status kaoiro-runner` / `journalctl --user -u kaoiro-runner`;
common causes are a missing `dist` (release not built/installed) or the
setup wizard never having run. See
[runner/README.md](../../runner/README.md) "再起動ポリシーと終了コード".

**Port bind failure** (`cannot assign requested address`): the publish
address is not yet present on any interface when docker starts — the same
class as the reboot issue above; the fix is the same boot-order drop-in.

## See Also

- [deployment.md](../specs/deployment.md) — the normative reference this
  manual summarizes
- [setup-wizards.md](../specs/setup-wizards.md) — what `mix kaoiro.env` and
  `kaoiro-runner-setup.sh` ask and why
- [runner/README.md](../../runner/README.md) — full runner install /
  service / troubleshooting reference
- Issue #303 (this manual's own tracking issue), #306 (the server deploy CLI)
