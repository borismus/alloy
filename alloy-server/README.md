# alloy-server

Rust backend for [Alloy](https://github.com/borismus/alloy). Implements the
HTTP+SSE+WebSocket surface the SPA needs in server mode, with model calls and
tool execution running server-side.

Phase 1 ships this as a standalone CLI; Phase 2 will embed it in the Tauri
desktop shell.

## Why this exists

In server mode the SPA delegates everything model-related to a backend over
HTTP+SSE. The original Node server (`server/`) supports streaming but never
implemented tool execution, so `web_search`, `read_file`, `http_get` etc.
all silently no-op on mobile. This Rust port adds full tool support and
becomes the long-term server.

The two backends coexist during the transition — neither modifies the
other's files. Point the SPA at whichever is running via `VITE_API_URL`.

## Build & run

Requires Rust 1.90+ and a vault directory with a `config.yaml`.

```bash
cd alloy-server
cargo run --release -- --vault ~/Documents/Alloy --port 3001
```

Then point the SPA at it:

```bash
VITE_API_URL=http://localhost:3001 npm run dev:web
# open http://localhost:1420
```

For mobile (over Tailscale), once `npm run build:web` is added to bundle
static assets here, the same binary will also serve the SPA on a single
origin. (Not yet — for now use Vite dev server.)

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
```

Old per-provider keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc.) are
ignored with a warning at startup — V_next routes everything through
OpenRouter (or any other configured OpenAI-compat provider).

## Layout

```
src/
├── main.rs              CLI entry (clap), spawns axum
├── lib.rs               build_router, AppState
├── cli.rs               Args parser
├── config.rs            config.yaml loader + provider derivation
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
    └── watch.rs         /api/watch WebSocket file events
tools/
    ├── mod.rs           Dispatch
    ├── websearch.rs     Serper client
    ├── http.rs          http_get / http_post
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
| `http_get` / `http_post` | ✓ | 30s timeout, 2MB body cap |
| `read_file` | ✓ | notes/, skills/, conversations/, triggers/, root files |
| `list_directory` | ✓ | Same allowlist |
| `write_file` | ✓ | Only `notes/*` and `memory.md` in server mode (other paths require approval; hard-error here) |
| `append_to_note` | ✓ | Notes only. Auto-adds `&[[conv^msg]]` provenance markers |
| `search_directory` | ✓ | notes/, skills/, conversations/. Substring search, depth 3, 500 file cap |
| `use_skill` | ✓ | Loaded once from `vault/skills/*/SKILL.md` at startup |
| `spawn_subagent` | ✓ | 1-3 in parallel. No nesting. Sub-agents get read-only tool set |

`get_secret` is intentionally not implemented — it existed only to bridge
secrets into `http_post`, and the one secret in practice (`SERPER_API_KEY`)
is now handled inside `web_search` directly.

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

## Out of scope (Phase 2+)

- Embed in Tauri shell as in-process server, drop sidecar lifecycle
- Real auth (QR pairing, token UX)
- Per-skill markdown frontmatter validation
- Approval flow over SSE for writes outside the safe-path allowlist
- Background trigger execution (cron-like scheduler)
