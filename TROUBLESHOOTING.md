# Alloy Troubleshooting Guide

## Development setup

### `cargo: command not found`

Load Rust into the current shell and verify it:

```bash
source "$HOME/.cargo/env"
cargo --version
```

`./run.sh` performs this check before running `npm run tauri dev`.

### First build is slow

The first Rust build compiles the full dependency graph and can take several
minutes. Later builds are incremental. If a build is genuinely stuck, stop all
Alloy/cargo processes before deleting build output; concurrent builds can hold
the same Cargo lock.

### Supported Node version

Vite requires Node `^20.19.0` or `>=22.12.0`. CI and release workflows use Node
24. Check with `node --version`.

## Startup and configuration

### Config v2 errors

`config.yaml` is deliberately strict. It must start with `version: 2` and use:

```yaml
providers:
  - id: openrouter
    kind: openai_compatible
    baseUrl: https://openrouter.ai/api/v1
    apiKey: sk-or-v1-...

  - id: codex-cli
    kind: cli
    adapter: codex
```

Old `cli_claude`/`cli_codex` kinds, version 1, legacy flat API-key fields, and
snake_case settings are rejected rather than silently migrated. See
[README.md](README.md#supported-providers).

### Claude or Codex subscription provider fails

The CLI runs on the machine hosting `alloy-server`, which may be a remote Mac in
browser mode rather than the device displaying the page.

```bash
claude --version
claude                 # complete Claude login
codex --version
codex login
```

If Alloy cannot discover the binary, set the provider's `command` to its
absolute path. Interactive Codex turns require a current CLI with app-server
support. Restart Alloy after changing CLI installation or `config.yaml`.

### Port already in use

The desktop server uses a random loopback port. Network sharing uses the fixed
`sharePort` (3001 by default), and standalone `alloy-serve` also defaults to
3001. A second process cannot adopt or silently replace the listener.

Quit the other Alloy instance—not just its window—or choose another standalone
port. Development mode deliberately uses backend port 3030 by default; override
it with `ALLOY_DEV_PORT`.

### Vault permission denied on macOS

Choose a writable vault directory. macOS may deny a development build access to
`~/Documents` even when a released build worked previously. Grant the terminal
or development Alloy binary access under **System Settings → Privacy & Security**,
or use a vault under your home directory while developing.

Alloy preserves the selected vault when startup fails. Fix the permission/config
problem and use Retry rather than reselecting or recreating it.

## Providers and tools

### API request fails

Check the provider entry in `[vault]/config.yaml`, its upstream URL, account
credits, and backend logs. HTTP provider keys are sent only to their configured
upstream. Claude/Codex adapters use their CLI login and still send prompts to
the respective cloud service.

### Built-in web search says the key is missing

Add a top-level Serper key and restart Alloy:

```yaml
serperApiKey: your-serper-key
```

See [SEARCH.md](SEARCH.md). Native Claude/Codex searches do not use this key.

### A skill is ignored

Invoke it explicitly as `/skill-name` for deterministic behavior. Autonomous
selection through `use_skill` is best-effort and depends on the model.

## Vault behavior

### Conversations are not saving

Verify that the selected vault exists and is writable:

```bash
ls -la /path/to/vault
ls -la /path/to/vault/conversations
```

Model calls and persistence run in `alloy-server`; inspect its logs rather than
looking only at the browser console.

### Search misses known content

Sidebar body search is server-side and case-insensitive across conversations,
notes, and riffs. Test the backend directly:

```bash
curl --get 'http://localhost:3030/api/search' --data-urlencode 'q=known phrase'
```

Use the actual standalone port when it differs. Files larger than 512 KiB are
read only up to that per-file cap. Search does not require opening a conversation
first.

### Changes made while mobile was backgrounded do not appear

Alloy resynchronizes after watcher reconnect and when the page returns to the
foreground. If it remains stale, verify `/api/watch` can connect and inspect the
backend logs; a manual reload is a workaround, not expected normal behavior.

### Memory changes are not reflected

Check that `[vault]/memory.md` exists and contains the intended text. The vault
watcher reloads it after external edits; if the watcher is disconnected, focus
the app to trigger a resync.

## UI and build problems

### Blank or white window

Run the desktop app from a terminal and inspect both the Rust logs and webview
console:

```bash
ALLOY_LOG=debug npm run tauri dev
```

For web mode, use `npm run dev` and open <http://localhost:1420>.

If dependencies or generated output are corrupt:

```bash
rm -rf node_modules dist dist-web .vite
npm install
npm run verify
```

Avoid deleting Cargo targets unless necessary; rebuilding them is expensive.

### Frontend changes do not reload

Vite hot-reloads TypeScript/CSS. Rust backend changes trigger an automatic
rebuild under the development scripts, but an already-running release binary
must be restarted. Config and CLI capability changes also require a restart.

## Diagnostics and support

Desktop development logs appear in the terminal running `npm run tauri dev`.
For more detail:

```bash
ALLOY_LOG=debug RUST_BACKTRACE=1 npm run tauri dev
```

Before filing an issue, include:

```bash
node --version
cargo --version
claude --version  # when relevant
codex --version   # when relevant
```

Do not include API keys, OAuth tokens, private vault content, or MCP session
URLs. File issues at <https://github.com/borismus/alloy/issues>.
