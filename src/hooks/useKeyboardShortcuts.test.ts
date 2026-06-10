import { describe, it, expect, vi, afterEach } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useKeyboardShortcuts } from './useKeyboardShortcuts';

// Tell React this is a valid act() environment (required by React 19 under vitest).
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Deps = Parameters<typeof useKeyboardShortcuts>[0];

function makeDeps(overrides: Partial<Deps> = {}): Deps {
  return {
    showSettings: false,
    showFind: false,
    selectedItem: null,
    onNewConversation: vi.fn(),
    setShowSettings: vi.fn(),
    setShowFind: vi.fn(),
    setSelectedItem: vi.fn(),
    setNoteContent: vi.fn(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sidebarRef: { current: { focusSearch: vi.fn() } } as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findRef: { current: { focus: vi.fn(), next: vi.fn(), previous: vi.fn() } } as any,
    ...overrides,
  };
}

function Harness({ deps }: { deps: Deps }) {
  useKeyboardShortcuts(deps);
  return null;
}

let container: HTMLDivElement | undefined;
let root: Root | undefined;

function mount(deps: Deps) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(createElement(Harness, { deps }));
  });
}

function press(init: KeyboardEventInit) {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init }));
  });
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = undefined;
  container = undefined;
});

describe('useKeyboardShortcuts — find shortcuts', () => {
  it('Cmd+F opens the find bar when it is closed', () => {
    const deps = makeDeps({ showFind: false });
    mount(deps);
    // The mount-time effect calls setShowFind(false); ignore that.
    (deps.setShowFind as ReturnType<typeof vi.fn>).mockClear();
    press({ key: 'f', metaKey: true });
    expect(deps.setShowFind).toHaveBeenCalledWith(true);
  });

  it('Cmd+F focuses the find input when it is already open', () => {
    const deps = makeDeps({ showFind: true });
    mount(deps);
    press({ key: 'f', metaKey: true });
    expect(deps.findRef.current!.focus).toHaveBeenCalled();
  });

  it('Cmd+G goes to the next match while find is open', () => {
    const deps = makeDeps({ showFind: true });
    mount(deps);
    press({ key: 'g', metaKey: true });
    expect(deps.findRef.current!.next).toHaveBeenCalledTimes(1);
    expect(deps.findRef.current!.previous).not.toHaveBeenCalled();
  });

  it('Cmd+Shift+G goes to the previous match while find is open', () => {
    const deps = makeDeps({ showFind: true });
    mount(deps);
    press({ key: 'g', metaKey: true, shiftKey: true });
    expect(deps.findRef.current!.previous).toHaveBeenCalledTimes(1);
    expect(deps.findRef.current!.next).not.toHaveBeenCalled();
  });

  it('Cmd+G does nothing when find is closed', () => {
    const deps = makeDeps({ showFind: false });
    mount(deps);
    press({ key: 'g', metaKey: true });
    expect(deps.findRef.current!.next).not.toHaveBeenCalled();
    expect(deps.findRef.current!.previous).not.toHaveBeenCalled();
  });

  it('Cmd+Shift+F focuses the sidebar search, not the find bar', () => {
    const deps = makeDeps({ showFind: false });
    mount(deps);
    (deps.setShowFind as ReturnType<typeof vi.fn>).mockClear();
    press({ key: 'f', metaKey: true, shiftKey: true });
    expect(deps.sidebarRef.current!.focusSearch).toHaveBeenCalled();
    expect(deps.setShowFind).not.toHaveBeenCalled();
  });

  it('Ctrl+G also works (non-mac modifier)', () => {
    const deps = makeDeps({ showFind: true });
    mount(deps);
    press({ key: 'g', ctrlKey: true });
    expect(deps.findRef.current!.next).toHaveBeenCalledTimes(1);
  });
});
