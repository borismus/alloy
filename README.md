# PromptBox

**Own your AI conversations**

A local-first, privacy-respecting app for managing your AI conversations. Radical transparency — everything is plain text files you control.

## Philosophy

PromptBox has your back. No analytics, no cloud dependency, no tricks. It does one thing well: manages your relationship with AI on *your* terms.

**The Obsidian test:**
- Can you find your data in Finder/Explorer? ✅
- Can you read it without the app? ✅
- Can you edit it with any text editor? ✅
- Can you sync it with your own tools? ✅
- Can you delete the app and keep everything? ✅

## Quick Start

```bash
# Install dependencies
npm install

# Launch the app (loads Rust and starts dev server)
./run.sh
```

**First time?** See [LAUNCH.md](LAUNCH.md) for detailed setup instructions including Rust installation.

## Features (MVP 0.1)

- ✅ **Pick your vault folder** on first run
- ✅ **Chat with Claude** (streaming responses)
- ✅ **Conversations saved as YAML files** (human-readable, plain text)
- ✅ **Basic search** across all conversations
- ✅ **`memory.md` injected as context** in every conversation

## File Structure

```
~/promptbox-vault/              # Your chosen vault location
├── conversations/
│   ├── 2025-01-10-1736547123-how-to-setup-tauri.yaml
│   ├── 2025-01-09-1736460789-project-brainstorm.yaml
│   └── ...
├── topics/                     # For future standing queries
├── memory.md                   # Your personal context
└── config.yaml                 # App settings
```

## Conversation Format

Each conversation is a YAML file:

```yaml
id: 2025-01-09-1736460789-project-brainstorm
created: 2025-01-09T10:30:00Z
model: claude-sonnet-4-20250514
title: How should I structure this API

messages:
  - role: user
    timestamp: 2025-01-09T10:30:00Z
    content: |
      How should I structure this API?

  - role: assistant
    timestamp: 2025-01-09T10:30:15Z
    content: |
      I'd recommend starting with the core resources...
```

## Memory Format

`memory.md` is plain Markdown:

```markdown
# Memory

## About me
- Software dood based in Seattle
- Prefer concise, direct communication

## Current projects
- PromptBox: local-first AI conversation manager
- Learning Rust
```

## Trust Model

| What PromptBox does | What PromptBox doesn't do |
|---------------------|---------------------------|
| Stores files in a folder you choose | Phone home |
| Shows you exactly what's sent to LLMs | Collect analytics |
| Lets you edit/delete anything | Make decisions without you |
| Works offline (with local models*) | Lock you in |

*Offline mode coming in v0.4 with Ollama support

## Roadmap

### ✅ MVP (v0.1) - DONE
- Pick your vault folder on first run
- Chat with Claude (single provider)
- Conversations saved as YAML files
- Basic search across conversations
- `memory.md` injected as context

### v0.2
- Multi-provider support (GPT, Gemini, Ollama)
- Provider switching within app
- Side-by-side model comparison
- Processing images
- Allow threads to continue in the background

### v0.3
- Topics / standing queries
- Daily digest generation
- Topic query interface

### v0.4
- Skills stored in $VAULT/skills

### v0.5
- Privacy boundaries configuration
- Selective file/folder sharing
- Local LLM summarization layer

### v1.0
- Polished UI
- Sync service (optional, paid)
- Browser extension
- Mobile companion app

## Tech Stack

- **Framework:** Tauri 2 (Rust backend, React frontend)
- **Frontend:** React 19 + TypeScript + Vite
- **Storage:** YAML/Markdown files in user-chosen directory
- **AI:** Anthropic SDK (Claude)

## Development

```bash
# Install dependencies
npm install

# Run in development
npm run tauri dev

# Build for production
npm run tauri build
```

See [DEV.md](DEV.md) for development notes and architecture details.

## Requirements

- Node.js (v18+)
- Rust (latest stable)
- Anthropic API key

### Installing Rust

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

After installation, restart your terminal or run:
```bash
source "$HOME/.cargo/env"
```

See [SETUP.md](SETUP.md) for detailed installation instructions.

## Contributing

This is an early MVP. Issues and PRs welcome!

## License

MIT (TBD - update as needed)

---

*PromptBox: Your AI conversations. Your files. Your control.*

**Built with lateral thinking & withered technology** 🚀
