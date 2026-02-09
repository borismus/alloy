# Claude Code Project Instructions

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