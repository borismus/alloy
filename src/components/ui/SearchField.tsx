import {
  Button,
  Input,
  SearchField as AriaSearchField,
  type SearchFieldProps as AriaSearchFieldProps,
} from 'react-aria-components';
import styles from './SearchField.module.css';

export interface SearchFieldProps extends Omit<AriaSearchFieldProps, 'className' | 'children'> {
  placeholder?: string;
  'aria-label': string;
}

/**
 * Alloy search input, built on React Aria's SearchField. Includes a leading
 * icon and a clear button that appears when the field has a value (driven by
 * the field's own `data-empty` state).
 */
export function SearchField({ placeholder, ...props }: SearchFieldProps) {
  return (
    <AriaSearchField {...props} className={styles.root}>
      <svg className={styles.icon} viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path d="m10.5 10.5 3 3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
      <Input className={styles.input} placeholder={placeholder} />
      <Button className={styles.clear} aria-label="Clear search">×</Button>
    </AriaSearchField>
  );
}
