#!/usr/bin/env bash
# Runs the Tauri CLI while tee-ing all output (Vite + cargo + Rust server logs)
# to a stable logfile so it can be inspected after the fact. Used by the `tauri`
# npm script, so `npm run tauri dev` / `npm run tauri build` are both captured.
set -o pipefail

LOG="${ALLOY_TAURI_LOG:-/tmp/alloy-tauri-dev.log}"

# Start each run with a fresh log + a header marking the invocation.
{
  echo "=== tauri $* @ $(date) ==="
} > "$LOG"

tauri "$@" 2>&1 | tee -a "$LOG"
