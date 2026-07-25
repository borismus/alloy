import { Button as AriaButton, type ButtonProps as AriaButtonProps } from 'react-aria-components';
import styles from './Button.module.css';

type ButtonVariant = 'primary' | 'secondary' | 'quiet' | 'danger';
type ButtonSize = 'small' | 'medium' | 'icon' | 'composer';

export interface ButtonProps extends Omit<AriaButtonProps, 'className'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

/**
 * Alloy button, built on React Aria's Button (press/focus/keyboard/ARIA) with
 * token-driven styling. Feature code should use this rather than a raw
 * `<button>` so variants, sizes, and interaction states stay consistent.
 */
export function Button({ variant = 'secondary', size = 'medium', ...props }: ButtonProps) {
  return (
    <AriaButton
      {...props}
      className={`${styles.root} ${styles[variant]} ${styles[size]}`}
    />
  );
}
