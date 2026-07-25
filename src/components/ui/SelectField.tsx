import {
  Button,
  Label,
  ListBox,
  ListBoxItem,
  Popover,
  Select,
  SelectValue,
  type Key,
} from 'react-aria-components';
import styles from './SelectField.module.css';

export interface SelectOption {
  id: string;
  label: string;
}

export interface SelectFieldProps {
  label: string;
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
}

/**
 * Alloy single-select dropdown, built on React Aria's Select + ListBox. For a
 * non-searchable choice from a small, known set of options.
 */
export function SelectField({ label, value, options, onChange }: SelectFieldProps) {
  return (
    <Select
      className={styles.root}
      selectedKey={value}
      onSelectionChange={(key: Key | null) => key != null && onChange(String(key))}
    >
      <Label className={styles.label}>{label}</Label>
      <Button className={styles.trigger}>
        <SelectValue />
        <span aria-hidden="true">⌄</span>
      </Button>
      <Popover className={styles.popover}>
        <ListBox className={styles.list} items={options}>
          {(option) => (
            <ListBoxItem className={styles.option} id={option.id} textValue={option.label}>
              {option.label}
            </ListBoxItem>
          )}
        </ListBox>
      </Popover>
    </Select>
  );
}
