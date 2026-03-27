# Alloy Setup Guide

## Prerequisites

1. **Node.js** (v18 or later)
2. **Rust** (latest stable version)
3. At least one API key (Anthropic, OpenAI, Google Gemini, or xAI), or **Ollama** running locally

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
2. **Add API Keys**: Open Settings and add keys for the providers you want to use

Your vault will be initialized with:
- `conversations/` — Chat history (YAML)
- `notes/` — AI-managed notes (Markdown)
- `triggers/` — Scheduled prompts (YAML)
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

Use the search box in the sidebar to search across all your conversations by content or date.

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

### API Key Issues

Your API keys are stored in `[vault-path]/config.yaml`. You can also update them through the Settings panel in the app.

### Conversations Not Loading

Check that your vault folder exists and has the correct structure (see "First Run" above).

---

**Alloy**: Your AI conversations. Your files. Your control.
