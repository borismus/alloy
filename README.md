# Wheelhouse

**Everything stays in your wheelhouse.**

Your AI conversations belong on your device — not on someone else's server. Wheelhouse gives you one helm for ChatGPT, Claude, Gemini, and more. Run them in parallel, let them deliberate, or cascade from fast to powerful.
Nothing leaves your machine. Ever.

## Why Wheelhouse?

**AI models are commoditizing fast.** The real power isn't in any single model — it's in navigating them:

- **Council mode**: Query multiple models at once. A chairman model synthesizes the best answer from all responses.
- **Comparison mode**: See every model's response side-by-side. Pick the winner yourself.
- **Triggers**: A fast, cheap model monitors your conversation and brings in reinforcements when needed.

No other chat app does this. They lock you into one provider. Wheelhouse sits above them all — you're the captain.

## Plus: You Own Everything

Wheelhouse stores every conversation as a plain YAML file in a folder you choose. Like Obsidian for notes, but for AI conversations.

| Question | Answer |
|----------|--------|
| Can you find your data in Finder/Explorer? | ✅ Yes |
| Can you read it without the app? | ✅ Yes |
| Can you edit it with any text editor? | ✅ Yes |
| Can you sync it with your own tools? | ✅ Yes |
| Can you delete the app and keep everything? | ✅ Yes |

No cloud lock-in. No proprietary formats. Your conversations stay yours.

## Where Wheelhouse Shines

### Multi-Model Intelligence
Use the right model for the job — or all of them at once. Council mode queries multiple models in parallel, then synthesizes a superior answer. Comparison mode shows you each response so you can judge for yourself.

### Smart Triggers
Set up rules that watch your conversation and fire automatically. A cheap model can monitor context and escalate to a powerful model when the task demands it. Or trigger a web search when current information is needed. Layers of intelligence, coordinated.

### Skills & Automation
Skills are plain-text instructions that teach your AI new capabilities. Search the web, fetch APIs, read and write files in your vault, chain actions into workflows. Your AI automation, version-controlled alongside your data.

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
- ✅ **Full-text search** across all conversations

### Multi-Provider Support
- ✅ **Anthropic** (Claude models with streaming)
- ✅ **OpenAI** (GPT-4o, GPT-4, etc.)
- ✅ **Google Gemini** (2.5 Pro, 2.5 Flash)
- ✅ **Ollama** (local models)
- ✅ **Side-by-side model comparison** mode
- ✅ **Image attachments** (drag & drop or paste)

### Skills & Tools
- ✅ **Custom skills** as markdown files with built-in tool access
- ✅ **Read/write files**, call APIs, chain actions together
- See [Skills & Tools](#skills--tools) section below for details

## File Structure

```
~/wheelhouse-vault/              # Your chosen vault location
├── conversations/
│   ├── 2025-01-10-1736547123-how-to-setup-tauri.yaml
│   ├── 2025-01-09-1736460789-project-brainstorm.yaml
│   └── ...
├── skills/                     # Custom skills (markdown files)
│   └── memory/SKILL.md
└── config.yaml                 # API keys and settings
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

## Skills & Tools

Skills turn Wheelhouse into a programmable AI platform. Each skill is a markdown file with instructions that teach the AI new behaviors — and give it access to tools that can take action.

### How It Works

1. You create a skill folder in `$VAULT/skills/` (e.g., `skills/my-skill/SKILL.md`)
2. The AI sees your available skills and loads them on-demand
3. Skills can use built-in tools to read files, call APIs, and save results

### Example: Memory Skill

```markdown
---
name: memory
description: Remember things about the user across conversations
---

# Memory Skill

When you learn something important about the user (preferences, projects,
facts they mention), save it to `memory.md` using `append_file`.
Before answering questions, check `memory.md` for relevant context.
```

When you tell the AI your preferences, it saves them and remembers across sessions.

### Built-in Tools

| Tool | What it does |
|------|--------------|
| `read_file` | Read files from your vault |
| `write_file` | Create or update files |
| `append_file` | Add to existing files |
| `search_directory` | Search files and content in vault directories |
| `http_get` | Fetch data from URLs |
| `http_post` | Send POST requests to APIs |
| `get_secret` | Securely access API keys from config |
| `web_search` | Search the web (requires SERPER_API_KEY) |
| `use_skill` | Load another skill on-demand |

Skills are just text files. Edit them, version control them, share them. Your AI capabilities live in your vault, not locked in someone else's platform.

## Privacy & Trust

Wheelhouse is radically transparent:

| What Wheelhouse does | What Wheelhouse doesn't do |
|---------------------|---------------------------|
| Stores files in a folder you choose | Phone home |
| Shows you exactly what's sent to LLMs | Collect analytics |
| Lets you edit/delete anything | Make decisions without you |
| Works offline (with Ollama) | Lock you in |

**No accounts. No telemetry. No cloud.** Your API keys stay on your machine. Your conversations never touch our servers (we don't have any).

## Roadmap

### ✅ v0.1 - MVP
- Pick your vault folder on first run
- Chat with Claude (single provider)
- Conversations saved as YAML files
- Basic search across conversations

### ✅ v0.2 - Multi-Provider & Images
- Multi-provider support (Claude, GPT, Gemini, Ollama)
- Provider switching within app
- Side-by-side model comparison
- Image attachments

### ✅ v0.3 - Skills & Triggers
- Skills system with on-demand loading
- Built-in tools (file ops, HTTP, secrets)
- Triggers for automated background execution

### v0.4 - Polish
- Better skill discovery and management
- UI refinements

### v0.5 - Privacy & Local
- Privacy boundaries configuration
- Selective file/folder sharing
- Local LLM summarization layer

### v0.6 - AI-Managed Notes
- AI that proactively organizes and maintains your knowledge base
- Automatic summarization and linking of related conversations
- Your notes, enhanced by AI — but still plain text you control

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

*Your AI conversations. Your files. Your control.*
