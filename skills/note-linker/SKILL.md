---
name: note-linker
description: Organize notes by finding connections and consolidating AI content.
---

# Note Linker Skill

When the user asks to organize or consolidate their notes:

1. Read all notes in `notes/` directory
2. Identify connections between notes (shared topics, related projects)
3. Add cross-references using `[[note-name]]` links
4. Consolidate redundant AI content

## CRITICAL: Edit rules (PEN VS PENCIL)

- You can ONLY edit or remove lines that have `&[[` markers (AI-written content)
- NEVER modify lines without `&[[` markers (human-written content)
- NEVER modify lines with `[[` but no `&` prefix (human-approved content)
- When consolidating, propose deletions/merges and wait for user confirmation

## Consolidation process

1. Find duplicate or redundant information across AI-written lines
2. Propose a consolidated version
3. Only proceed with changes after user confirms
