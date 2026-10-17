# Alloy

A local-first, multi-model AI chat app. Use OpenAI-compatible APIs, local models through an oMLX endpoint, or your Claude/Codex subscription. All conversations are stored as plain-text files in a folder you choose.

[Blog post](https://smus.com/alloy-local-first-ai-workbench/) · [Download for macOS](https://github.com/borismus/alloy/releases)

![Alloy screenshot](/docs/screenshot.png)

## Quick Start

Download the latest release from the [releases page](https://github.com/borismus/alloy/releases), or build from source:

```bash
npm install
npm run tauri dev
```

On first launch, pick a vault folder and configure at least one API, local, or subscription provider. See [SETUP.md](SETUP.md) for detailed instructions including Rust installation.

## Vault Structure

Everything lives in your vault folder as plain files:

```
~/alloy-vault/
├── config.yaml              # API keys and settings
├── memory.md                # Persistent context injected into system prompt
├── conversations/           # Chat history (YAML)
│   └── attachments/         # Image and PDF attachments
├── notes/                   # AI-managed notes (Markdown)
├── tasks/                   # Scheduled tasks (YAML; optional delivery conditions)
├── skills/                  # Custom skills (Markdown)
└── logs/errors/             # Failed turns and tool calls, one file per machine
```

PDFs are sent to the model as-is, for providers that accept them; Alloy never
extracts their text.

Conversations are YAML files:

```yaml
id: 2025-06-15-1750012200-bike-kickstand
created: 2025-06-15T11:30:00Z
model: openrouter/anthropic/claude-opus-4.6
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
name: reading-list
description: Keep a running list of books the user mentions wanting to read
---

# Reading List Skill

When the user mentions a book they want to read, add it to
`notes/reading-list.md` using `append_to_note`, with the author and one line
on why it came up.
```

Invoke a skill explicitly with `/skill-name`; that is the deterministic path.
Models may also discover and call `use_skill` autonomously, but that selection is
best-effort.

### Built-in Tools

| Tool | Description |
|------|-------------|
| `read_file` | Read files from your vault |
| `write_file` | Create or update notes; changes to `memory.md` are proposed for your approval |
| `append_to_note` | Append to notes with provenance tracking |
| `list_directory` | List files in vault directories |
| `search_directory` | Search files and content |
| `web_fetch` | Extract readable Markdown or text from URLs |
| `web_search` | Search the web through Serper |
| `use_skill` | Load another skill on-demand |
| `spawn_subagent` | Run 1-3 parallel sub-agents |

### Web Search Setup

The `web_search` tool uses [Serper](https://serper.dev/). Add its API key as
`serperApiKey` in your vault's `config.yaml`; see [SEARCH.md](SEARCH.md). Codex
and Claude subscription models may additionally use their own native web tools.

### Scheduled Task Runner

When multiple Alloy servers use synchronized copies of the same vault, assign
one machine to automatic cron execution in **Settings → Scheduled tasks**. Alloy
stores that hostname as `scheduledTaskRunner` in the shared `config.yaml`; other
machines stand down while retaining **Run now**. Task-only DNS/connect failures
retry twice before becoming visible errors, without changing providers or
falling back from local to cloud.

Unattended runs favour completeness over latency, so they get their own limits —
more tool rounds, web searches, sub-agents, and reply tokens than an interactive
chat. Cron and **Run now** resolve identical limits. Tune them globally with
`taskExecution` in `config.yaml`, or per task with an `execution:` block; both
are clamped, so a generous value can never become an unbounded one.

## Memory

`memory.md` is included in every conversation, so Alloy guards it. You can edit
it directly at any time. A model can't change it on its own: when it wants to,
the conversation shows the proposed change, and nothing is written until you
accept it. Accepted changes keep a backup of the previous version (see
[TROUBLESHOOTING.md](TROUBLESHOOTING.md#restoring-memorymd-after-a-bad-write)).
Scheduled tasks and sub-agents can't propose memory changes.

## Privacy and local models

A provider is **local** only when its config says `local: true` and its address
is on your machine or private network. That decision comes from config alone:
an oMLX host that's asleep or unreachable still counts as local, and its
conversations and tasks keep their **Local** tag. Everything else, including
the Claude and Codex subscriptions, is treated as cloud.

Folders outside the vault can be made readable to models with
`privateReadOnlyDirs`:

```yaml
privateReadOnlyDirs:
  - alias: journal
    path: /Users/you/Documents/Journal   # absolute path
    description: My personal journal
    # audience: local          # default: local models only (`private/journal/`)
  - alias: recipes
    path: /Users/you/Documents/Recipes
    audience: all              # cloud models may read it too (`shared/recipes/`)
    excludeDirs: [drafts]      # skipped when listing and searching
```

Mounts can't point inside the vault, and a path that isn't absolute or doesn't
exist is skipped with a warning in the log. Privacy then follows the data:

- **A conversation that reads local-only material is marked private** and stays
  that way. Cloud models can't read it from the vault, and switching it to a
  cloud model asks first.
- **A note written after reading private material is marked private**
  (`private: true` in its frontmatter), so a summary can't become a
  cloud-readable copy. Cloud models can't read private notes.
- **Codex's own shell and browser tools are disabled**, so it only sees the
  vault through Alloy's tools and their privacy checks.

## Using Alloy on your phone

Alloy can run on an always-on Mac and serve the full app to your phone's
browser. Turn on **Settings → Share on network** on that Mac; it then serves
the app on `sharePort` (3001 by default). On iOS, open it in Safari and use
**Add to Home Screen** for a full-screen app.

Alloy has no login of its own. It only accepts connections from the Mac itself
and from Tailscale addresses (`100.x`). To reach it from your phone, use
[Tailscale](https://tailscale.com/), or run a tunnel on the same Mac with its
own authentication in front, such as Cloudflare Tunnel with Cloudflare Access.

Model calls, tools, and the subscription CLIs all run on that Mac, so set up
providers there. Voice input needs a `sonioxApiKey`.

## Supported Providers

All models are configured under a single `providers:` list in config v2
(`version: 2`). Local trust is explicit: only `local: true` grants the Local
badge and private-directory access; omission is treated as cloud.

`defaultModel` is the authoritative model for new conversations and
other default-seeded work. The picker keeps it fixed at the top with a distinct
default marker and divider; its star cannot be changed there. Every other model
has an independent favorite toggle plus a **Set default** action on hover (always
visible on touch devices). You can also edit `config.yaml` directly. If the
configured default is unset or unavailable after discovery, Alloy falls back
deterministically to the first reachable favorite in config order, then the
first model in the live catalog.

- **OpenRouter** — one key for Claude, GPT, Gemini, Grok, Llama, and more (the cloud gateway)
- **oMLX** — local, on-device models through an OpenAI-compatible endpoint (mark `local: true`; prompts stay on your machine/LAN)
- **Claude subscription** — use your Claude Pro/Max plan instead of API credits (see below)
- **Codex subscription** — use your ChatGPT/Codex plan instead of API credits (see below)

### Claude subscription mode

Pick the models currently advertised by Claude Code, billed against your
**Claude Pro/Max subscription** rather than per-token API credits. Alloy reads
the same account- and policy-filtered model catalog as Claude Code's `/model`
picker through its structured control protocol. This includes resolved model
names and context variants such as 1M. It works by shelling out to the Claude
Code CLI (there is no subscription-billed HTTP API).

Enable it by adding a Claude CLI adapter to your vault's `config.yaml`:

```yaml
providers:
  - id: claude-cli
    kind: cli
    adapter: claude
    # command: /opt/homebrew/bin/claude   # only if auto-discovery fails
    # oauthToken: sk-ant-oat-...           # from `claude setup-token` (optional)
```

Requires the [`claude` CLI](https://claude.com/claude-code) installed and logged
in to your subscription (run `claude` once to log in). These models pick up
Alloy's built-in tools — web search, reading/writing vault files, notes, skills —
just like every other provider.

On an always-on Mac, an interactive login can expire while nobody is there to
renew it. Instead, run `claude setup-token` on that machine and put the
long-lived token in the provider's `oauthToken`. Each machine can use its own
token, so you can revoke one without affecting the others. When a login does
expire, the turn fails with a message explaining how to fix it.

### Codex subscription mode

Use Codex billed against your **ChatGPT/Codex subscription** rather than
per-token API credits. It works by shelling out to the OpenAI Codex CLI.

Enable it by adding a Codex CLI adapter to your vault's `config.yaml`:

```yaml
providers:
  - id: codex-cli
    kind: cli
    adapter: codex
    # command: /opt/homebrew/bin/codex   # only if auto-discovery fails
```

Requires the [`codex` CLI](https://github.com/openai/codex) installed and logged
in to your subscription (run `codex login`). Alloy reads the authenticated Codex
model catalog and shows each exact model available to the account. A separate
**Codex (default: _model_)** option shows and keeps Codex's current
account/config-selected default. Interactive turns use Codex's app-server
protocol for token streaming, stop-button cancellation, image attachments, and
Alloy's built-in tools over the same scoped MCP bridge used by Claude. Codex
runs from a temporary working directory and sends prompts and images to OpenAI,
so it is treated as cloud and never receives trusted-local/private-directory
access.

## Development

```bash
npm run tauri dev       # Desktop app (requires Rust)
npm run dev             # Web mode: frontend (:1420) + auto-rebuilding backend (:3030); vault from .env
npm run test:run        # Unit tests
npm run test:smoke      # Seeded backend/browser smoke tests
npm run verify          # Typecheck, lint, unit/Rust tests, web build, smoke suite
npm run tauri build     # Production desktop build
```

See [DEV.md](DEV.md) for architecture details.

### Tech Stack

- **Tauri 2** (Rust backend, React frontend)
- **React 19** + TypeScript + Vite
- **Storage:** YAML/Markdown in user-chosen directory

### Requirements

- Node.js `^20.19.0` or `>=22.12.0`
- Rust (latest stable) — `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`
- An API provider, a local OpenAI-compatible server, or a logged-in Claude/Codex CLI

## Contributing

Issues and PRs welcome.

## License

[MIT](LICENSE)