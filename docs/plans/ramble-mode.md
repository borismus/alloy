# Ramble Mode Implementation Plan

## Overview

Transform **NoteChatSidebar** into a ramble interface. User types raw thoughts in the sidebar; every ~5 seconds the AI processes accumulated input and appends structured content to a **ramble note** (`rambles/YYYY-MM-DD-HHMMSS.md`). Related notes are surfaced via inline `[[wikilinks]]`.

- **Sidebar**: Raw input (user's scratchpad)
- **NoteViewer**: AI-processed note (builds up in real-time)
- **Enter key**: Triggers integration flow

## User Flow

```
1. User on Notes tab (any state)
2. User starts typing in NoteChatSidebar
3. System creates ramble note (rambles/2026-02-02-143052.md) and selects it
4. Every ~5 seconds: AI processes new input → appends to ramble note
5. NoteViewer shows processed note building up
6. User hits Enter
7. AI proposes integration changes to other notes
8. User approves → changes written
```

## Architecture

```
[ Sidebar ] [ NoteViewer (processed) ] [ NoteChatSidebar (raw input) ]
                    ↑                            |
                    |                       User types continuously
                    |                            |
              File watcher                  Every ~5 seconds
              triggers refresh                   ↓
                    |                   AI processes new input
                    |                            ↓
                    +←←←←← Appends to ramble note ←←←←←+
```

### Key Points
- **Sidebar = raw input**: User types thoughts as they come
- **NoteViewer = processed output**: AI's structured interpretation with wikilinks, auto-scrolls as content grows
- **Smart processing trigger**: Process when (2+ sec passed) AND (50+ new chars). Fallback: always after 5 sec if any new input.
- **Enter = done**: Triggers integration flow (not a button)
- **Timestamp naming**: `rambles/YYYY-MM-DD-HHMMSS.md` for multiple per day

---

## Files to Create

### 1. `src/contexts/RambleContext.tsx`
State management:
```typescript
interface RambleState {
  isRambling: boolean;
  currentRambleNote: string | null;  // e.g., "rambles/2026-02-02-143052.md"
  rawInput: string;                   // accumulated raw input from sidebar
  lastProcessedIndex: number;         // track what's been processed
  lastProcessedTime: number;          // timestamp of last process
  phase: 'idle' | 'rambling' | 'integrating' | 'approving';
  isProcessing: boolean;
  proposedChanges: ProposedChange[];
}

interface RambleContextValue extends RambleState {
  startRamble: () => Promise<string>;     // creates timestamped ramble note
  updateRawInput: (text: string) => void; // called on every keystroke
  finishRamble: () => Promise<void>;      // triggered by Enter key
  applyChanges: () => Promise<void>;
  cancelIntegration: () => void;
  reset: () => void;
}
```

**Processing trigger logic** (checked on input change + short interval):
- Primary: `(now - lastProcessedTime >= 2000) && (rawInput.length - lastProcessedIndex >= 50)`
- Fallback: `(now - lastProcessedTime >= 5000) && (rawInput.length > lastProcessedIndex)`

### 2. `src/components/RambleBatchApprovalModal.tsx`
Modal for integration approval:
- Summary of proposed changes to other notes
- List of affected notes with descriptions
- "Apply All" / "Cancel" buttons

### 3. `src/components/RambleBatchApprovalModal.css`
Styling for the approval modal.

---

## Files to Modify

### `src/App.tsx`
- Import `RambleProvider`
- Wrap app with `RambleProvider`
- When rambling starts, auto-select the ramble note:
```tsx
// In RambleContext, when startRamble() is called:
// - Create rambles/YYYY-MM-DD.md if needed
// - Call onSelectNote(rambleFilename) to show it in NoteViewer
```

### `src/components/NoteChatSidebar.tsx`
Major changes:
- Import and use `useRambleContext`
- On input change: call `updateRawInput()` (tracks raw input)
- On Enter key (not shift+enter): call `finishRamble()` → integration flow
- Shift+Enter: newline (normal behavior)
- Show processing indicator when AI is processing a chunk
- Update empty state text to explain ramble functionality
- Raw input stays visible in textarea during rambling

### `src/services/ramble.ts`
Add new methods:
```typescript
// Get or create today's ramble note
async getOrCreateRambleNote(vaultPath: string): Promise<string>

// Process user input and update ramble note
async processRambleInput(
  input: string,
  rambleNotePath: string,
  existingNotes: NoteInfo[],
  model: string,
  onChunk: (chunk: string) => void
): Promise<void>

// Generate integration proposals for other notes
async generateIntegrationProposal(
  rambleContent: string,
  existingNotes: NoteInfo[],
  model: string
): Promise<ProposedChange[]>

// Apply approved changes to notes
async applyProposedChanges(
  changes: ProposedChange[],
  vaultPath: string
): Promise<void>
```

### `src/types/index.ts`
Add:
```typescript
interface ProposedChange {
  type: 'create' | 'update' | 'append';
  path: string;
  description: string;
  newContent: string;
  reasoning: string;
}
```

### `src/services/vault.ts`
Add helper:
```typescript
// Ensure rambles/ directory exists
async ensureRamblesDirectory(): Promise<void>
```

### `src/components/NoteViewer.tsx`
Add auto-scroll behavior:
- When displaying a ramble note (detected via path prefix `rambles/`)
- Auto-scroll to bottom when content changes
- Use `useEffect` + `scrollIntoView` on content container

---

## Data Flow

### Real-time Processing (Time + Length trigger)
```
User types in NoteChatSidebar
         ↓
Raw input accumulates in state
  - lastProcessedIndex: tracks what's been sent
  - lastProcessedTime: tracks when last process happened
         ↓
Check trigger conditions (on input change or short interval):
  - Primary: (2+ sec since last process) AND (50+ new chars)
  - Fallback: (5+ sec since last process) AND (any new input)
         ↓
If triggered:
  - rambleService.processRambleInput(newInput)
  - LLM streams processed markdown with [[wikilinks]]
  - Append to rambles/YYYY-MM-DD-HHMMSS.md
  - Update lastProcessedIndex + lastProcessedTime
         ↓
Vault watcher triggers → NoteViewer refreshes (auto-scrolls to bottom)
```

### Integration (triggered by Enter key)
```
User hits Enter
         ↓
rambleService.generateIntegrationProposal()
         ↓
LLM analyzes ramble → proposes changes to other notes
         ↓
Show RambleBatchApprovalModal
         ↓
User approves → rambleService.applyProposedChanges()
         ↓
Reset ramble state
```

---

## Implementation Order

### Phase 1: Foundation
1. Add `ProposedChange` type to `src/types/index.ts`
2. Create `src/contexts/RambleContext.tsx`
3. Add `RambleProvider` to `App.tsx`
4. Add `ensureRamblesDirectory()` to vault service

### Phase 2: Ramble Note Creation
1. Add `getOrCreateRambleNote()` to ramble service
2. Wire up `startRamble()` in context to create note + select it

### Phase 3: Real-time Processing
1. Add `processRambleInput()` to ramble service
2. Connect NoteChatSidebar to RambleContext
3. Implement 5-second timer-based processing
4. Test: typing → ramble note updates every ~5 seconds

### Phase 4: Integration Flow
1. Add `generateIntegrationProposal()` to ramble service
2. Create `RambleBatchApprovalModal.tsx`
3. Wire up Enter key in NoteChatSidebar to trigger integration
4. Implement `applyProposedChanges()`
5. Wire up full approval flow

---

## System Prompts

### Real-time Processing (called every ~5 seconds)
```
You are helping capture the user's stream of consciousness. Process this new chunk of their rambling into clear, structured markdown.

Rules:
- Add [[wikilinks]] to existing notes when referencing related concepts
- Structure with headers, bullets as appropriate
- Be concise - capture the essence
- This will be APPENDED to the note, so don't repeat prior content
- Output ONLY the processed content (no meta-commentary)

Existing notes in vault: {notesList}
Previous processed content (for context): {existingContent}
New raw input to process: {newInputChunk}
```

### Integration Proposal
```
The user finished rambling. Analyze the ramble note and propose specific
changes to integrate key insights into their other notes.

Ramble content: {rambleContent}
Existing notes: {notesWithContent}

Return JSON array:
[{
  "type": "append",
  "path": "notes/topic.md",
  "description": "Add insight about X",
  "newContent": "content with [[provenance]]",
  "reasoning": "why"
}]

Rules:
- Prefer appending to existing notes
- Add provenance: &[[rambles/YYYY-MM-DD]]
- Only propose meaningful integrations
```

---

## Verification Plan

1. **Test ramble activation**:
   - Notes tab → type in sidebar → ramble note created and selected
   - Works whether a note was previously selected or not

2. **Test real-time updates**:
   - Type continuously → see ramble note updating every ~5 seconds
   - Wikilinks appear for related notes

3. **Test integration**:
   - Hit Enter → see proposals modal
   - Approve → verify changes in target notes
   - Check provenance markers

---

## Critical Files

| File | Role |
|------|------|
| `src/components/NoteChatSidebar.tsx` | Input interface - connect to ramble context |
| `src/services/ramble.ts` | Extend with processing methods |
| `src/App.tsx` | Add RambleProvider, handle note selection |
| `src/components/NoteViewer.tsx` | Add auto-scroll to bottom when ramble note updates |
| `src/hooks/useVaultWatcher.ts` | Already triggers refresh on file changes |
