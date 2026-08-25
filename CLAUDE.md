# Claude Code Project Instructions

## Project Overview

**Alloy** is a multi-model AI chat application built with Tauri 2 + React.

Key features:
- **Multi-provider**: OpenAI-compatible services including OpenRouter and oMLX, plus Claude and Codex subscription access
- **Comparison/Council studies (planned)**: Previously shipped multi-model modes,
  intended to return as durable one-shot workspace extensions (parallel responses;
  Council adds chairman synthesis)
- **Scheduled tasks**: Cron-based background prompts with optional delivery conditions
- **Skills**: Markdown-defined capabilities with tool access
- **Riff mode**: Draft-based note integration
- **Vault storage**: All data as YAML/Markdown in user-chosen folder

## Project Context

- This is a TypeScript Tauri app. The primary codebase is TypeScript. When debugging platform-specific issues (dictation, WKWebView, native behaviors), recognize early when the issue is at the system/platform level rather than app level, and communicate that clearly instead of cycling through incorrect hypotheses.
- **Dual runtime modes**: The app runs in both **Tauri mode** (native desktop) and **server mode** (web browser). Both modes must be maintained and tested. Model calls and tool execution run in the Rust `alloy-server` backend — embedded in the Tauri shell on a random loopback port, or run standalone (dev port 3030 via `npm run dev`; the binary itself defaults to 3001) for web mode. All builds route Tauri plugin imports to HTTP shims under `src/services/api/` (see `vite.config.ts` aliases); each shim detects the Tauri runtime and forwards to the real native plugin, otherwise degrades to a browser/`/api` fallback. When adding features that make HTTP requests or use Tauri APIs, ensure they work in both modes.

## General Principles

- **Minimal scope**: When asked to implement a feature or fix, start with the MINIMAL scope. Do not add extra UI elements, system prompt overrides, polling mechanisms, or utility functions beyond what was explicitly requested. If you think something additional is needed, ask first.
- **Reuse existing code**: When reusing existing patterns in the codebase, always check for and reuse existing hooks, utilities, and components rather than duplicating code. Search for similar implementations before creating new ones.

## Architecture

```
src/
├── App.tsx                 # Main app - state management, routing
├── components/             # React components
│   ├── ChatInterface.tsx   # Standard chat
│   ├── RiffView.tsx        # Draft note editing
│   ├── Sidebar.tsx         # Timeline + navigation
├── services/
│   ├── vault.ts            # File I/O, conversation/note CRUD
│   ├── riff.ts             # Draft integration logic
│   ├── server-streaming.ts # HTTP/SSE client for model turns
│   ├── skills/             # Skill loading and registry
│   └── api/                # HTTP shims for Tauri plugins (web + Tauri)
├── utils/                  # Shared utilities (IDs, frontmatter, wiki links, etc.)
├── contexts/               # React contexts
├── hooks/                  # Custom hooks
└── types/                  # TypeScript types

alloy-server/               # Rust (axum) backend: model calls + tool execution
```

## Key Files

- [src/App.tsx](src/App.tsx) - Main app component, all top-level state
- [src/services/vault.ts](src/services/vault.ts) - File operations, conversation/note persistence
- [alloy-server/src/providers/mod.rs](alloy-server/src/providers/mod.rs) - Provider trait, registry, and stream types
- [src/types/index.ts](src/types/index.ts) - Core type definitions
- [src/services/riff.ts](src/services/riff.ts) - Draft/riff processing

## Common Commands

```bash
npm run tauri dev       # Run desktop app in dev mode
npm run dev             # Web mode: Vite frontend (:1420) + auto-rebuilding backend (:3030); vault from .env
npm run test            # Run unit tests (watch mode)
npm run test:run        # Run unit tests once
npm run test:e2e        # Run Playwright e2e tests
npm run test:smoke      # Run seeded desktop/mobile browser smoke tests
npm run verify          # Full frontend/Rust/build verification gate
npm run build           # Build the production web bundle
```

## Testing

- Unit tests: `*.test.ts` files alongside source
- E2E tests: `tests/e2e/`
- Run specific test: `npm test -- path/to/file.test.ts`

## Patterns & Conventions

### State Management
- All major state lives in App.tsx (conversations, notes, tasks, selection)
- React contexts for cross-cutting concerns (streaming, tasks, approvals)
- Derived state pattern: `currentConversation` derived from `selectedItem` + `conversations`

### File Operations
- Use `vaultService` for all vault file operations
- Mark self-writes with `markSelfWrite()` to avoid watcher loops
- Atomic updates via `vaultService.updateConversation()` / `updateTask()`

### Provider Pattern
- Providers implement the Rust trait in `alloy-server/src/providers/mod.rs`
- The Rust registry manages routing, model discovery, model calls, and tools
- Models use `provider/model` format (e.g., `openrouter/anthropic/claude-sonnet-4.6`)

### Component Structure
- Components receive data + callbacks as props
- Avoid internal state when parent can manage it
- Use refs for imperative actions (focus, scroll)
- Reuse Alloy-owned React Aria wrappers under `src/components/ui/`
- Use semantic tokens from `src/styles/tokens.css`; shared primitives use CSS Modules

## Vault Structure

```
vault-folder/
├── config.yaml           # API keys, settings
├── memory.md             # Persistent AI memory
├── conversations/        # Chat history (YAML)
├── notes/                # User notes (Markdown)
├── tasks/                # Scheduled tasks (YAML)
├── skills/               # Custom skills (Markdown)
└── riffs/                # Draft notes (Markdown)
```

## Git Workflow

- When the user asks to commit changes, organize them into logical chunks by feature/concern. Don't ask for permission on obvious groupings — just create coherent commits.

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