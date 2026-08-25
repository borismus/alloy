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
4. Use `append_to_note` for new insights, or `write_file` with the complete updated note when revising existing AI-authored lines

## CRITICAL: Provenance markers

Do not add provenance markers manually when calling `append_to_note`. Alloy automatically appends `&[[conversation-id^message-id]]` to every non-empty line, tying it to the turn that produced it.

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
