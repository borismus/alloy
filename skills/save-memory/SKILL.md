---
name: save-memory
description: Save new memories to memory.md when user asks to remember something
---

# Save Memory Skill

When the user asks to remember something:

1. First read the current `memory.md`
2. Then call `write_file` with path `memory.md` and the COMPLETE updated content

**CRITICAL:** Only use the file `memory.md`. Never create other files like `notes/`, `preferences.md`, etc. All memories go in `memory.md`.

Step 1 is not optional. `memory.md` is hand-curated and has no history in the
vault, so a write that would sharply shrink it is refused unless this turn has
actually read the file it is replacing. Never reconstruct it from memory of an
earlier turn, and never write a summary of it — write the full text with your
change applied. The previous version is kept in a rolling backup set, but that
is a safety net, not a substitute for reading first.
