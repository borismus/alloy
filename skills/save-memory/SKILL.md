---
name: save-memory
description: Save new memories to memory.md when user asks to remember something
---

# Save Memory Skill

When the user asks to remember something:

1. First read the current `memory.md`
2. Then call `write_file` with path `memory.md` and the COMPLETE updated content

**CRITICAL:** Only use the file `memory.md`. Never create other files like `notes/`, `preferences.md`, etc. All memories go in `memory.md`.
