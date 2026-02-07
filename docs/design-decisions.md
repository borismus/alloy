# Design Decisions

## Conversation Storage Format (Deferred)

**Status:** Considered, deferred
**Date:** 2026-02-06

### Context

Explored moving from YAML to Markdown for conversation storage to improve human readability and Obsidian integration.

### Current Approach

Conversations stored as `.yaml` files with full structure:
- Metadata: id, created, updated, model, title, comparison, council, trigger
- Messages array with per-turn: role, timestamp, content, model, attachments, toolUse, skillUse

A `.md` preview is also generated for Obsidian viewing (lossy export).

### Options Considered

**Option A: Lossy Markdown export** (current)
- Clean readable format, but not source of truth
- Already implemented

**Option B: YAML frontmatter + Markdown body with metadata array**
```markdown
---
turns:
  - role: user
    timestamp: ...
  - role: assistant
    timestamp: ...
    model: ...
---
Content here...
---
Response here...
```
- Fragile: requires matching frontmatter array to body sections
- Confusing with multiple `---` delimiters

**Option C: Role headers with inline metadata**
```markdown
### user
Content...

### assistant [model-name]
Response...
```
- Clean for simple cases
- Gets ugly with attachments, tool use, timestamps
- Parsing ambiguity if content contains `### user`

**Option D: Blockquotes for user, plain text for assistant**
```markdown
> User message here

Assistant response here
```
- Very clean for simple conversations
- Per-turn metadata requires HTML comments or similar hacks

### Decision

Deferred. The core tension: Markdown excels at readable content, but per-message metadata (timestamps, model attribution, attachments, tool use) fights against that simplicity. No format found that is both:
1. Fully faithful to the data model
2. Clean and human-editable

### Future Considerations

- Could revisit if Message type is simplified (e.g., drop per-message timestamps)
- Could accept lossy format if editing conversations becomes a priority
- Could use a hybrid: simple conversations as Markdown, complex ones stay YAML
