import { forwardRef } from 'react';
import {
  Input,
  Label,
  TextField as AriaTextField,
  type TextFieldProps as AriaTextFieldProps,
} from 'react-aria-components';
import styles from './TextField.module.css';

export interface TextFieldProps extends Omit<AriaTextFieldProps, 'className' | 'children'> {
  /** Visible label. Omit it only when the context names the field, and pass aria-label instead. */
  label?: string;
  placeholder?: string;
}

/** Single-line text input with an optional visible label. */
export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  { label, placeholder, ...props },
  ref,
) {
  return (
    <AriaTextField {...props} className={styles.field}>
      {label && <Label className={styles.label}>{label}</Label>}
      <Input ref={ref} className={styles.input} placeholder={placeholder} />
    </AriaTextField>
  );
});
