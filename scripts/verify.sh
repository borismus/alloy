#!/usr/bin/env bash
# Full local verification gate — mirrors CI (.github/workflows/ci.yml): types,
# lint, TS unit tests, Rust tests, the web build, and the smoke suite. Run
# before pushing:
#
#   npm run verify
#
# Runs every check (doesn't stop at the first failure) and prints a summary, so
# one run surfaces everything that's broken.
#
# Smoke is included despite costing ~45s because it is the only layer that
# catches a renamed class or moved control: a CSS/markup change can pass
# typecheck, lint, and every unit test, then fail CI. Skip it deliberately with
# VERIFY_SKIP_SMOKE=1 when iterating on something it can't touch.
#
# It needs Playwright browsers (`npx playwright install chromium webkit`). If
# they are missing the step fails loudly rather than being skipped, because a
# gate that quietly drops a check is worse than one that is slow.
#
# Note: dist-web is embedded into alloy-serve by rust-embed, so the web build
# above is what smoke actually serves — it must run first.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

SKIP_SMOKE="${VERIFY_SKIP_SMOKE:-0}"

fail=0
results=()
step() {
  local name="$1"; shift
  echo ""
  echo "▶ $name"
  if "$@"; then
    results+=("$name|✓")
  else
    results+=("$name|✗ FAILED")
    fail=1
  fi
}

step "typecheck"  npm run typecheck
step "lint"       npm run lint
step "unit tests" npm run test:run
step "rust tests" cargo test --manifest-path alloy-server/Cargo.toml
# The desktop shell is otherwise compiled only by the release workflow, on a
# tag — too late to learn it doesn't build. CI can't cover it either (Linux
# runners lack the webkit toolchain), so this local gate is the only place its
# own tests — supervisor/port-conflict behavior — ever run.
step "tauri shell" cargo test --manifest-path src-tauri/Cargo.toml
step "web build"  npx vite build
# `npm run test:smoke` rebuilds dist-web first; the step above already did, so
# call Playwright directly rather than paying for a second build.
if [ "$SKIP_SMOKE" = "1" ]; then
  results+=("smoke tests|- skipped (VERIFY_SKIP_SMOKE=1)")
else
  step "smoke tests" npx playwright test -c playwright.smoke.config.ts
fi

echo ""
echo "── verify summary ──────────────"
for r in "${results[@]}"; do
  printf "  %-12s %s\n" "${r%%|*}" "${r##*|}"
done
if [ "$fail" -eq 0 ]; then
  echo "✓ all checks passed"
else
  echo "✗ some checks failed"
fi
exit "$fail"
