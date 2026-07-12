#!/usr/bin/env bash
# Dogfood stack for kaoiro — release-style, NO hot reload.
#
# Use this INSTEAD of scripts/dev.sh when you want kaoiro agents to work
# on kaoiro itself (or otherwise want to verify against the release
# image). Nothing here restarts on source edits:
#
#   server+dashboard : docker compose (server/docker-compose.yaml, :4000)
#                      Phoenix serves the bundled dashboard from
#                      priv/static; no Vite HMR.
#   runner           : host, `node dist/cli.js` (no tsx watch).
#                      ADR-0023 keeps runner as a host-resident
#                      supervisor — it stays out of docker because it
#                      spawns wrappers with host paths / tokens / cwd
#                      allowlist.
#   wrapper          : spawned by runner from dist (same as dev.sh
#                      default — KAOIRO_WRAPPER_DEV is NEVER honoured
#                      here).
#
# Agents are launched from the dashboard (「+ 起動」), NOT from
# agent.*.json — the runner supervises them (ADR-0023/0024, issue #22).
#
# To pick up code changes: Ctrl-C, then re-run this script. Rebuilds
# wrapper/runner dist and the docker image (compose --build only rebuilds
# on change, so re-runs are cheap when nothing changed). For hot reload,
# use scripts/dev.sh instead.
set -euo pipefail
# Job-control: the runner background job becomes its own process-group
# leader, so a single `kill -TERM -<pgid>` reliably reaps grandchildren
# (node, wrapper Node processes) too. setsid is unavailable on macOS,
# so this is the portable teardown path.
set -m

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

for cmd in docker pnpm node; do
  command -v "$cmd" >/dev/null 2>&1 ||
    { echo "dogfood: error — '$cmd' not found in PATH" >&2; exit 1; }
done

# Prefer docker compose v2 plugin; fall back to standalone docker-compose.
if docker compose version >/dev/null 2>&1; then
  dc=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  dc=(docker-compose)
else
  echo "dogfood: error — 'docker compose' plugin or 'docker-compose'" \
    "binary required" >&2
  exit 1
fi

# docker compose reads server/.env via env_file:. Fail-closed if absent
# so the operator does not hit "dashboard rejected" mid-boot with a
# half-brought-up stack (SECRET_KEY_BASE + KAOIRO_CLIENT_TOKENS are both
# required by the prod release; see server/.env.example).
if [[ ! -f "$root/server/.env" ]]; then
  echo "dogfood: error — server/.env is missing" >&2
  echo "  cp server/.env.example server/.env, then set SECRET_KEY_BASE" \
    "(mix phx.gen.secret) and KAOIRO_CLIENT_TOKENS" >&2
  exit 1
fi

# Header invariant: KAOIRO_WRAPPER_DEV is NEVER honoured here. dev.sh
# instructs operators to `export KAOIRO_WRAPPER_DEV=1` in their shell to
# opt into wrapper hot reload — that export persists after dev.sh exits,
# so a same-terminal switch to dogfood.sh would otherwise inherit it and
# the runner would spawn wrappers via `tsx watch` instead of dist,
# reintroducing the exact self-restart disruption this script exists to
# prevent. Strip it before anything downstream can read it.
unset KAOIRO_WRAPPER_DEV

logdir="$root/tmp/dogfood-logs"
mkdir -p "$logdir"
rotate_log() {
  local name="$1"
  local f="$logdir/$name.log"
  [[ -f "$f" ]] && mv -f "$f" "$f.prev"
  : >"$f"
  printf 'dogfood-log %s started at %s\n' "$name" \
    "$(date '+%Y-%m-%d %H:%M:%S')" >>"$f"
}
for name in stack runner; do rotate_log "$name"; done

pids=()
runner_pid=""
cleanup() {
  trap - INT TERM EXIT
  echo
  echo "dogfood: stopping..."
  # Kill host-side jobs first so agents (wrappers) get a clean runner
  # disconnect, THEN take the server down.
  if [[ ${#pids[@]} -gt 0 ]]; then
    for pid in "${pids[@]}"; do
      # Negative target = whole process group (job-control leader).
      kill -TERM -"$pid" 2>/dev/null || true
    done
  fi
  # Block on the runner specifically until its graceful websocket
  # disconnect completes — the SIGTERM broadcast above is asynchronous,
  # and `docker compose down` would otherwise race the runner's cleanup.
  # A bare `wait` would deadlock: `docker compose logs -f` only exits
  # after the containers stop.
  if [[ -n "$runner_pid" ]]; then
    wait "$runner_pid" 2>/dev/null || true
  fi
  ( cd "$root/server" && "${dc[@]}" down ) 2>&1 |
    tee -a "$logdir/stack.log" || true
  wait 2>/dev/null || true
}
trap cleanup INT TERM EXIT

# 1) Workspace install + wrapper dist build. Runner spawns wrappers from
# ./dist/*, so these four packages must be compiled before the runner
# starts (same rationale as scripts/dev.sh; ADR-0017 / ADR-0032 F1 —
# package `main` points at `./dist/index.js`). `pnpm install` runs FIRST
# because each package's build is `tsc -p tsconfig.build.json` — on a
# fresh clone the filtered build would otherwise fail with `tsc: not
# found` before node_modules is ever populated. `wrapper/` 直下は非メンバ
# の meta shim なので root から `-r --filter` で 4 パッケージだけ topo
# build させる。
echo "dogfood: installing workspace deps + building wrapper packages..."
( cd "$root" && pnpm install </dev/null &&
  pnpm -r --filter '@kaoiro/wrapper-core' \
    --filter '@kaoiro/agent-common' --filter '@kaoiro/claude-code' \
    --filter '@kaoiro/codex' run build ) 2>&1 | tee -a "$logdir/stack.log"

# 2) Build runner dist. The workspace install in step 1 covered runner
# devDeps too. Unlike dev.sh (tsx watch on src), dogfood runs the
# compiled entry so runner source edits do NOT restart the process.
echo "dogfood: building runner..."
( cd "$root/runner" && pnpm build ) 2>&1 |
  tee -a "$logdir/stack.log"

# 3) Runner config: generate a localhost default on first run
# (gitignored). Same shape as scripts/dev.sh so switching launchers
# reuses the same host_id — avoids a second HostRegistry entry appearing
# server-side. The default is accept-all — every server-ingested pack is
# spawnable on this host (ADR-0031). To lock down: replace
# `blocked_personas` with `allowed_personas` for an allowlist, or list
# ids in blocked_personas to opt out of specific packs. Wrapper join is
# still gated server-side on PersonaAssets known_persona?/1 (ADR-0029
# F3).
runner_config="$root/runner/runner.config.json"
if [[ ! -f "$runner_config" ]]; then
  echo "dogfood: generating $runner_config (gitignored; edit to taste)"
  cat >"$runner_config" <<JSON
{
  "host_id": "dev-host",
  "server_url": "ws://localhost:4000/runner",
  "blocked_personas": [],
  "cwd_allowlist": ["$root"],
  "capabilities": ["claude-code", "codex"]
}
JSON
fi

# 4) Start the docker stack (server + bundled dashboard). --build rebuilds
# only when the image inputs changed, so re-runs after a no-op edit are
# fast. Detached so we can tail logs into stack.log while the runner
# takes the foreground.
echo "dogfood: starting docker stack (rebuilds if inputs changed)..."
( cd "$root/server" && "${dc[@]}" up -d --build ) 2>&1 |
  tee -a "$logdir/stack.log"

# 5) Tail docker logs into stack.log for post-mortem. --tail=0 skips the
# backlog so the file only carries the current session's output. Runner
# has its own reconnect loop, so we do not gate its launch on a readiness
# poll — if Phoenix is still binding :4000 the runner retries.
( cd "$root/server" && "${dc[@]}" logs -f --tail=0 ) </dev/null \
  >>"$logdir/stack.log" 2>&1 &
pids+=("$!")

# 6) Pin the Claude wrapper's startup model (parity with dev.sh — the
# SDK otherwise falls back to its own default, currently Opus 4.8).
# Runner inherits env and passes it to each spawned wrapper. Pre-set
# the var to override; setModel from the dashboard still overrides at
# runtime. Codex has no dev pin (account default).
: "${KAOIRO_CLAUDE_CODE_DEFAULT_MODEL:=claude-opus-4-7}"
export KAOIRO_CLAUDE_CODE_DEFAULT_MODEL

# 7) Launch runner from dist (no watch). Source-maps on so stack traces
# stay useful. Log via process substitution rather than a trailing
# `| tee` pipeline: under `set -m` a backgrounded pipeline puts `$!`
# on the LAST command (tee), while the PG leader is the FIRST command
# (the node subshell). Using tee's PID as the kill/wait target would
# leave `kill -TERM -<tee_pid>` addressing a non-existent PG and
# `wait <tee_pid>` blocking on tee until node closes the pipe — but
# node never received the signal, hanging Ctrl-C forever. Backgrounding
# the subshell directly makes `$!` == node's pid == the pgid.
( cd "$root/runner" &&
  exec node --enable-source-maps dist/cli.js runner.config.json
) </dev/null > >(tee -a "$logdir/runner.log") 2>&1 &
runner_pid=$!
pids+=("$runner_pid")

echo "dogfood: server+dashboard :4000 (docker) | runner (compiled, no watch)"
echo "dogfood: open http://localhost:4000/?token=<KAOIRO_CLIENT_TOKENS token> and launch agents via「+ 起動」"
echo "dogfood: to pick up code changes, Ctrl-C and re-run scripts/dogfood.sh"
echo "dogfood: logs -> $logdir/{stack,runner}.log (prev run kept as *.log.prev)"
echo "dogfood: Ctrl-C stops the whole stack (runner + docker compose down)"
wait
