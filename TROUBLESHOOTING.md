# Wheelhouse Troubleshooting Guide

## Common Issues and Solutions

### "cargo: command not found" or "Rust not found"

**Problem**: Rust isn't available in your shell's PATH.

**Solution**:

```bash
# Load Rust into your current shell
source $HOME/.cargo/env

# Verify it worked
cargo --version
```

**Permanent Fix**: Add this to your shell profile (`~/.zshrc` or `~/.bashrc`):
```bash
source $HOME/.cargo/env
```

Then restart your terminal or run `source ~/.zshrc` (or `~/.bashrc`).

**Easiest Fix**: Just use the launch script which handles this automatically:
```bash
./run.sh
```

---

### Build takes forever on first run

**Problem**: First Rust build compiles all dependencies.

**Expected**: 2-5 minutes for first build
**Subsequent builds**: 5-15 seconds

**This is normal!** Just wait it out once. Future runs will be much faster.

---

### "Error deserializing 'plugins.X'"

**Problem**: Tauri plugin configuration mismatch.

**Solution**: Make sure your [src-tauri/tauri.conf.json](src-tauri/tauri.conf.json) has empty plugins:
```json
"plugins": {}
```

And permissions are in the `security.capabilities` section.

---

### Can't select vault folder / Permission denied

**Problem**: File system permissions not granted.

**Solutions**:
1. Choose a folder you have write access to (e.g., `~/Documents/wheelhouse-vault`)
2. On macOS, grant Full Disk Access: System Settings → Privacy & Security → Full Disk Access
3. Try a different location like your home directory

---

### API Key errors / "Invalid API key"

**Problem**: Anthropic API key is missing or invalid.

**Solutions**:

1. **Get a valid key**:
   - Go to https://console.anthropic.com/
   - Sign in and navigate to API Keys
   - Generate a new key (starts with `sk-ant-`)

2. **Check your key format**:
   ```
   ✅ Correct: sk-ant-api03-xxxxxxxxxxxxxxxxxxxxx
   ❌ Wrong: api-key-123 (not a real Anthropic key)
   ```

3. **Update your key**:
   Edit `[your-vault]/config.yaml`:
   ```yaml
   anthropicApiKey: sk-ant-your-key-here
   ```

4. **Check your account has credits**:
   Visit https://console.anthropic.com/settings/billing

---

### Conversations not saving

**Problem**: Files aren't being written to vault.

**Diagnosis**:
```bash
# Check if vault was initialized
ls -la ~/your-vault-path/

# Should show:
# conversations/
# topics/
# memory.md
# config.yaml
```

**Solutions**:
1. Verify the vault folder exists and is writable
2. Check console for errors (right-click in app → Inspect Element → Console)
3. Try recreating the vault by selecting a new folder

---

### Search not working

**Problem**: Can't find conversations you know exist.

**Solutions**:
1. **Refresh the conversation list**: Close and reopen the app
2. **Check file format**: Conversations must be `.yaml` files in `conversations/`
3. **Case sensitive**: Search is case-insensitive, but make sure files are properly formatted YAML

---

### App window is blank / white screen

**Problem**: Frontend failed to load.

**Diagnosis**:
```bash
# Check the terminal output for errors
# Look for Vite or React errors
```

**Solutions**:
1. Stop the dev server (Ctrl+C)
2. Clear build cache:
   ```bash
   rm -rf dist
   rm -rf src-tauri/target
   ```
3. Reinstall dependencies:
   ```bash
   npm install
   ```
4. Try again:
   ```bash
   ./run.sh
   ```

---

### "dangerouslyAllowBrowser" warning

**Problem**: Console warning about Anthropic SDK in browser.

**This is expected!** We're using the Anthropic SDK in a Tauri webview (which is like a browser). Since we control the environment and API keys stay local, this is safe. The warning can be ignored.

---

### Memory not being included in conversations

**Problem**: Claude doesn't seem to know your context.

**Verify**:
1. Check `[vault]/memory.md` exists and has content
2. Restart the app after editing memory.md
3. Memory is sent as a system prompt - check the Anthropic console to verify it's being included

---

### Hot reload not working

**Problem**: Changes to React code don't appear.

**Solutions**:
1. **Frontend changes**: Should reload automatically via Vite
2. **Rust changes**: Require rebuild (Tauri watches automatically)
3. **Config changes**: Require full restart (Ctrl+C and restart)

If still not working:
```bash
# Force restart
# Ctrl+C to stop
./run.sh
```

---

## Getting Help

If you're still stuck:

1. **Check the logs**:
   - Terminal output where you ran `./run.sh`
   - Browser console (right-click → Inspect Element → Console)

2. **Check your environment**:
   ```bash
   node --version    # Should be 18+
   cargo --version   # Should show Rust version
   npm --version     # Should show npm version
   ```

3. **Start fresh**:
   ```bash
   rm -rf node_modules dist src-tauri/target
   npm install
   ./run.sh
   ```

4. **File an issue**: https://github.com/borismus/promptbox/issues

---

## Debug Mode

For more detailed error messages:

```bash
# Run with Rust backtrace
RUST_BACKTRACE=1 ./run.sh

# Or manually:
source $HOME/.cargo/env
RUST_BACKTRACE=1 npm run tauri dev
```

This will show full stack traces for Rust errors.
