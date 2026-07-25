#!/usr/bin/env bash
# One-command dev stack for kaoiro. Launches all three components with hot
# reload / watch and tears the whole stack down on Ctrl-C:
#
#   server    (Elixir) : code_reloader recompiles lib/ on save        :4000
#   dashboard (Vite)   : HMR; proxies /client,/api,/personas to :4000  :5173
#   runner    (tsx)    : tsx watch on src/cli.ts (runner hot-reload);
#                        spawns each wrapper via `tsx watch` too
#                        (KAOIRO_WRAPPER_DEV=1) so wrapper source edits
#                        hot-reload the running agent
#
# Agents are launched from the dashboard (operator「+ 起動」), NOT from
# agent.*.json — the runner supervises them (ADR-0023/0024, issue #22).
# Manual equivalent is documented in server/README.md
# ("ローカル開発(ホットリロード)").
#
# DETS は $root/tmp/dev-data/*.dets に per-project 隔離する (issue #121)。
# OS 共有 tmp や `mix test` の DETS と衝突しない。dogfood.sh の docker
# named volume /var/lib/kaoiro による隔離と対称。
set -euo pipefail
# Job-control: each background job becomes its own process-group leader, so a
# single `kill -TERM -<pgid>` reliably reaps grandchildren (beam, vite, tsx)
# too. setsid is unavailable on macOS, so this is the portable teardown path.
set -m

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

for cmd in mix pnpm; do
  command -v "$cmd" >/dev/null 2>&1 ||
    { echo "dev: error — '$cmd' not found in PATH" >&2; exit 1; }
done

# mix does not auto-load .env, and the dashboard is rejected fail-closed
# without KAOIRO_CLIENT_TOKENS (server/README.md). Load it before launching.
if [[ -f "$root/server/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  . "$root/server/.env"
  set +a
else
  echo "dev: warn — server/.env not found; set KAOIRO_CLIENT_TOKENS" \
    "or the dashboard will be rejected" >&2
fi

# Isolate dev DETS stores under $root/tmp/dev-data/ (issue #121). Unset
# envs would otherwise fall through to each store's default_path (a shared
# $TMPDIR/kaoiro_*.dets), which is then read/written by both `mix test`
# (test fixture rows leaking into the dev dashboard) and any other dev
# instance on the same host. dogfood.sh already sits on a docker named
# volume /var/lib/kaoiro; this is the dev.sh-side counterpart. Each var uses
# ${VAR:-default} so an operator-set env (server/.env, direct export) still
# overrides. KAOIRO_TOKEN_DENYLIST_PATH is intentionally omitted: no
# runtime.exs entry wires that env into :token_denylist_path yet
# (TokenDenylist reads its module default_path fallback), so setting it
# here would have no effect.
data_dir="$root/tmp/dev-data"
mkdir -p "$data_dir"
export KAOIRO_INTER_AGENT_HISTORY_PATH="${KAOIRO_INTER_AGENT_HISTORY_PATH:-$data_dir/inter_agent_history.dets}"
export KAOIRO_SESSION_POINTERS_PATH="${KAOIRO_SESSION_POINTERS_PATH:-$data_dir/session_pointers.dets}"
export KAOIRO_AGENT_DIRECTORY_PATH="${KAOIRO_AGENT_DIRECTORY_PATH:-$data_dir/agent_directory.dets}"
export KAOIRO_PERMISSION_MODES_PATH="${KAOIRO_PERMISSION_MODES_PATH:-$data_dir/permission_modes.dets}"
export KAOIRO_CLEAR_WATERMARKS_PATH="${KAOIRO_CLEAR_WATERMARKS_PATH:-$data_dir/clear_watermarks.dets}"
export KAOIRO_SESSION_STARTS_PATH="${KAOIRO_SESSION_STARTS_PATH:-$data_dir/session_starts.dets}"
export KAOIRO_INGRESS_ORDER_PATH="${KAOIRO_INGRESS_ORDER_PATH:-$data_dir/ingress_order.dets}"

pids=()
cleanup() {
  trap - INT TERM EXIT
  echo
  echo "dev: stopping..."
  if [[ ${#pids[@]} -gt 0 ]]; then
    for pid in "${pids[@]}"; do
      # Negative target = whole process group (job-control leader).
      kill -TERM -"$pid" 2>/dev/null || true
    done
  fi
  wait 2>/dev/null || true
}
trap cleanup INT TERM EXIT

# Persist each component's stdout/stderr to tmp/dev-logs/<name>.log while
# still printing live to the terminal (tee). Logs are truncated on each run
# so the file always holds the current session; the previous one is kept as
# <name>.log.prev for one-step recovery after Ctrl-C. The whole directory is
# gitignored under /tmp/.
logdir="$root/tmp/dev-logs"
mkdir -p "$logdir"
rotate_log() {
  local name="$1"
  local f="$logdir/$name.log"
  [[ -f "$f" ]] && mv -f "$f" "$f.prev"
  : >"$f"
  printf 'dev-log %s started at %s\n' "$name" "$(date '+%Y-%m-%d %H:%M:%S')" >>"$f"
}
for name in server dashboard runner; do rotate_log "$name"; done

# Under `set -m` each background job is its own process group; a TTY read
# (mix's Hex/rebar install prompt, or the BEAM's shell init) raises SIGTTIN
# and stops the job. Redirect stdin from /dev/null so nothing reads the
# terminal; phx.server keeps serving on EOF (it runs with --no-halt).
# `| tee -a` duplicates the output to the per-component log file while
# keeping the live terminal view; the pipeline is one job (one PG) so the
# existing kill -TERM -<pgid> tears tee down too.
( cd "$root/server" && mix deps.get && mix deps.compile &&
  exec mix phx.server ) </dev/null 2>&1 | tee -a "$logdir/server.log" &
pids+=("$!")

# pnpm install AND pnpm dev get </dev/null: Vite was observed stuck in
# State T (SIGSTOP) on WSL2 when its stdin was still bound to the TTY;
# SIGCONT could not revive the process group, only a full stack restart
# did. Cutting the TTY input path here removes the SIGTTIN trigger.
( cd "$root/server/assets" && pnpm install </dev/null && exec pnpm dev ) \
  </dev/null 2>&1 | tee -a "$logdir/dashboard.log" &
pids+=("$!")

# Runner config: generate a localhost default on first run (gitignored).
# The default is accept-all — every server-ingested pack is spawnable on
# this host (ADR-0031). To lock down: replace `blocked_personas` with
# `allowed_personas` for an allowlist, or list ids in blocked_personas to
# opt out of specific packs. Wrapper join is still gated server-side on
# PersonaAssets known_persona?/1 (ADR-0029 F3).
runner_config="$root/runner/runner.config.json"
if [[ ! -f "$runner_config" ]]; then
  echo "dev: generating $runner_config (gitignored; edit to taste)"
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

# Pin the Claude wrapper's startup model for local dev; the SDK otherwise
# falls back to its own default (currently Opus 4.8). Runner inherits env and
# passes it to each spawned wrapper. Pre-set the var to override; setModel
# from the dashboard still overrides at runtime. Engine-split env (phase-15
# D1): replaces the legacy shared KAOIRO_WRAPPER_DEFAULT_MODEL, which leaked
# into Codex spawns; Codex has no dev pin (account default). See
# wrapper/claude-code/src/cli.ts.
: "${KAOIRO_CLAUDE_CODE_DEFAULT_MODEL:=claude-opus-4-7}"
export KAOIRO_CLAUDE_CODE_DEFAULT_MODEL

# runner via tsx watch (hot-reloads the runner itself). Wrapper hot reload
# (tsx watch on wrapper src) is OFF by default. During phase-15 implementation
# an in-place edit to wrapper/claude-code/src/cli.ts under KAOIRO_WRAPPER_DEV=1
# tsx watch caused the running Claude wrapper — which was the AI assistant
# editing that very file — to self-restart on every save and take down the
# whole stack. Under this default the runner spawns each wrapper as a dist
# binary, so wrapper src edits do NOT affect a running agent. To apply new
# wrapper code, run
#   pnpm -r --filter '@kaoiro/wrapper-core' \
#     --filter '@kaoiro/agent-common' --filter '@kaoiro/claude-code' \
#     --filter '@kaoiro/codex' run build
# and restart the target agent from the dashboard (「復元」). To opt back
# into wrapper hot reload (only when you know no running agent is the
# editing Claude wrapper), export KAOIRO_WRAPPER_DEV=1 before invoking
# scripts/dev.sh.
#
# Prebuild the 4 wrapper packages before tsx starts: their package.json all
# point `main` at `./dist/index.js` (phase-13 "typecheck/test は src、runtime
# は dist" 分離; ADR-0017/0032 F1). Under the default (dist) launch the
# runner needs those dist files to exist; under KAOIRO_WRAPPER_DEV=1 the tsx
# entry still resolves `@kaoiro/codex` etc. at top-level (runner/src/config.ts)
# so a missing dist ENOENTs before the watch loop even starts. `wrapper/` 直下
# は非メンバの meta shim なので root から `-r --filter` で 4 パッケージだけ topo
# build させる。
( cd "$root/runner" && pnpm install </dev/null &&
  cd "$root" && pnpm -r --filter '@kaoiro/wrapper-core' \
    --filter '@kaoiro/agent-common' --filter '@kaoiro/claude-code' \
    --filter '@kaoiro/codex' run build &&
  cd "$root/runner" &&
  exec pnpm exec tsx watch src/cli.ts runner.config.json
) </dev/null 2>&1 | tee -a "$logdir/runner.log" &
pids+=("$!")

echo "dev: server :4000  |  dashboard :5173 (Vite HMR)  |  runner watching (spawns hot-reloaded wrappers)"
echo "dev: open http://localhost:5173/?token=<KAOIRO_CLIENT_TOKENS token> and launch agents via「+ 起動」"
echo "dev: set KAOIRO_WRAPPER_TOKENS in server/.env to exercise the signed-token auth path"
echo "dev: logs -> $logdir/{server,dashboard,runner}.log (prev run kept as *.log.prev)"
echo "dev: Ctrl-C stops the whole stack"
wait
