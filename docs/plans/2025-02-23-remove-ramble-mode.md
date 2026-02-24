# Remove Ramble Mode

## Context

Ramble mode (stream-of-consciousness → crystallization → note integration) overlaps with Background mode's ability to process messy thoughts into notes via natural language commands. Removing it simplifies the app and cuts ~1,500 lines of dedicated ramble code plus references across ~15 files.

## Files to Delete (6 files)

- `src/components/RambleView.tsx` — main ramble UI
- `src/components/RambleView.css` — ramble styles
- `src/components/RambleBatchApprovalModal.tsx` — integration approval modal
- `src/components/RambleBatchApprovalModal.css` — modal styles
- `src/components/AppendOnlyTextarea.tsx` — textarea that locks crystallized text
- `src/services/ramble.ts` — crystallization service
- `src/contexts/RambleContext.tsx` — ramble state machine
- `src/components/NoteChatSidebar.tsx` — dead code (not imported anywhere)
- `src/components/NoteChatSidebar.css` — dead code
- `docs/plans/ramble-mode.md` — planning doc

## Files to Modify

### 1. `src/App.tsx` — Major cleanup
- Remove imports: `rambleService`, `RambleProvider`, `useRambleContext`, `RambleBatchApprovalModal`, `RambleView`
- Delete wrapper components: `RambleApprovalModal`, `MainPanelWithRamble`, `SidebarWithRamble`, `MobileRambleModeEffect`, `NoteViewerWithIntegrate`
- Delete `handleRenameRamble` function
- Remove `rambleService.setVaultPath(path)` from `loadVault()`
- Remove `isViewingDraft` derived state
- Remove `<RambleProvider>` wrapper from JSX
- Remove `<RambleApprovalModal />` and `<MobileRambleModeEffect />` from JSX
- Replace `<SidebarWithRamble>` with plain `<Sidebar>` (remove `onNewRamble` and `onRenameRamble` props)
- Replace `<MainPanelWithRamble>` wrapper — just render children directly
- Replace `<NoteViewerWithIntegrate>` with plain `<NoteViewer>` (remove `onIntegrate` prop)
- Clean up `rambles/` path handling in `goBack`, `handleNoteModified`, `handleSelectItem`, `handleSelectNote` — ramble files stored at vault root under `rambles/` can just be treated as regular notes or removed from path logic

### 2. `src/components/Sidebar.tsx`
- Remove `onNewRamble` and `onRenameRamble` props
- Remove `'ramble'` from `renamingType` union and rename logic
- Remove `'ramble'` from `deletingItem.type` union
- Remove "New Ramble" from FAB menu
- Remove "Rambles" from filter dropdown
- Remove ramble-specific context menu (rename for rambles)
- Remove `getTypeBadge` ramble case
- Clean up `startRename` to only handle conversations

### 3. `src/types/index.ts`
- Remove `'rambles'` from `TimelineFilter`
- Remove `isRamble`, `isIntegrated`, `title` from `NoteInfo` (title may be used by regular notes — check first)
- Remove `'ramble'` from `TimelineItem.type`
- Remove `ProposedChange` interface

### 4. `src/services/vault.ts`
- Remove `ensureRamblesDirectory()`
- Remove `renameRamble()`
- Remove ramble-specific logic from `loadNotes()` (the rambles/ directory scanning)
- Remove ramble-specific logic from `buildTimeline()` (ramble TimelineItems)
- Remove `rambles/` path handling from `getNoteFilePath()` and `deleteNote()`

### 5. `src/hooks/useVaultWatcher.ts`
- Remove `isRambleFile` flag and `rambles/` path detection
- Simplify note filename extraction (no more rambles/ prefix)

### 6. `src/components/NoteViewer.tsx`
- Remove `onIntegrate` prop
- Remove `isRambleNote` / `isUnintegrated` logic
- Remove ramble integrate bar JSX
- Remove auto-scroll for ramble notes
- Clean up `displayName` to not strip `rambles/` prefix

### 7. `src/components/NoteViewer.css`
- Remove `.ramble-integrate-bar` styles

### 8. `src/components/Sidebar.css`
- Remove `.timeline-item.ramble` and `.type-badge.ramble` styles

### 9. `src/utils/wikiLinks.ts`
- Remove `ramble_history` special-case handling (provenance links can just use the conversation path as-is)

### 10. `src/services/tools/registry.ts` and `src/services/tools/builtin/files.ts`
- Remove `ramble_history` references from comments

### 11. `CLAUDE.md` and `README.md`
- Remove mentions of ramble mode, `rambles/` directory from vault structure

## Verification

1. `npm run dev:web` — app loads without errors, no ramble UI visible
2. Sidebar filter dropdown: no "Rambles" option
3. FAB (+) menu: no "New Ramble" option
4. Notes still display correctly in NoteViewer
5. Background mode still works
6. `npm run test:run` — existing tests pass
7. `grep -ri ramble src/` — no remaining references (except possibly test files)
