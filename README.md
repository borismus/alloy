# Alloy

A local-first, multi-model AI chat app. Bring your own API keys, talk to Claude, GPT, Gemini, Grok, or local models through an oMLX OpenAI-compatible endpoint. All conversations are stored as plain text files in a folder you choose.

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
├── tasks/                   # Scheduled tasks (YAML; optional delivery conditions)
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
| `web_search` | Search the web (Serper or SearXNG) |
| `use_skill` | Load another skill on-demand |
| `spawn_subagent` | Run 1-3 parallel sub-agents |

### Web Search Setup

The `web_search` tool requires one of:

- **[SearXNG](https://docs.searxng.org/)** (free, self-hosted) — Run a local instance via Docker with JSON format enabled. Set `SEARXNG_URL` in your vault's `config.yaml` (see [SEARCH.md](SEARCH.md)).
- **[Serper](https://serper.dev/)** (paid API) — Sign up for a key and add it as `serperApiKey` in your vault's `config.yaml`.

## Supported Providers

All models are configured under a single `providers:` list in `config.yaml`:

- **OpenRouter** — one key for Claude, GPT, Gemini, Grok, Llama, and more (the cloud gateway)
- **oMLX** — local, on-device models through an OpenAI-compatible endpoint (mark `local: true`; prompts stay on your machine/LAN)
- **Claude subscription** — use your Claude Pro/Max plan instead of API credits (see below)
- **Codex subscription** — use your ChatGPT/Codex plan instead of API credits (see below)

### Claude subscription mode

Pick Claude Opus/Sonnet/Haiku billed against your **Claude Pro/Max subscription**
rather than per-token API credits. It works by shelling out to the Claude Code
CLI (there is no subscription-billed HTTP API).

Enable it by adding a `cli_claude` provider to your vault's `config.yaml`:

```yaml
providers:
  - id: claude-cli
    kind: cli_claude
    # command: /opt/homebrew/bin/claude   # only if `claude` isn't on PATH
    # oauthToken: sk-ant-oat-...           # from `claude setup-token` (optional)
```

Requires the [`claude` CLI](https://claude.com/claude-code) installed and logged
in to your subscription (run `claude` once to log in). These models pick up
Alloy's built-in tools — web search, reading/writing vault files, notes, skills —
just like every other provider.

### Codex subscription mode

Use Codex billed against your **ChatGPT/Codex subscription** rather than
per-token API credits. It works by shelling out to the OpenAI Codex CLI
(`codex exec`).

Enable it by adding a `cli_codex` provider to your vault's `config.yaml`:

```yaml
providers:
  - id: codex-cli
    kind: cli_codex
    # command: /opt/homebrew/bin/codex   # only if `codex` isn't on PATH
```

Requires the [`codex` CLI](https://github.com/openai/codex) installed and logged
in to your subscription (run `codex login`). The picker shows a single **Codex**
model that uses whatever your plan serves by default — specific model names like
`gpt-5-codex` are rejected on ChatGPT accounts. Unlike Claude subscription mode,
Codex is **text-only** for now — it answers prompts but does not use Alloy's
built-in tools (web search, vault files, skills). Codex runs its own agent in a
read-only sandbox and sends prompts to OpenAI, so it is treated as cloud (no
access to private directories).

## Development

```bash
npm run tauri dev       # Desktop app (requires Rust)
npm run dev             # Web mode: frontend (:1420) + auto-rebuilding backend (:3030); vault from .env
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
- At least one API key, or an oMLX server running locally

## Contributing

Issues and PRs welcome.

## License

[MIT](LICENSE)