import type { ReactNode } from 'react';
import styles from './Badge.module.css';

export type BadgeTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';

export interface BadgeProps {
  tone?: BadgeTone;
  /** A glyph before the label, from ./icons (LockIcon, NoteIcon, TaskIcon). */
  icon?: ReactNode;
  children: ReactNode;
  /** Hover hint for an abbreviated badge (e.g. the full model id). */
  title?: string;
}

/**
 * Small non-interactive status label: item type, model location, task state.
 * One shape and one size everywhere; tone carries the meaning. It never
 * wraps, so long labels truncate instead of growing a second line.
 */
export function Badge({ tone = 'neutral', icon, children, title }: BadgeProps) {
  return (
    <span className={`${styles.badge} ${styles[tone]}`} title={title}>
      {icon}
      {children}
    </span>
  );
}
