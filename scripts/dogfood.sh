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
  echo "dogfood: generating $runner_config with server_url=ws://localhost:4000/runner" \
    "(gitignored; edit to taste, or override at any time via" \
    "KAOIRO_RUNNER_SERVER_URL without touching this file — issue #140)"
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

# 4) Runner auth token (issue #138). dogfood runs the *release* image, so
# the server evaluates auth in :prod — there an unset KAOIRO_RUNNER_TOKENS
# rejects EVERY runner join (fail-closed), unlike dev.sh which runs mix in
# :dev where the unset list still means "auth off". Wire both ends here:
# mint a pair into server/.env on first run, then hand the matching value
# to the runner via KAOIRO_RUNNER_TOKEN. The token deliberately never
# enters runner.config.json (runner/README.md) — the runner reads it from
# the env only.
env_file="$root/server/.env"
host_id="$(node -e \
  'process.stdout.write(String(require(process.argv[1]).host_id ?? ""))' \
  "$runner_config")"
# Same charset the runner enforces on its side (HOST_ID_PATTERN in
# runner/src/config.ts). Checked BEFORE the value reaches the env file: a
# newline in host_id would otherwise append arbitrary KEY=VALUE lines
# that compose loads with last-one-wins, silently overriding
# SECRET_KEY_BASE or the client tokens. Every exit in this step clears
# the EXIT trap first — nothing is up yet, so the cleanup handler would
# otherwise `docker compose down` a stack this run never started.
if [[ ! "$host_id" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "dogfood: error — host_id in $runner_config must match" \
    "[A-Za-z0-9._-]+" >&2
  trap - EXIT
  exit 1
fi

# Only mint when the key is absent entirely. An existing line is the
# operator's own pairing (possibly shared with a real deployment), so it
# is read, never rewritten.
if ! grep -qE '^[[:space:]]*KAOIRO_RUNNER_TOKENS=' "$env_file"; then
  echo "dogfood: server/.env has no KAOIRO_RUNNER_TOKENS — minting one for" \
    "host_id=$host_id (the release rejects runners without it)"
  # Mint into a variable first. A command substitution that fails inside
  # printf's ARGUMENT list leaves printf's own status at 0, so set -e
  # would not catch it and a valueless `<host_id>:` pair would land in
  # the file — which the server drops as malformed (Auth.parse_pairs/1)
  # while the grep above still sees the key, blocking every later re-mint.
  minted_token="$(node -e "process.stdout.write(
    require('crypto').randomBytes(32).toString('hex'))")"
  if [[ ${#minted_token} -ne 64 ]]; then
    echo "dogfood: error — runner token generation failed" >&2
    trap - EXIT
    exit 1
  fi
  {
    printf '\n# Added by scripts/dogfood.sh: the release image rejects\n'
    printf '# runner joins while this is unset (issue #138). dogfood hands\n'
    printf '# the matching value to the runner as KAOIRO_RUNNER_TOKEN.\n'
    printf 'KAOIRO_RUNNER_TOKENS=%s:%s\n' "$host_id" "$minted_token"
  } >>"$env_file"
  # The file now carries a secret this script minted, so match the 0600
  # the runner wizard gives runner.env (runner/src/setup.ts).
  chmod go-rwx "$env_file" 2>/dev/null || true
fi

# A pre-set env var wins, so an operator can point the runner at another
# token without touching server/.env.
if [[ -z "${KAOIRO_RUNNER_TOKEN:-}" ]]; then
  # Last assignment wins, matching how compose reads env_file. The value
  # is piped (not passed as an argv) so it stays out of the process list,
  # and the pair split honours only the FIRST colon — server-side
  # parsing (Auth.parse_pairs/1) allows a colon inside the token.
  KAOIRO_RUNNER_TOKEN="$(
    grep -E '^[[:space:]]*KAOIRO_RUNNER_TOKENS=' "$env_file" | tail -n 1 |
      sed -E "s/^[[:space:]]*KAOIRO_RUNNER_TOKENS=//; s/^['\"]//; s/['\"]$//" |
      awk -v host="$host_id" -F, '{
        for (i = 1; i <= NF; i++) {
          at = index($i, ":")
          if (at == 0) continue
          key = substr($i, 1, at - 1)
          value = substr($i, at + 1)
          gsub(/^[ \t]+|[ \t]+$/, "", key)
          gsub(/^[ \t]+|[ \t]+$/, "", value)
          if (key == host) { print value; exit }
        }
      }'
  )"
  if [[ -z "$KAOIRO_RUNNER_TOKEN" ]]; then
    echo "dogfood: error — server/.env sets KAOIRO_RUNNER_TOKENS but has no" \
      "entry for host_id=$host_id" >&2
    echo "  add '$host_id:<token>' to it (an entry with an empty token" \
      "counts as missing), or export KAOIRO_RUNNER_TOKEN=<token> before" \
      "re-running" >&2
    trap - EXIT
    exit 1
  fi
fi
export KAOIRO_RUNNER_TOKEN

# 5) Start the docker stack (server + bundled dashboard). --build rebuilds
# only when the image inputs changed, so re-runs after a no-op edit are
# fast. Detached so we can tail logs into stack.log while the runner
# takes the foreground.
echo "dogfood: starting docker stack (rebuilds if inputs changed)..."
( cd "$root/server" && "${dc[@]}" up -d --build ) 2>&1 |
  tee -a "$logdir/stack.log"

# 6) Tail docker logs into stack.log for post-mortem. --tail=0 skips the
# backlog so the file only carries the current session's output. Runner
# has its own reconnect loop, so we do not gate its launch on a readiness
# poll — if Phoenix is still binding :4000 the runner retries.
( cd "$root/server" && "${dc[@]}" logs -f --tail=0 ) </dev/null \
  >>"$logdir/stack.log" 2>&1 &
pids+=("$!")

# 7) Pin the Claude wrapper's startup model (parity with dev.sh — the
# SDK otherwise falls back to its own default, currently Opus 4.8).
# Runner inherits env and passes it to each spawned wrapper. Pre-set
# the var to override; setModel from the dashboard still overrides at
# runtime. Codex has no dev pin (account default).
: "${KAOIRO_CLAUDE_CODE_DEFAULT_MODEL:=claude-opus-4-7}"
export KAOIRO_CLAUDE_CODE_DEFAULT_MODEL

# 8) Launch runner from dist (no watch). Source-maps on so stack traces
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
