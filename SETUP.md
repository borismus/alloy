# Alloy Setup Guide

## Prerequisites

1. **Node.js** (v18 or later)
2. **Rust** (latest stable version)
3. **Anthropic API Key** - Get one from https://console.anthropic.com/

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

1. **Select Vault Folder**: Choose a folder where your conversations will be stored
2. **Enter API Key**: Provide your Anthropic API key when prompted

Your vault will be initialized with:
- `conversations/` - All your conversation files (YAML format)
- `topics/` - For future standing queries feature
- `memory.md` - Your personal context/preferences
- `config.yaml` - App configuration

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

Your API key is stored in `[vault-path]/config.yaml`. You can:
- Edit it directly in the file
- Update it through the app's settings (coming soon)

### Conversations Not Loading

Check that your vault folder has the correct structure:
```
vault/
├── conversations/
├── topics/
├── memory.md
└── config.yaml
```

## File Structure

All your data lives in plain text files:

- **Conversations**: `conversations/YYYY-MM-DD-timestamp.yaml`
- **Memory**: `memory.md` (Markdown)
- **Config**: `config.yaml` (YAML)

You can edit these files with any text editor, back them up, sync them—they're yours!

## MVP 0.1 Features

- ✅ Vault folder selection
- ✅ Chat with Claude (Sonnet 4)
- ✅ Conversations saved as YAML
- ✅ Basic search
- ✅ Memory.md context injection

## Coming Soon (v0.2+)

- Multi-provider support (GPT, Gemini, Ollama)
- Side-by-side model comparison
- Topics/standing queries
- Privacy boundaries
- And more!

---

**Alloy**: Your AI conversations. Your files. Your control.
