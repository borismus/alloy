# alloy-server

Rust backend for [Alloy](https://github.com/borismus/alloy). Implements the
HTTP+SSE+WebSocket surface the SPA needs, with model calls and tool execution
running server-side.

Used in two modes:
- **Standalone CLI** (`alloy-serve --vault ... --port ...`) — for headless
  deployments and the web-only `npm run dev` workflow.
- **Embedded in Tauri** (`src/embed.rs`) — the Tauri desktop shell spawns axum
  in-process via `tokio::spawn`. The SPA inside the webview talks to it over
  `/api/*` on a random loopback port. It can optionally expose a configurable
  listener so phones on the Tailnet can use the same vault from a browser.

## Why this exists

Both runtime modes use one backend for provider discovery, model calls, tools,
stream persistence, vault search, file watching, and scheduled tasks. Keeping
those mechanisms in Rust avoids desktop/browser behavior drift and keeps vault
bodies and provider credentials off the browser client.

## Build & run

Requires the latest stable Rust toolchain and a vault directory with a
`config.yaml`.

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

`config.yaml` lives at the vault root. All models are configured under a single
`providers:` list (camelCase v2 schema):

```yaml
version: 2
defaultModel: openrouter/anthropic/claude-sonnet-4.6

providers:
  - id: openrouter
    kind: openai_compatible
    baseUrl: https://openrouter.ai/api/v1
    apiKey: sk-or-v1-...
  - id: mlx                       # explicitly trusted local endpoint
    kind: openai_compatible
    baseUrl: http://localhost:8000/v1
    local: true
  - id: claude-cli
    kind: cli
    adapter: claude
  - id: codex-cli
    kind: cli
    adapter: codex

# For tools
serperApiKey: ...       # web_search

# Expose the embedded server to other devices on the network.
shareOnNetwork: false   # default off
sharePort: 3001         # only used when shareOnNetwork is true

# Exactly one host owns automatic cron execution for a synced vault.
scheduledTaskRunner: smusmini
```

There is no legacy flat-key format: 0.4 dropped the pre-0.4 schema (per-vendor
`*_API_KEY` keys, snake_case), and config v2 replaces the old `cli_claude` /
`cli_codex` kinds with `kind: cli` plus `adapter: claude | codex`. Obsolete
configs are rejected at startup with migration guidance. All cloud models are
reached via OpenRouter (or any configured OpenAI-compatible provider); on-device
models only via an explicitly trusted `local: true` OpenAI-compatible endpoint
(omission is cloud); subscription access via
CLI adapters (always cloud). Interactive Codex turns use app-server for token
streaming, interruption, image data URLs, and scoped Alloy tools over MCP; the
process runs from a temporary working directory.

When several Alloy servers open synchronized copies of the same vault, set
`scheduledTaskRunner` to the normalized hostname of the one server that should
execute cron schedules. Settings shows each server's hostname and can assign the
current one. A host-local per-vault lock also prevents production and development
Alloy processes on that machine from scheduling concurrently. **Run now** remains
available from every server. Task HTTP calls retry only pre-response DNS/connect
failures (three attempts total, after 15- and 60-second delays); they never replay
tools, switch models, or fall back from local to cloud.

## Layout

```
src/
├── main.rs              CLI entry (clap), spawns axum (standalone mode)
├── lib.rs               build_router, AppState
├── embed.rs             Tauri bootstrap, vault selection, network sharing
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
│   ├── mod.rs                 Provider trait + registry + stream types
│   ├── openai_compatible.rs   OpenAI-compatible HTTP providers
│   ├── cli_claude.rs          Claude subscription adapter
│   └── cli_codex.rs           Codex subscription/app-server adapter
├── routes/
│   ├── config.rs        Resolved config reads and comment-preserving edits
│   ├── fs.rs            /api/fs/* (matches tauri-fs-http.ts surface)
│   ├── mcp.rs           Scoped MCP bridge for subscription CLIs
│   ├── path.rs          /api/path/join
│   ├── search.rs        Server-side vault full-text search
│   ├── stream.rs        /api/stream/* SSE
│   ├── models.rs        /api/models (live configured-provider catalog)
│   ├── tasks.rs         Manual scheduled-task execution
│   ├── watch.rs         /api/watch WebSocket file events
│   └── static_files.rs  Embedded SPA assets via rust-embed
├── tasks/               Cron scheduler, task schema, and executor
└── tools/
    ├── mod.rs           Dispatch
    ├── websearch.rs     Serper client
    ├── http.rs          http_get
    ├── files.rs         read/write/list/append with safe-path allowlist
    ├── search.rs        search_directory
    ├── skills.rs        use_skill
    ├── subagents.rs     spawn_subagent (parallel, no nesting)
    └── tasks.rs         create/update scheduled tasks
```

## Endpoints

All routes are mounted under `/api/*`. CORS is deliberately permissive so the
Tauri WKWebView and browser-mode shims can use the same surface.

| Method | Path | Notes |
|---|---|---|
| POST | `/api/fs/{readTextFile,writeTextFile,readFile,writeFile,readDir,readDirHeaders,mkdir,remove,exists,stat}` | Vault file ops |
| POST | `/api/path/join` | Path joiner |
| WS | `/api/watch` | Vault file change events |
| POST | `/api/stream/start` | Start an SSE session |
| GET | `/api/stream/events/{id}` | SSE event stream |
| POST | `/api/stream/stop/{id}` | Cancel a session |
| GET | `/api/stream/active` | List sessions (for reconnect) |
| GET | `/api/models` | Aggregated live/cached model catalog |
| GET | `/api/config` | Resolved config with provider API keys omitted |
| PUT | `/api/config/{favorites,value,model-preferences}` | Comment-preserving config edits |
| GET | `/api/search?q=...` | Full-text vault search with snippets |
| POST | `/api/tasks/{id}/run` | Run a scheduled task now without shifting its cron schedule |
| POST | `/api/mcp` | Session-token-scoped MCP bridge for CLI adapters |

## Tools

| Tool | Status | Notes |
|---|---|---|
| `web_search` | ✓ | Serper; reads top-level `serperApiKey` from config |
| `http_get` | ✓ | 30s timeout, 2MB body cap |
| `read_file` | ✓ | notes/, skills/, conversations/, tasks/, root files |
| `list_directory` | ✓ | Same allowlist |
| `write_file` | ✓ | Only `notes/*` and `memory.md`; other paths are rejected |
| `append_to_note` | ✓ | Notes only; auto-adds `&[[conversation-id^message-id]]` provenance markers |
| `search_directory` | ✓ | Recency-sorted substring search across allowed vault paths |
| `use_skill` | ✓ | Loaded once from `vault/skills/*/SKILL.md` at startup |
| `spawn_subagent` | ✓ | 1-3 in parallel. No nesting. Sub-agents get read-only tool set |
| `create_scheduled_task` | ✓ | Five-field cron + timezone; optional delivery condition |

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

This works through OpenRouter per
[their docs](https://openrouter.ai/docs/guides/best-practices/prompt-caching).

## Network access

There is no public-internet bearer-token flow. Loopback is always accepted.
Direct access is limited to loopback and Tailscale (`100.*`) source addresses;
other LAN and public addresses are rejected. Tailscale-proxied requests are also
blocked when network sharing is disabled. `/api/mcp` additionally requires a
per-stream session token.

## Tests

```bash
cargo test
```

The Rust suite covers config parsing, provider protocols, streaming and replay,
vault path safety, file permissions, search, scheduled tasks, MCP authorization,
image handling, and tool persistence. Run the repository-wide gate with
`npm run verify` from the project root.

## Out of scope

- Public-internet exposure and its required pairing/bearer-token UX.
- Approval flow over SSE for writes outside the safe-path allowlist.
- Arbitrary third-party plugin execution. The proposed extension boundary is
  documented in [`docs/plugin-architecture.md`](../docs/plugin-architecture.md).
