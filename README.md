# Alloy

A local-first, multi-model AI chat app. Bring your own API keys, talk to Claude, GPT, Gemini, Grok, or local models via Ollama. All conversations stored as plain text files in a folder you choose.

[Blog post](https://smus.com/alloy-local-first-ai-workbench/) · [Download for macOS](https://github.com/borismus/alloy/releases)

![Alloy screenshot](/docs/screenshot.png)

## Quick Start

Download the latest release from the [releases page](https://github.com/borismus/alloy/releases), or build from source:

```bash
npm install
npm run tauri dev
```

On first launch, pick a vault folder and add at least one API key in settings. See [SETUP.md](SETUP.md) for detailed instructions including Rust installation.

## Vault Structure

Everything lives in your vault folder as plain files:

```
~/alloy-vault/
├── config.yaml              # API keys and settings
├── memory.md                # Persistent context injected into system prompt
├── conversations/           # Chat history (YAML)
│   └── attachments/         # Image attachments
├── notes/                   # AI-managed notes (Markdown)
├── triggers/                # Scheduled prompts (YAML)
├── skills/                  # Custom skills (Markdown)
└── riffs/                   # Draft notes (Markdown)
```

Conversations are YAML files:

```yaml
id: 2025-06-15-1750012200-bike-kickstand
created: 2025-06-15T11:30:00Z
model: anthropic/claude-opus-4-6
title: Kickstand won't stay tight

messages:
  - role: user
    timestamp: 2025-06-15T11:30:00Z
    content: |
      I bolted a new kickstand to my bike but it keeps
      loosening after a few rides. Any ideas?

  - role: assistant
    timestamp: 2025-06-15T11:30:09Z
    content: |
      The bolt is probably vibrating loose. Clean the threads,
      apply a drop of Loctite Blue (medium strength), and
      re-tighten. It'll stay put but you can still remove it
      with a wrench later if you need to.
```

## Skills & Tools

Skills are markdown files that teach the AI new behaviors and give it access to tools. Create a folder in `$VAULT/skills/` with a `SKILL.md`:

```markdown
---
name: memory
description: Remember things about the user across conversations
---

# Memory Skill

When you learn something important about the user, save it to `memory.md`
using `append_to_note`. Before answering, check `memory.md` for context.
```

### Built-in Tools

| Tool | Description |
|------|-------------|
| `read_file` | Read files from your vault |
| `write_file` | Create or update files |
| `append_to_note` | Append to notes with provenance tracking |
| `list_directory` | List files in vault directories |
| `search_directory` | Search files and content |
| `http_get` | Fetch data from URLs |
| `http_post` | Send POST requests |
| `get_secret` | Access API keys from config |
| `web_search` | Search the web (Serper or SearXNG) |
| `use_skill` | Load another skill on-demand |
| `spawn_subagent` | Run 1-3 parallel sub-agents |

### Web Search Setup

The `web_search` tool requires one of:

- **[SearXNG](https://docs.searxng.org/)** (free, self-hosted) — Run a local instance via Docker with JSON format enabled. Set `searxng_url` in your vault's `config.yaml`.
- **[Serper](https://serper.dev/)** (paid API) — Sign up for a key and add it as `serper_api_key` in your vault's `config.yaml`.

## Supported Providers

- **Anthropic** (Claude)
- **OpenAI** (GPT, o-series)
- **Google Gemini**
- **xAI** (Grok)
- **Ollama** (local models)

## Development

```bash
npm run tauri dev       # Desktop app (requires Rust)
npm run dev:web         # Web-only mode (no Rust needed)
npm run test:run        # Run tests
npm run tauri build     # Production build
```

See [DEV.md](DEV.md) for architecture details.

### Tech Stack

- **Tauri 2** (Rust backend, React frontend)
- **React 19** + TypeScript + Vite
- **Storage:** YAML/Markdown in user-chosen directory

### Requirements

- Node.js v18+
- Rust (latest stable) — `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`
- At least one API key, or Ollama running locally

## Contributing

Issues and PRs welcome.

## License

[MIT](LICENSE)