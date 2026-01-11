#!/bin/bash

# PromptBox Development Launcher
# This script ensures Rust is in the PATH before launching

# Add Rust to PATH
if [ -f "$HOME/.cargo/env" ]; then
    source "$HOME/.cargo/env"
fi

# Verify Rust is available
if ! command -v cargo &> /dev/null; then
    echo "❌ Error: Rust/Cargo not found in PATH"
    echo ""
    echo "Please install Rust first:"
    echo "  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
    echo ""
    echo "Then run this script again."
    exit 1
fi

echo "✅ Rust found: $(rustc --version)"
echo "🚀 Launching PromptBox..."
echo ""

# Run the dev server
npm run tauri dev
