# Alloy Setup Guide

## Prerequisites

1. **Node.js** (`^20.19.0` or `>=22.12.0`)
2. **Rust** (latest stable version)
3. At least one provider: an OpenAI-compatible API, a local **oMLX** endpoint, or a logged-in Claude/Codex subscription CLI

## Installation

### 1. Install Rust (if not already installed)

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source $HOME/.cargo/env
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Run in Development Mode

```bash
npm run tauri dev
```

This will:
- Start the Vite dev server
- Compile the Rust backend
- Launch the Alloy application

## First Run

When you first launch Alloy:

1. **Select Vault Folder**: Choose a folder where your data will be stored
2. **Configure Providers**: Open Settings → **Edit config.yaml** and configure an API, local endpoint, or Claude/Codex CLI adapter. The complete v2 examples are in [README.md](README.md#supported-providers).

Your vault will be initialized with:
- `conversations/` — Chat history (YAML)
- `notes/` — AI-managed notes (Markdown)
- `tasks/` — Cron-based scheduled tasks (YAML)
- `skills/` — Custom skills (Markdown)
- `riffs/` — Draft notes (Markdown)
- `memory.md` — Persistent context injected into system prompt
- `config.yaml` — API keys and settings

## Usage

### Starting a Conversation

1. Click the `+` button in the sidebar
2. Type your message and press Enter (Shift+Enter for new lines)
3. Conversations are automatically saved to your vault

### Searching Conversations

Use the search box in the sidebar to search conversation, note, and riff titles and bodies. Matching context appears as a snippet; body search runs in the Rust backend rather than loading the whole vault into the browser.

### Memory

Edit `memory.md` in your vault folder to add personal context that will be included with every conversation.

## Building for Production

```bash
npm run tauri build
```

This creates a native application in `src-tauri/target/release/bundle/`

## Troubleshooting

### Can't find Rust/Cargo

Make sure to run:
```bash
source $HOME/.cargo/env
```

Or restart your terminal after installing Rust.

### Provider Issues

Provider configuration lives in `[vault-path]/config.yaml`; Settings opens that file for editing. Config v2 is strict and rejects obsolete provider kinds. Claude requires a logged-in `claude` CLI, Codex requires `codex login`, and local OpenAI-compatible endpoints should set `local: true` only when they use a private-network URL.

### Conversations Not Loading

Check that your vault folder exists and has the correct structure (see "First Run" above).

---

**Alloy**: Your AI conversations. Your files. Your control.
