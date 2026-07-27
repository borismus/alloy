#!/usr/bin/env bash
# Boots the standalone alloy-serve against a FRESH copy of the seeded fixture
# vault (tests/smoke/fixture-vault) for the Playwright smoke suite
# (playwright.smoke.config.ts). Single origin: alloy-serve serves both the
# embedded SPA (from dist-web/) and /api, exactly like the standalone/shared
# app a mobile browser hits.
#
# Not a user-facing command — invoked by Playwright's webServer. Run the whole
# suite with `npm run test:smoke` (which builds dist-web first).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${SMOKE_PORT:-4319}"
FIXTURE="$ROOT/tests/smoke/fixture-vault"
BIN="$ROOT/alloy-server/target/debug/alloy-serve"

if [[ ! -f "$ROOT/dist-web/index.html" ]]; then
  echo "smoke: dist-web/ not built — run 'npm run test:smoke' (or 'npx vite build')." >&2
  exit 1
fi

# Build the backend AFTER dist-web exists. alloy-serve embeds the SPA at COMPILE
# time (rust-embed) and won't re-bundle just because dist-web changed on disk, so
# a binary built before `vite build` serves an empty SPA (GET / -> 404). Touch
# the embed source to force a fresh bundle of the current dist-web every run.
echo "smoke: building alloy-serve..." >&2
touch "$ROOT/alloy-server/src/routes/static_files.rs"
(cd "$ROOT/alloy-server" && cargo build --bin alloy-serve >&2)

# Fresh temp copy so the app's writes (watchers, self-writes) never dirty the
# checked-in fixture and every run starts from an identical state.
VAULT="$(mktemp -d "${TMPDIR:-/tmp}/alloy-smoke-XXXXXX")"
cp -R "$FIXTURE"/. "$VAULT"/

SERVER_PID=""
cleanup() {
  [[ -n "$SERVER_PID" ]] && kill "$SERVER_PID" 2>/dev/null || true
  rm -rf "$VAULT"
}
trap cleanup EXIT INT TERM

echo "smoke: serving $VAULT on http://127.0.0.1:$PORT" >&2
"$BIN" --vault "$VAULT" --host 127.0.0.1 --port "$PORT" &
SERVER_PID=$!
wait "$SERVER_PID"
