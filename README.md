# Wheelhouse

**Everything stays in your wheelhouse.**

Your AI conversations belong on your device — not on someone else's server. Wheelhouse gives you one helm for Claude, ChatGPT, Gemini, Grok, and local models. Run them in parallel, let them deliberate, or cascade from fast to powerful.
Nothing leaves your machine. Ever.

## Why Wheelhouse?

**AI models are commoditizing fast.** The real power isn't in any single model — it's in navigating them:

- **Background mode**: An orchestrator classifies your request and delegates tasks to specialized agents that work autonomously in the background.
- **Triggers**: Scheduled autonomous prompts that fire on intervals — monitor feeds, check conditions, run recurring tasks.

No other chat app does this. They lock you into one provider. Wheelhouse sits above them all — you're the captain.

## Plus: You Own Everything

Wheelhouse stores every conversation as a plain YAML file in a folder you choose. Like Obsidian for notes, but for AI conversations.

| Question | Answer |
|----------|--------|
| Can you find your data in Finder/Explorer? | Yes |
| Can you read it without the app? | Yes |
| Can you edit it with any text editor? | Yes |
| Can you sync it with your own tools? | Yes |
| Can you delete the app and keep everything? | Yes |

No cloud lock-in. No proprietary formats. Your conversations stay yours.

## Where Wheelhouse Shines

### Multi-Model Intelligence
Use the right model for the job — or all of them at once. Sub-agents can query multiple models in parallel, and the primary model synthesizes a superior answer from their responses.

### Background Mode
Send complex tasks to an orchestrator that breaks them down and delegates to specialized agents. Work continues in the background while you do other things — check back when it's done.

### Riff Mode
Think out loud. Riff mode gives you a freeform drafting space where you stream thoughts as an append-only log. When you're ready, the AI crystallizes your riffs into structured notes with proposed changes you approve one by one.

### Smart Triggers
Set up scheduled prompts that fire on intervals. A cheap model can monitor conditions and escalate to a powerful model when needed. Or run recurring checks — weather, news, system health — on autopilot.

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
- **Pick your vault folder** on first run
- **Conversations saved as YAML files** (human-readable, plain text)
- **Full-text search** across all conversations
- **LaTeX math rendering** in responses (via KaTeX)
- **Auto-updates** with signed releases

### Multi-Provider Support
- **Anthropic**
- **OpenAI**
- **Google Gemini**
- **xAI**
- **Ollama** (local models)
- **Image attachments** (drag & drop or paste)

### Skills & Tools
- **Custom skills** as markdown files with built-in tool access
- **Sub-agents** — spawn parallel workers for independent subtasks
- **Read/write files**, call APIs, chain actions together
- See [Skills & Tools](#skills--tools) section below for details

## File Structure

```
~/wheelhouse-vault/              # Your chosen vault location
├── config.yaml                  # API keys and settings
├── memory.md                    # Persistent AI memory
├── conversations/               # Chat history (YAML)
│   ├── attachments/             # Image attachments
│   └── ...
├── notes/                       # AI-managed notes (Markdown)
├── triggers/                    # Scheduled prompts (YAML)
├── skills/                      # Custom skills (Markdown)
└── riffs/                     # Draft notes (Markdown)
```

## Conversation Format

Each conversation is a YAML file:

```yaml
id: 2025-01-09-1736460789-project-brainstorm
created: 2025-01-09T10:30:00Z
model: anthropic/claude-sonnet-4-5-20250929
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
facts they mention), save it to `memory.md` using `append_to_note`.
Before answering questions, check `memory.md` for relevant context.
```

When you tell the AI your preferences, it saves them and remembers across sessions.

### Built-in Tools

| Tool | What it does |
|------|--------------|
| `read_file` | Read files from your vault |
| `write_file` | Create or update files |
| `append_to_note` | Append to notes with provenance tracking |
| `list_directory` | List files in vault directories |
| `search_directory` | Search files and content in vault directories |
| `http_get` | Fetch data from URLs |
| `http_post` | Send POST requests to APIs |
| `get_secret` | Securely access API keys from config |
| `web_search` | Search the web (Serper or SearXNG) |
| `use_skill` | Load another skill on-demand |
| `spawn_subagent` | Run 1–3 parallel sub-agents for independent tasks |

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

## Tech Stack

- **Framework:** Tauri 2 (Rust backend, React frontend) + web/server mode
- **Frontend:** React 19 + TypeScript + Vite
- **Storage:** YAML/Markdown files in user-chosen directory
- **AI Providers:** Anthropic, OpenAI, Google Gemini, xAI, Ollama

## Development

```bash
# Install dependencies
npm install

# Run desktop app in development
npm run tauri dev

# Run web-only mode (no Tauri/Rust required)
npm run dev:web

# Run tests
npm run test:run

# Build for production
npm run tauri build
```

See [DEV.md](DEV.md) for development notes and architecture details.

## Requirements

- Node.js (v18+)
- Rust (latest stable)
- At least one AI provider API key (Anthropic, OpenAI, Google, xAI), or Ollama running locally

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

[MIT](LICENSE)

---

*Your AI conversations. Your files. Your control.*
