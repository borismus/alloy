---
name: summarize-note
description: Compress a note significantly while preserving provenance markers
---
# Summarize Note

Compress a note file significantly while preserving the provenance of the original content.

## Steps

1. **Read the note** using `read_file` to get its current content

2. **Identify content types:**
   - **Human content**: Lines WITHOUT `&[[chat^...]]` markers - these are user-written
   - **AI content**: Lines WITH `&[[chat^...]]` markers - these were AI-generated

3. **Summarize following these rules:**
   - **Human content**: Keep VERBATIM. You may reorder but NEVER alter the text.
   - **AI content**: Aggressively merge, condense, and rewrite. Remove redundancy.
   - When merging multiple AI lines, keep ONE provenance marker from the merged content.
   - Remove trivial AI additions (acknowledgments, filler, obvious statements).
   - Preserve the most valuable insights and action items.

4. **Write the summarized note** using `write_file` (user will approve the diff)

## Example

**Before:**
```
# Project Ideas

Build a CLI tool &[[chat^msg-a1b2]]

This is my core thesis on productivity.

Consider using Rust for performance &[[chat^msg-a1b2]]
Could also try Go for simplicity &[[chat^msg-c3d4]]
TypeScript is another option &[[chat^msg-e5f6]]

Need to research market size.

Added initial brainstorm about features &[[chat^msg-a1b2]]
The key features would be: speed, simplicity, extensibility &[[chat^msg-c3d4]]
```

**After:**
```
# Project Ideas

Build a CLI tool (Rust/Go/TypeScript options) &[[chat^msg-a1b2]]

This is my core thesis on productivity.

Need to research market size.

Key features: speed, simplicity, extensibility &[[chat^msg-c3d4]]
```

Notice:
- Human lines preserved exactly
- Multiple AI lines about language choice merged into one
- Redundant AI observations removed
- Provenance markers retained for merged content

## Output

After calling `write_file`, respond briefly: "Summarized [filename] from X to Y lines."
