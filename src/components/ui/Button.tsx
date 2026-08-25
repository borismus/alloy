import { forwardRef } from 'react';
import { Button as AriaButton, type ButtonProps as AriaButtonProps } from 'react-aria-components';
import styles from './Button.module.css';

type ButtonVariant = 'primary' | 'secondary' | 'surface' | 'muted' | 'quiet' | 'danger';
type ButtonSize = 'small' | 'medium' | 'icon' | 'compactIcon' | 'composer';

export interface ButtonProps extends Omit<AriaButtonProps, 'className'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Native hover hint retained while controls migrate from plain buttons. */
  title?: string;
}

/**
 * Alloy button, built on React Aria's Button (press/focus/keyboard/ARIA) with
 * token-driven styling. Feature code should use this rather than a raw
 * `<button>` so variants, sizes, and interaction states stay consistent.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'medium', ...props },
  ref,
) {
  return (
    <AriaButton
      {...props}
      ref={ref}
      className={`${styles.root} ${styles[variant]} ${styles[size]}`}
    />
  );
});
