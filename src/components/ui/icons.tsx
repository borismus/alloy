/*
 * Small glyphs for badges, sized to sit beside --text-xs uppercase text. They
 * draw in currentColor so they take the badge's tone.
 */

/** Padlock: runs on a local model, so prompts stay on the device. */
export function LockIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="4" y="10.5" width="16" height="10.5" rx="2" fill="currentColor" />
      <path d="M7.5 10.5V7a4.5 4.5 0 0 1 9 0v3.5" stroke="currentColor" strokeWidth="2" fill="none" />
    </svg>
  );
}

/** Page with a folded corner: a note. */
export function NoteIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6M8 13h8M8 17h5" />
    </svg>
  );
}

/** Clock: a scheduled task. */
export function TaskIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9.5" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}
