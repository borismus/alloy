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

# Kill the whole process group on exit so the backend doesn't linger.
trap 'kill 0' EXIT INT TERM

bash "$ROOT/scripts/dev-server.sh" "$VAULT" &
npx vite &
wait
