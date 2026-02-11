# Wheelhouse Development Notes

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
wheelhouse/
├── src/                      # React frontend
│   ├── components/          # UI components
│   │   ├── VaultSetup.tsx   # First-run vault selection
│   │   ├── Sidebar.tsx      # Conversation list & search
│   │   └── ChatInterface.tsx # Main chat UI
│   ├── services/            # Business logic
│   │   ├── vault.ts         # File system operations
│   │   └── claude.ts        # Anthropic API client
│   ├── types/               # TypeScript types
│   └── App.tsx              # Main app component
│
├── src-tauri/               # Rust backend
│   ├── src/
│   │   └── lib.rs          # Tauri app setup
│   ├── Cargo.toml          # Rust dependencies
│   └── tauri.conf.json     # Tauri configuration
│
└── package.json             # Node dependencies

```

## Key Technologies

- **Frontend**: React 19 + TypeScript + Vite
- **Backend**: Tauri 2 (Rust)
- **AI**: Anthropic SDK (Claude)
- **Storage**: YAML files (js-yaml)
- **Styling**: Plain CSS

## Development Flow

1. **Frontend changes**: Hot-reloaded automatically by Vite
2. **Rust changes**: Requires rebuild (Tauri watches and rebuilds)
3. **Config changes**: May require restart

## API Integration

The app uses the Anthropic SDK in "dangerously allow browser" mode since we're in a Tauri webview (not a real browser). API keys are:
- Stored in `config.yaml` in the user's vault
- Never sent to any server except Anthropic
- Loaded at startup if vault exists

## File Formats

### Conversation (YAML)
```yaml
id: 2025-01-10-1234567890
created: 2025-01-10T12:00:00Z
model: claude-sonnet-4-20250514
messages:
  - role: user
    timestamp: 2025-01-10T12:00:00Z
    content: Hello!
  - role: assistant
    timestamp: 2025-01-10T12:00:05Z
    content: Hi there!
```

### Config (YAML)
```yaml
vaultPath: /Users/you/wheelhouse-vault
anthropicApiKey: sk-ant-...
defaultModel: claude-sonnet-4-20250514
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

## MVP 0.1 Checklist

- [x] Vault folder picker
- [x] Basic chat interface
- [x] Claude API integration
- [x] Streaming responses
- [x] YAML conversation persistence
- [x] Conversation list
- [x] Basic search
- [x] Memory.md injection

## Next Steps (v0.2)

- [ ] Multi-provider support
- [ ] Model comparison UI
- [ ] Better error handling
- [ ] Settings panel
- [ ] Keyboard shortcuts
- [ ] Conversation export
- [ ] Delete conversations

## Tips

- **Fast iteration**: Keep `npm run tauri dev` running
- **Test persistence**: Check your vault folder to verify files
- **API key**: Get one from https://console.anthropic.com/
- **Search**: Works across all message content in all conversations
- **Memory**: Edit `memory.md` to customize AI context

## Common Issues

**Build fails**: Make sure Rust is installed and in PATH
**API errors**: Check your API key in `config.yaml`
**Files not saving**: Verify vault folder permissions
**Search not working**: Check that conversations have loaded

---

Built with lateral thinking & withered technology
