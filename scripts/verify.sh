#!/usr/bin/env bash
# Full local verification gate — mirrors CI (.github/workflows/ci.yml): types,
# lint, TS unit tests, Rust tests, and the web build. Run before pushing:
#
#   npm run verify
#
# Runs every check (doesn't stop at the first failure) and prints a summary, so
# one run surfaces everything that's broken. The smoke suite is separate and
# slower: `npm run test:smoke`.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

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
# tag — too late to learn it doesn't build. `check` rather than `test` keeps the
# gate quick; the shell's logic lives in alloy-server, where it is tested.
step "tauri shell" cargo check --manifest-path src-tauri/Cargo.toml
step "web build"  npx vite build

echo ""
echo "── verify summary ──────────────"
for r in "${results[@]}"; do
  printf "  %-11s %s\n" "${r%%|*}" "${r##*|}"
done
if [ "$fail" -eq 0 ]; then
  echo "✓ all checks passed"
else
  echo "✗ some checks failed"
fi
exit "$fail"
