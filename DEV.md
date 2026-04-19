# Alloy Development Notes

## Quick Start

```bash
# Make sure Rust is in your PATH (after fresh install)
source $HOME/.cargo/env

# Install dependencies
npm install

# Run in dev mode
npm run tauri dev
```

## Project Structure

```
alloy/
├── src/                      # React frontend
│   ├── components/           # UI components
│   │   ├── ChatInterface.tsx # Main chat UI
│   │   ├── RiffView.tsx      # Draft note editing
│   │   ├── Sidebar.tsx       # Conversation list & search
│   │   └── Settings.tsx      # Settings panel
│   ├── services/             # Business logic
│   │   ├── vault.ts          # File system operations
│   │   ├── riff.ts           # Draft integration logic
│   │   ├── background.ts     # Background orchestrator
│   │   ├── providers/        # AI provider implementations
│   │   ├── skills/           # Skill loading and execution
│   │   ├── tools/            # Built-in tool implementations
│   │   ├── triggers/         # Trigger scheduling and execution
│   │   └── context/          # Context window estimation
│   ├── contexts/             # React contexts
│   ├── hooks/                # Custom hooks
│   ├── types/                # TypeScript types
│   ├── mocks/                # Tauri API mocks for web mode
│   └── App.tsx               # Main app component
│
├── src-tauri/                # Rust backend
│   ├── src/
│   │   └── lib.rs            # Tauri app setup
│   ├── Cargo.toml            # Rust dependencies
│   └── tauri.conf.json       # Tauri configuration
│
└── package.json              # Node dependencies

```

## Key Technologies

- **Frontend**: React 19 + TypeScript + Vite
- **Backend**: Tauri 2 (Rust)
- **AI**: Anthropic, OpenAI, Google Gemini, xAI (Grok), Ollama
- **Storage**: YAML/Markdown files (js-yaml)
- **Styling**: Plain CSS

## Development Flow

1. **Frontend changes**: Hot-reloaded automatically by Vite
2. **Rust changes**: Requires rebuild (Tauri watches and rebuilds)
3. **Config changes**: May require restart

## Dual Runtime Modes

The app runs in two modes:

- **Tauri mode** (`npm run tauri dev`): Native desktop app. Uses `@tauri-apps/plugin-http` for external requests.
- **Server mode** (`npm run dev:web`): Web browser mode, no Rust required. Tauri plugins are swapped for HTTP-based mocks via Vite aliases.

When adding features that use Tauri APIs or make HTTP requests, ensure they work in both modes.

## API Integration

The app supports multiple AI providers. API keys are:
- Stored in `config.yaml` in the user's vault
- Never sent to any server except the respective provider
- Loaded at startup if vault exists

## File Formats

### Conversation (YAML)
```yaml
id: 2025-06-15-1750012200-bike-kickstand
created: 2025-06-15T11:30:00Z
model: anthropic/claude-opus-4-6
messages:
  - role: user
    timestamp: 2025-06-15T11:30:00Z
    content: Hello!
  - role: assistant
    timestamp: 2025-06-15T11:30:05Z
    content: Hi there!
```

### Config (YAML)
```yaml
defaultModel: anthropic/claude-sonnet-4-6
ANTHROPIC_API_KEY: sk-ant-...
OPENAI_API_KEY: sk-...
GEMINI_API_KEY: ...
XAI_API_KEY: xai-...
OLLAMA_BASE_URL: http://localhost:11434
# Optional
SERPER_API_KEY: ...
SONIOX_API_KEY: ...
```

### Memory (Markdown)
```markdown
# Memory

## About me
- Your context here

## Preferences
- Your preferences here
```

## Building for Production

```bash
npm run tauri build
```

Output locations (macOS):
- DMG: `src-tauri/target/release/bundle/dmg/`
- App: `src-tauri/target/release/bundle/macos/`

## Debugging

### Frontend Console
Open DevTools in the Tauri window (right-click → Inspect Element)

### Rust Logs
Check terminal where you ran `npm run tauri dev`

### File Operations
All vault operations can be inspected by looking at the files in your vault folder

## Tips

- **Fast iteration**: Keep `npm run tauri dev` running
- **Test persistence**: Check your vault folder to verify files
- **Web mode**: Use `npm run dev:web` for faster frontend iteration without Rust
- **Search**: Works across all message content in all conversations
- **Memory**: Edit `memory.md` to customize AI context

## Common Issues

**Build fails**: Make sure Rust is installed and in PATH
**API errors**: Check your API keys in `config.yaml` or the Settings panel
**Files not saving**: Verify vault folder permissions
**Search not working**: Check that conversations have loaded

---

Built with lateral thinking & withered technology
