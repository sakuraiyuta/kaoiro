#!/usr/bin/env bash
# One-command dev stack for kaoiro. Launches all three components with hot
# reload / watch and tears the whole stack down on Ctrl-C:
#
#   server    (Elixir) : code_reloader recompiles lib/ on save        :4000
#   dashboard (Vite)   : HMR; proxies /client,/api,/personas to :4000  :5173
#   wrapper   (tsx)    : tsx watch restarts each agent.*.json on change
#
# Manual equivalent is documented in server/README.md
# ("ローカル開発(ホットリロード)").
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

# Under `set -m` each background job is its own process group; a TTY read
# (mix's Hex/rebar install prompt, or the BEAM's shell init) raises SIGTTIN
# and stops the job. Redirect stdin from /dev/null so nothing reads the
# terminal; phx.server keeps serving on EOF (it runs with --no-halt).
( cd "$root/server" && mix deps.get && mix deps.compile &&
  exec mix phx.server ) </dev/null &
pids+=("$!")

# pnpm install's lifecycle hooks must not read the TTY either (SIGTTIN);
# pnpm dev (Vite) doesn't block on the TTY, so redirect only the install.
( cd "$root/server/assets" && pnpm install </dev/null && exec pnpm dev ) &
pids+=("$!")

( cd "$root/wrapper" && pnpm install </dev/null && exec pnpm dev ) &
pids+=("$!")

echo "dev: server :4000  |  dashboard :5173 (Vite HMR)  |  wrapper agents watching"
echo "dev: open http://localhost:5173/?token=<KAOIRO_CLIENT_TOKENS token>"
echo "dev: Ctrl-C stops the whole stack"
wait
