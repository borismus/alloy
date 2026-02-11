#!/bin/bash
set -e

# Version bump script for Wheelhouse
# Updates version in all required files, commits, and tags

usage() {
    echo "Usage: $0 <version> [--push]"
    echo ""
    echo "Arguments:"
    echo "  version    New version number (e.g., 0.1.22)"
    echo "  --push     Push commit and tag to remote after creating"
    echo ""
    echo "Example:"
    echo "  $0 0.1.22"
    echo "  $0 0.1.22 --push"
    exit 1
}

if [ -z "$1" ]; then
    usage
fi

VERSION="$1"
PUSH=false

if [ "$2" = "--push" ]; then
    PUSH=true
fi

# Validate version format (basic semver)
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "Error: Version must be in format X.Y.Z (e.g., 0.1.22)"
    exit 1
fi

# Get script directory and project root
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

echo "Bumping version to $VERSION..."

# Update package.json
echo "  Updating package.json..."
sed -i '' "s/\"version\": \"[^\"]*\"/\"version\": \"$VERSION\"/" "$PROJECT_ROOT/package.json"

# Update tauri.conf.json
echo "  Updating tauri.conf.json..."
sed -i '' "s/\"version\": \"[^\"]*\"/\"version\": \"$VERSION\"/" "$PROJECT_ROOT/src-tauri/tauri.conf.json"

# Update Cargo.toml (only the package version, not dependencies)
echo "  Updating Cargo.toml..."
sed -i '' "s/^version = \"[^\"]*\"/version = \"$VERSION\"/" "$PROJECT_ROOT/src-tauri/Cargo.toml"

# Sync package-lock.json
echo "  Syncing package-lock.json..."
cd "$PROJECT_ROOT"
npm install --package-lock-only --silent

# Verify all versions match
echo ""
echo "Verifying versions..."
PKG_VERSION=$(grep '"version"' "$PROJECT_ROOT/package.json" | head -1 | sed 's/.*"version": "\([^"]*\)".*/\1/')
TAURI_VERSION=$(grep '"version"' "$PROJECT_ROOT/src-tauri/tauri.conf.json" | head -1 | sed 's/.*"version": "\([^"]*\)".*/\1/')
CARGO_VERSION=$(grep '^version = ' "$PROJECT_ROOT/src-tauri/Cargo.toml" | sed 's/version = "\([^"]*\)"/\1/')

echo "  package.json:     $PKG_VERSION"
echo "  tauri.conf.json:  $TAURI_VERSION"
echo "  Cargo.toml:       $CARGO_VERSION"

if [ "$PKG_VERSION" != "$VERSION" ] || [ "$TAURI_VERSION" != "$VERSION" ] || [ "$CARGO_VERSION" != "$VERSION" ]; then
    echo ""
    echo "Error: Version mismatch detected!"
    exit 1
fi

echo ""
echo "All versions updated to $VERSION"

# Git operations
echo ""
echo "Creating git commit and tag..."
git add "$PROJECT_ROOT/package.json" "$PROJECT_ROOT/package-lock.json" "$PROJECT_ROOT/src-tauri/tauri.conf.json" "$PROJECT_ROOT/src-tauri/Cargo.toml"
git commit -m "Bump version to $VERSION"
git tag "v$VERSION"

echo "  Created commit and tag v$VERSION"

if [ "$PUSH" = true ]; then
    echo ""
    echo "Pushing to remote..."
    git push
    git push origin "v$VERSION"
    echo "  Pushed commit and tag to remote"
fi

echo ""
echo "Done! Version $VERSION is ready."
if [ "$PUSH" = false ]; then
    echo ""
    echo "To push, run:"
    echo "  git push && git push origin v$VERSION"
fi