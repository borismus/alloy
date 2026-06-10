#!/usr/bin/env bash
# Web-mode dev: run the Vite frontend (:1420) and the auto-rebuilding
# alloy-server backend (:3030) together, in one terminal. Ctrl-C stops both.
#
# The backend needs a vault path (it binds at launch). It's resolved in this
# order of precedence:
#   1. CLI arg:        npm run dev -- /path/to/vault
#   2. shell env:      ALLOY_VAULT=/path/to/vault npm run dev
#   3. .env file:      ALLOY_VAULT=/path/to/vault   (gitignored; the usual case)
#
# Set ALLOY_VAULT in .env once (see .env.example) and `npm run dev` just works.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Capture CLI arg and any pre-set shell value before .env can shadow them, then
# load .env so it fills in ALLOY_VAULT only when the shell didn't already set it.
ARG_VAULT="${1:-}"
SHELL_VAULT="${ALLOY_VAULT:-}"
if [[ -f "$ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/.env"
  set +a
fi
VAULT="${ARG_VAULT:-${SHELL_VAULT:-${ALLOY_VAULT:-}}}"

if [[ -z "$VAULT" ]]; then
  echo "error: no vault path. Set ALLOY_VAULT in .env (see .env.example), or:" >&2
  echo "  ALLOY_VAULT=/path/to/vault npm run dev" >&2
  echo "  npm run dev -- /path/to/vault" >&2
  exit 1
fi

# Resolve to an absolute path (dev-server.sh cd's into alloy-server, so a
# relative path would otherwise break) and verify the vault exists.
if ! VAULT="$(cd "$VAULT" 2>/dev/null && pwd)"; then
  echo "error: vault directory not found: ${ARG_VAULT:-${SHELL_VAULT:-${ALLOY_VAULT:-}}}" >&2
  exit 1
fi

# Free the dev ports before launching. cargo-watch runs the backend in its own
# process group, so our `kill 0` teardown (below) can't reliably reap it — on
# SIGHUP (closed terminal), a hard kill, or a crash mid-rebuild it orphans and
# keeps squatting :3030. A leftover backend then makes the next run's backend
# die with "Address already in use", leaving Vite with no server. Pre-flighting
# the ports guarantees a clean start regardless of how the last run ended.
VITE_PORT=1420
BACKEND_PORT="${ALLOY_DEV_PORT:-3030}"
for port in "$VITE_PORT" "$BACKEND_PORT"; do
  pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  if [[ -n "$pids" ]]; then
    echo "freeing port $port (killing: $pids)" >&2
    kill $pids 2>/dev/null || true
  fi
done

# Kill the whole process group on exit so the backend doesn't linger.
trap 'kill 0' EXIT INT TERM

bash "$ROOT/scripts/dev-server.sh" "$VAULT" &
npx vite &
wait
