#!/usr/bin/env bash
# Internal helper for `npm run dev` (scripts/dev.sh) — not a user-facing command.
# Live-reloads the standalone alloy-server: watches its Rust source and rebuilds
# + restarts the backend on change, so editing a .rs file needs no manual
# `cargo build`.
#
# Binds the dedicated dev port (default 3030, NOT 3001) so it never collides
# with an installed Alloy app holding :3001. The Vite proxy targets the same
# port — keep ALLOY_DEV_PORT in sync with vite.config.ts.
#
# Takes the vault path as $1 (or ALLOY_VAULT); dev.sh passes an absolute path.
set -euo pipefail

PORT="${ALLOY_DEV_PORT:-3030}"

VAULT="${1:-${ALLOY_VAULT:-}}"
if [[ -z "$VAULT" ]]; then
  echo "error: no vault path given (run via \`npm run dev\`)." >&2
  exit 1
fi

if ! command -v cargo-watch >/dev/null 2>&1; then
  echo "error: cargo-watch not found. Install it with:" >&2
  echo "  cargo install cargo-watch" >&2
  exit 1
fi

# Resolve to absolute before cd (defensive — dev.sh already does this, but this
# script may be invoked directly with a relative path).
if ! VAULT="$(cd "$VAULT" 2>/dev/null && pwd)"; then
  echo "error: vault directory not found: $VAULT" >&2
  exit 1
fi

cd "$(dirname "$0")/../alloy-server"
CMD="cargo run --bin alloy-serve -- --vault \"$VAULT\" --host 127.0.0.1 --port $PORT"
exec cargo watch -s "$CMD"
