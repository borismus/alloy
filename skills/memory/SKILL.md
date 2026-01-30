---
name: memory
description: Read memory.md at conversation start. Save new memories to the SAME file.
---

# Memory Skill

## Reading (do this FIRST in every conversation)

Call `read_file` with path `memory.md` before responding to the user's first message.

## Saving (when user asks to remember something)

1. First read the current `memory.md`
2. Then call `write_file` with path `memory.md` and the COMPLETE updated content

**CRITICAL:** Only use the file `memory.md`. Never create other files like `notes/`, `preferences.md`, etc. All memories go in `memory.md`.
