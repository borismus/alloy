import type { ReactNode } from 'react';
import styles from './Dialog.module.css';

/** Padded, scrollable content area of an AlloyDialog; stacks its children. */
export function DialogBody({ children }: { children: ReactNode }) {
  return <div className={styles.body}>{children}</div>;
}

/**
 * The button row at the bottom of a dialog: right-aligned, Cancel first and the
 * confirming action last. On a phone the buttons fill the row.
 */
export function DialogActions({ children }: { children: ReactNode }) {
  return <div className={styles.actions}>{children}</div>;
}
