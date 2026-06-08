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

# cargo and cargo-watch live in ~/.cargo/bin, which isn't always on a non-login
# shell's PATH (e.g. the env npm spawns scripts in). Ensure it's reachable so
# `cargo watch` resolves regardless of the user's interactive PATH.
export PATH="$HOME/.cargo/bin:$PATH"

PORT="${ALLOY_DEV_PORT:-3030}"

VAULT="${1:-${ALLOY_VAULT:-}}"
if [[ -z "$VAULT" ]]; then
  echo "error: no vault path given (run via \`npm run dev\`)." >&2
  exit 1
fi

# Resolve to absolute before cd (defensive — dev.sh already does this, but this
# script may be invoked directly with a relative path).
if ! VAULT="$(cd "$VAULT" 2>/dev/null && pwd)"; then
  echo "error: vault directory not found: $VAULT" >&2
  exit 1
fi

cd "$(dirname "$0")/../alloy-server"
RUN=(cargo run --bin alloy-serve -- --vault "$VAULT" --host 127.0.0.1 --port "$PORT")

# Prefer cargo-watch for Rust live-reload; fall back to a plain run so the
# backend ALWAYS comes up (a missing cargo-watch must not leave Vite with no
# server — that just yields a flood of /api ECONNREFUSED).
if command -v cargo-watch >/dev/null 2>&1; then
  exec cargo watch -s "$(printf '%q ' "${RUN[@]}")"
else
  echo "warning: cargo-watch not found — running the backend WITHOUT live-reload." >&2
  echo "  for auto-rebuild on Rust changes: cargo install cargo-watch" >&2
  exec "${RUN[@]}"
fi
