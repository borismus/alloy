# alloy-server

Rust backend for [Alloy](https://github.com/borismus/alloy). Implements the
HTTP+SSE+WebSocket surface the SPA needs, with model calls and tool execution
running server-side.

Used in two modes:
- **Standalone CLI** (`alloy-serve --vault ... --port ...`) — for headless
  deployments and the web-only `npm run dev` workflow.
- **Embedded in Tauri** (Phase 2, `src/embed.rs`) — the Tauri desktop shell
  spawns axum in-process via `tokio::spawn`. The SPA inside the webview talks
  to it over `/api/*` on a random loopback port. Optionally exposes a public
  listener on a configurable port so phones on the LAN/Tailnet can hit the
  same vault from a browser.

## Why this exists

In server mode the SPA delegates everything model-related to a backend over
HTTP+SSE. The original Node server (`server/`) supports streaming but never
implemented tool execution, so `web_search`, `read_file`, etc. silently
no-op on mobile. This Rust port adds full tool support and is the long-term
server for both desktop (embedded in Tauri) and mobile (LAN-shared).

The Node `server/` and the Tauri client-side TS providers/tools still exist
during the transition — Phase 3 deletes them.

## Build & run

Requires Rust 1.90+ and a vault directory with a `config.yaml`.

### Embedded in Tauri (default)

```bash
npm run tauri dev
```

Tauri spawns axum on a random loopback port; the SPA inside the webview
talks to it. To share with phones, open Settings → Network → "Share on
network" and visit the displayed URL from your phone.

### Standalone CLI

```bash
npm run dev   # frontend + auto-rebuilding backend (:3030); vault from ALLOY_VAULT in .env
# override per-run: ALLOY_VAULT=~/Documents/Alloy npm run dev
# Vite proxies /api to :3030 (see vite.config.ts; override port with ALLOY_DEV_PORT)
# open http://localhost:1420
```

### Embedded mode + bundled SPA (mobile self-hosted)

When `shareOnNetwork: true`, the embedded server also serves the SPA's
static assets from the same origin via `rust-embed`. Mobile devices load
the full app from `http://<your-host>:<sharePort>/`.

## Configuration

`config.yaml` lives at the vault root and supports the V_next provider
schema with backward-compat for the existing flat keys:

```yaml
defaultModel: openrouter/anthropic/claude-sonnet-4.6

# Preferred (V_next): explicit providers block
providers:
  - id: openrouter
    kind: openai_compatible
    base_url: https://openrouter.ai/api/v1
    api_key: ${OPENROUTER_API_KEY}
  - id: ollama
    kind: openai_compatible
    base_url: http://localhost:11434/v1
    api_key: ollama

# Or just the legacy flat keys — providers are auto-derived
OPENROUTER_API_KEY: sk-or-v1-...
OLLAMA_BASE_URL: http://localhost:11434

# For tools
SERPER_API_KEY: ...     # web_search

# Phase 2: expose the embedded server to other devices on the network.
shareOnNetwork: false   # default off
sharePort: 3001         # only used when shareOnNetwork is true
```

Old per-provider keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc.) are
ignored with a warning at startup — V_next routes everything through
OpenRouter (or any other configured OpenAI-compat provider).

## Layout

```
src/
├── main.rs              CLI entry (clap), spawns axum (standalone mode)
├── lib.rs               build_router, AppState
├── embed.rs             Phase 2: bootstrap_for_tauri, set_vault, set_share
├── cli.rs               Args parser
├── config.rs            config.yaml loader + share write helper
├── auth.rs              IP allowlist middleware (loopback + Tailscale)
├── error.rs             AppError → JSON 4xx/5xx
├── vault.rs             Path resolver with traversal safety
├── vault_writer.rs      Conversation YAML append + title rename
├── skill_registry.rs    Loads vault/skills/*/SKILL.md frontmatter
├── tool_loop.rs         execute_with_tools — multi-turn tool dispatch
├── streaming.rs         Session manager with broadcast SSE fan-out
├── types.rs             Tool definitions, BUILTIN_TOOLS, OpenAI shapes
├── providers/
│   ├── mod.rs           Provider trait + ProviderRegistry + ChatMessage
│   └── openai_compatible.rs
└── routes/
    ├── fs.rs            /api/fs/* (matches tauri-fs-http.ts surface)
    ├── path.rs          /api/path/join
    ├── stream.rs        /api/stream/* SSE
    ├── models.rs        /api/models (live OpenRouter + Ollama)
    ├── watch.rs         /api/watch WebSocket file events
    └── static_files.rs  Embedded SPA assets via rust-embed (Phase 2)
tools/
    ├── mod.rs           Dispatch
    ├── websearch.rs     Serper client
    ├── http.rs          http_get
    ├── files.rs         read/write/list/append with safe-path allowlist
    ├── search.rs        search_directory (substring, no regex)
    ├── skills.rs        use_skill
    └── subagents.rs     spawn_subagent (parallel, no nesting)
```

## Endpoints

All routes mounted under `/api/*`. CORS allows all origins, matching the
Node server's behavior.

| Method | Path | Notes |
|---|---|---|
| POST | `/api/fs/{readTextFile,writeTextFile,readFile,writeFile,readDir,readDirHeaders,mkdir,remove,exists,stat}` | Vault file ops |
| POST | `/api/path/join` | Path joiner |
| WS | `/api/watch` | Vault file change events |
| POST | `/api/stream/start` | Start an SSE session |
| GET | `/api/stream/events/:id` | SSE event stream |
| POST | `/api/stream/stop/:id` | Cancel a session |
| GET | `/api/stream/active` | List sessions (for reconnect) |
| GET | `/api/models` | Aggregated model list across providers |

## Tools

| Tool | Status | Notes |
|---|---|---|
| `web_search` | ✓ | Serper. Reads `SERPER_API_KEY` from config |
| `http_get` | ✓ | 30s timeout, 2MB body cap |
| `read_file` | ✓ | notes/, skills/, conversations/, triggers/, root files |
| `list_directory` | ✓ | Same allowlist |
| `write_file` | ✓ | Only `notes/*` and `memory.md` in server mode (other paths require approval; hard-error here) |
| `append_to_note` | ✓ | Notes only. Auto-adds `&[[conv^msg]]` provenance markers |
| `search_directory` | ✓ | notes/, skills/, conversations/. Substring search, depth 3, 500 file cap |
| `use_skill` | ✓ | Loaded once from `vault/skills/*/SKILL.md` at startup |
| `spawn_subagent` | ✓ | 1-3 in parallel. No nesting. Sub-agents get read-only tool set |

## Provider model resolution

The SPA sends `model: "<provider>/<upstream-id>"` (e.g.
`openrouter/anthropic/claude-sonnet-4.6`). Resolution:

1. If the first segment matches a configured provider id, use it and pass
   the remainder as the upstream model id.
2. Otherwise route to the first configured provider with the full string
   verbatim. This preserves backward compat for old configs that store
   unprefixed model ids like `anthropic/claude-sonnet-4-6`.

## Cost calculation

USD cost is computed per response from cached OpenRouter pricing
(`pricing.prompt` / `pricing.completion` in `/api/v1/models`). The model
cache also drives `/api/models`. First request after server start may miss
cost if the cache isn't warm yet — the SPA warms it via `/api/models` on
load.

## Anthropic prompt caching

For models routed through Anthropic (id contains `anthropic/`), messages are
serialized as block arrays with `cache_control: { type: "ephemeral" }` on:

- the system prompt (cached for the conversation lifetime), and
- the second-to-last user message (cached on follow-up turns).

This matches the Tauri-side caching pattern in
`src/services/providers/anthropic.ts` and works through OpenRouter per
[their docs](https://openrouter.ai/docs/guides/best-practices/prompt-caching).

## Auth

Phase 1 ships no bearer-token UX. Loopback (127.0.0.1, ::1) and Tailscale
(100.x.x.x) IPs are auto-allowed. Public IPs are rejected with 403.

Phase 2 will add a real auth flow for remote deployments.

## Tests

```bash
cargo test
```

29 unit tests cover vault path safety, IP allowlist behavior, Serper
recency parsing, file permission checks, search snippet truncation, slug
generation, Anthropic model detection, `cache_control` placement, and the
OpenRouter "Vendor: " prefix stripping.

## Out of scope (Phase 3+)

- **Phase 3**: delete the Node `server/`, client-side TS providers/tools/mocks,
  Tauri JS plugins for FS/HTTP, and the `isServerMode()` branching.
- Real auth (QR pairing, bearer token UX) for remote-internet deployments.
- Approval flow over SSE for writes outside the safe-path allowlist.
- Background trigger execution (cron-like scheduler running when UI is closed).
