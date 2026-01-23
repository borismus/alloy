# Orchestra - Launch Checklist

## Before First Run

### 1. Verify Rust is Installed

```bash
# Run this in your terminal
source $HOME/.cargo/env

# Verify Rust is available
rustc --version
cargo --version
```

You should see version numbers. If not, install Rust first:
```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

### 2. Get Your Anthropic API Key

1. Go to https://console.anthropic.com/
2. Sign in or create an account
3. Navigate to API Keys
4. Create a new key (starts with `sk-ant-...`)
5. Copy it - you'll need it on first run

## Launch the App

### Option 1: Using the Launch Script (Recommended)

```bash
# From the orchestra directory
./run.sh
```

This script automatically:
- Loads Rust into your PATH
- Verifies everything is ready
- Launches the app

### Option 2: Manual Launch

```bash
# Load Rust into PATH
source $HOME/.cargo/env

# Run the dev server
npm run tauri dev
```

This will:
1. Build the Rust backend (first time takes 2-3 minutes)
2. Start the Vite dev server
3. Launch the Orchestra window

## First Run Experience

When the app opens:

### Step 1: Select Your Vault Folder
- Click "Select Vault Folder"
- Choose where you want your conversations stored
- Recommended: Create a new folder like `~/orchestra-vault`

### Step 2: Enter API Key
- Paste your Anthropic API key
- Click "Save API Key"
- It will be saved to `[vault]/config.yaml`

### Step 3: Start Chatting!
- Click the `+` button to start a new conversation
- Type your message and press Enter
- Your conversation is automatically saved to `[vault]/conversations/`

## Verify Everything Works

After first run, check your vault folder:

```bash
# Navigate to your vault
cd ~/orchestra-vault  # or wherever you chose

# You should see:
ls -la
# conversations/
# topics/
# memory.md
# config.yaml

# Check your first conversation
ls -la conversations/
# Should show a .yaml file

# View the conversation
cat conversations/*.yaml
```

## Customizing Memory

Edit your `memory.md` file to add personal context:

```bash
# Open in your editor
code memory.md  # or nano, vim, etc.
```

Example memory.md:
```markdown
# Memory

## About me
- Software developer
- Based in San Francisco
- Working on AI tools

## Preferences
- Keep responses concise
- Use TypeScript for code examples
- Prefer functional programming patterns
```

This context is automatically included with every conversation!

## Troubleshooting

### "command not found: cargo"
```bash
source $HOME/.cargo/env
```

### Build takes forever
First build compiles all Rust dependencies - this is normal. Subsequent builds are much faster.

### Can't select vault folder
Make sure you have read/write permissions to the folder you're selecting.

### API key error
- Verify your key starts with `sk-ant-`
- Check you have credits in your Anthropic account
- Try regenerating the key in the console

### Conversations not saving
Check the vault folder permissions and that the `conversations/` directory was created.

## Development vs Production

**Development** (what we're doing now):
```bash
npm run tauri dev
```
- Hot reload for frontend changes
- Console logging enabled
- DevTools available

**Production** (create standalone app):
```bash
npm run tauri build
```
- Creates native app in `src-tauri/target/release/bundle/`
- Optimized and minified
- No dev server needed

## What You Get

✅ Local-first AI chat with Claude
✅ All conversations saved as YAML files
✅ Full-text search across all conversations
✅ Personal memory/context injection
✅ Complete data ownership
✅ No analytics, no tracking

---

**Ready to go!** Run `npm run tauri dev` and enjoy Orchestra!
