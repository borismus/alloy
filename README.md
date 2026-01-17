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

## Features

### Core
- ✅ **Pick your vault folder** on first run
- ✅ **Conversations saved as YAML files** (human-readable, plain text)
- ✅ **Basic search** across all conversations
- ✅ **`memory.md` injected as context** in every conversation

### Multi-Provider Support
- ✅ **Anthropic** (Claude models with streaming)
- ✅ **OpenAI** (GPT-4o, GPT-4, etc.)
- ✅ **Google Gemini** (2.5 Pro, 2.5 Flash)
- ✅ **Ollama** (local models)
- ✅ **Side-by-side model comparison** mode
- ✅ **Image attachments** (drag & drop or paste)

### Skills System
- ✅ **Skills loaded from `$VAULT/skills/`** as markdown files
- ✅ **On-demand skill loading** via `use_skill` tool
- ✅ **Built-in tools** for skills: `read_file`, `write_file`, `append_file`, `http_get`, `http_post`, `get_secret`

### Topics
- ✅ **Pin conversations as topics** with recurring prompts
- ✅ **Topic scheduling** (manual trigger for now)

## File Structure

```
~/promptbox-vault/              # Your chosen vault location
├── conversations/
│   ├── 2025-01-10-1736547123-how-to-setup-tauri.yaml
│   ├── 2025-01-09-1736460789-project-brainstorm.yaml
│   └── ...
├── skills/                     # Custom skills (markdown files)
│   └── web-search.md           # Example skill with instructions
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

## Skills

Skills are markdown files in `$VAULT/skills/` that extend the AI's capabilities. Each skill is a `.md` file with YAML frontmatter:

```markdown
---
name: web-search
description: Search the web and summarize results
---

# Web Search Skill

When the user asks you to search the web, use the `http_get` tool to fetch...
```

The AI loads skills on-demand via the `use_skill` tool. Available built-in tools for skills:

| Tool | Description |
|------|-------------|
| `read_file` | Read files from the vault |
| `write_file` | Write/create files in the vault |
| `append_file` | Append to existing files |
| `http_get` | Fetch content from URLs |
| `http_post` | Send POST requests |
| `get_secret` | Access API keys from config |

## Trust Model

| What PromptBox does | What PromptBox doesn't do |
|---------------------|---------------------------|
| Stores files in a folder you choose | Phone home |
| Shows you exactly what's sent to LLMs | Collect analytics |
| Lets you edit/delete anything | Make decisions without you |
| Works offline (with local models*) | Lock you in |

*Ollama support already available for local models

## Roadmap

### ✅ v0.1 - MVP
- Pick your vault folder on first run
- Chat with Claude (single provider)
- Conversations saved as YAML files
- Basic search across conversations
- `memory.md` injected as context

### ✅ v0.2 - Multi-Provider & Images
- Multi-provider support (Claude, GPT, Gemini, Ollama)
- Provider switching within app
- Side-by-side model comparison
- Image attachments

### ✅ v0.3 - Topics & Skills
- Topics / standing queries with recurring prompts
- Skills system with on-demand loading
- Built-in tools (file ops, HTTP, secrets)

### v0.4 - Polish
- Improved topic scheduling (auto-trigger)
- Better skill discovery and management
- UI refinements

### v0.5 - Privacy & Local
- Privacy boundaries configuration
- Selective file/folder sharing
- Local LLM summarization layer

### v1.0 - Production Ready
- Polished UI
- Sync service (optional, paid)
- Browser extension
- Mobile companion app

## Tech Stack

- **Framework:** Tauri 2 (Rust backend, React frontend)
- **Frontend:** React 19 + TypeScript + Vite
- **Storage:** YAML/Markdown files in user-chosen directory
- **AI Providers:** Anthropic, OpenAI, Google Gemini, Ollama

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
- At least one AI provider API key (Anthropic, OpenAI, or Google), or Ollama running locally

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
