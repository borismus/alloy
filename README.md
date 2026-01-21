# PromptBox

**Own your AI conversations**

ChatGPT, Claude.ai, Gemini — they all trap your conversations in their cloud. PromptBox gives them back to you. Every conversation is a plain text file on your computer that you fully control.

## Why PromptBox?

**Your conversations are valuable.** They contain your ideas, your decisions, your learning journey. But when you use ChatGPT or Claude.ai:
- You can't search across all your conversations effectively
- You can't edit or annotate past conversations
- You can't back them up or sync them your way
- You can't switch providers without losing everything
- You can't run queries offline

PromptBox fixes all of this. It's a desktop app that stores conversations as simple YAML files in a folder you choose. Use any AI provider. Switch anytime. Keep everything forever.

## The Obsidian Test

PromptBox passes the same data ownership test as Obsidian:

| Question | Answer |
|----------|--------|
| Can you find your data in Finder/Explorer? | ✅ Yes |
| Can you read it without the app? | ✅ Yes |
| Can you edit it with any text editor? | ✅ Yes |
| Can you sync it with your own tools? | ✅ Yes |
| Can you delete the app and keep everything? | ✅ Yes |

No cloud lock-in. No proprietary formats. No tricks.

## Where PromptBox Shines

### Compare Models Side-by-Side
Not sure if Claude or GPT is better for your use case? PromptBox's comparison mode sends the same prompt to multiple models simultaneously. See their responses side-by-side and pick the best one.

### Automate with Skills
Skills are plain-text instructions that teach your AI new capabilities. A skill can search the web, fetch APIs, read and write files in your vault, and chain these together into powerful workflows. Create a "daily digest" skill that pulls news and summarizes it. Or a "research" skill that searches, saves findings, and updates your notes. Your AI workflows, version-controlled alongside your data.

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
│   └── web-search.md
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

Skills turn PromptBox into a programmable AI platform. Each skill is a markdown file with instructions that teach the AI new behaviors — and give it access to tools that can take action.

### How It Works

1. You create a skill file in `$VAULT/skills/` (e.g., `web-search.md`)
2. The AI sees your available skills and loads them on-demand
3. Skills can use built-in tools to read files, call APIs, and save results

### Example: Web Search Skill

```markdown
---
name: web-search
description: Search the web using Serper API
---

# Web Search

When asked to search, use `get_secret` to get the SERPER_API_KEY,
then `http_post` to query the Serper API. Summarize the top results
and offer to save them to the user's notes.
```

When you ask "search for recent news about AI," the AI loads this skill, calls the API, and can save findings to your vault — all transparently.

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
| `use_skill` | Load another skill on-demand |

Skills are just text files. Edit them, version control them, share them. Your AI capabilities live in your vault, not locked in someone else's platform.

## Privacy & Trust

PromptBox is radically transparent:

| What PromptBox does | What PromptBox doesn't do |
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
