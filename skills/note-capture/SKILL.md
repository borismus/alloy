---
name: note-capture
description: Extract insights from conversations into structured notes. Propose at conversation end.
---

# Note Capture Skill

At the end of meaningful conversations, propose extracting key insights into notes.

## How to capture notes

1. Identify noteworthy content: projects, people, concepts, decisions, learnings
2. Use `list_directory` with directory `notes` to see existing notes
3. Use `read_file` to check if a relevant note exists (e.g., `notes/projectname.md`)
4. Append new insights or create a new note file

## CRITICAL: The &[[conversation]] marker

Every line you write MUST end with `&[[CONVERSATION_PATH]]` where CONVERSATION_PATH is provided in the system prompt under "Current Conversation".

Example (if system prompt says the path is `conversations/2025-01-19-1430-a1b2-notes-discussion`):
```markdown
- Working on AI notes feature &[[conversations/2025-01-19-1430-a1b2-notes-discussion]]
- Key insight: use provenance markers &[[conversations/2025-01-19-1430-a1b2-notes-discussion]]
```

## Edit rules (PEN VS PENCIL)

- You can ONLY edit or remove lines that have `&[[` markers (AI-written content)
- NEVER modify lines without `&[[` markers (human-written content)
- NEVER modify lines with `[[` but no `&` prefix (human-approved content)
- When updating your own content, keep or update the `&[[conversation]]` marker

## File structure

Notes go in `notes/` directory as flat files:
- `notes/projectname.md` - project notes
- `notes/personname.md` - people notes
- `notes/conceptname.md` - concept notes
