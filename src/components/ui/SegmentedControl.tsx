import { ToggleButton, ToggleButtonGroup } from 'react-aria-components';
import styles from './SegmentedControl.module.css';

export interface SegmentOption {
  id: string;
  label: string;
}

export interface SegmentedControlProps {
  'aria-label': string;
  options: SegmentOption[];
  value: string;
  onChange: (value: string) => void;
}

/**
 * Single-select segmented control, built on React Aria's ToggleButtonGroup
 * (roving focus, arrow-key navigation, single selection). Used for the sidebar
 * type filter and the Settings appearance control.
 */
export function SegmentedControl({ options, value, onChange, ...props }: SegmentedControlProps) {
  return (
    <ToggleButtonGroup
      {...props}
      className={styles.group}
      selectionMode="single"
      disallowEmptySelection
      selectedKeys={new Set([value])}
      onSelectionChange={(keys) => {
        const key = [...keys][0];
        if (key != null) onChange(String(key));
      }}
    >
      {options.map((option) => (
        <ToggleButton key={option.id} id={option.id} className={styles.segment}>
          {option.label}
        </ToggleButton>
      ))}
    </ToggleButtonGroup>
  );
}
