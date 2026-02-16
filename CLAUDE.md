# Claude Code Project Instructions

## Project Overview

**Wheelhouse** is a multi-model AI chat application built with Tauri 2 + React.

Key features:
- **Multi-provider**: Anthropic (Claude), OpenAI, Google Gemini, Ollama
- **Council mode**: Query multiple models, chairman synthesizes responses
- **Comparison mode**: See responses side-by-side
- **Triggers**: Scheduled background prompts (monitors)
- **Skills**: Markdown-defined capabilities with tool access
- **Ramble mode**: Draft-based note integration
- **Vault storage**: All data as YAML/Markdown in user-chosen folder

## Architecture

```
src/
├── App.tsx                 # Main app - state management, routing
├── components/             # React components
│   ├── ChatInterface.tsx   # Standard chat
│   ├── RambleView.tsx      # Draft note editing
│   ├── Sidebar.tsx         # Timeline + navigation
├── services/
│   ├── vault.ts            # File I/O, conversation/note CRUD
│   ├── ramble.ts           # Draft integration logic
│   ├── providers/          # AI provider implementations
│   ├── skills/             # Skill loading and execution
│   └── tools/              # Built-in tool implementations
├── contexts/               # React contexts
├── hooks/                  # Custom hooks
├── types/                  # TypeScript types
└── mocks/                  # Tauri API mocks for web mode
```

## Key Files

- [src/App.tsx](src/App.tsx) - Main app component, all top-level state
- [src/services/vault.ts](src/services/vault.ts) - File operations, conversation/note persistence
- [src/services/providers/registry.ts](src/services/providers/registry.ts) - Provider management
- [src/types/index.ts](src/types/index.ts) - Core type definitions
- [src/services/ramble.ts](src/services/ramble.ts) - Draft/ramble processing

## Common Commands

```bash
npm run tauri dev       # Run desktop app in dev mode
npm run dev:web         # Run web-only mode (no Tauri)
npm run test            # Run unit tests (watch mode)
npm run test:run        # Run unit tests once
npm run test:e2e        # Run Playwright e2e tests
npm run build           # Build for production
```

## Testing

- Unit tests: `*.test.ts` files alongside source
- E2E tests: `tests/e2e/`
- Run specific test: `npm test -- path/to/file.test.ts`

## Patterns & Conventions

### State Management
- All major state lives in App.tsx (conversations, notes, triggers, selection)
- React contexts for cross-cutting concerns (streaming, triggers, approvals)
- Derived state pattern: `currentConversation` derived from `selectedItem` + `conversations`

### File Operations
- Use `vaultService` for all vault file operations
- Mark self-writes with `markSelfWrite()` to avoid watcher loops
- Atomic updates via `vaultService.updateConversation()` / `updateTrigger()`

### Provider Pattern
- All providers implement the interface in `services/providers/types.ts`
- Registry manages initialization and model discovery
- Models use `provider/model` format (e.g., `anthropic/claude-opus-4-5-20251101`)

### Component Structure
- Components receive data + callbacks as props
- Avoid internal state when parent can manage it
- Use refs for imperative actions (focus, scroll)

## Vault Structure

```
vault-folder/
├── config.yaml           # API keys, settings
├── memory.md             # Persistent AI memory
├── conversations/        # Chat history (YAML)
├── notes/                # User notes (Markdown)
├── triggers/             # Scheduled prompts (YAML)
├── skills/               # Custom skills (Markdown)
└── rambles/              # Draft notes (Markdown)
```

## Allowed Tools

This project allows Claude Code to use web search for research and documentation lookups.

allowedTools:
  - WebSearch
  - WebFetch
  - Bash(ls *)
  - Bash(grep *)
  - Bash(find *)
  - Bash(cat *)
  - Bash(head *)
  - Bash(tail *)
  - Bash(wc *)
  - Bash(file *)
  - Bash(pwd)
  - Bash(which *)
  - Bash(echo *)

## Releasing

To bump the version and create a release:

```bash
./scripts/bump-version.sh <version>        # e.g., ./scripts/bump-version.sh 0.1.22
./scripts/bump-version.sh <version> --push # also push to remote
```

This updates version in package.json, tauri.conf.json, Cargo.toml, syncs package-lock.json, and creates a git commit + tag.

## Model Documentation

Authoritative URLs for checking available models and updating model lists:

- **Anthropic (Claude)**: https://platform.claude.com/docs/en/about-claude/models/all-models
- **OpenAI**: https://platform.openai.com/docs/models
- **Google Gemini**: https://ai.google.dev/gemini-api/docs/models/gemini