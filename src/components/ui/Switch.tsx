import { Switch as AriaSwitch, type SwitchProps as AriaSwitchProps } from 'react-aria-components';
import styles from './Switch.module.css';

export interface SwitchProps extends Omit<AriaSwitchProps, 'className' | 'children'> {
  'aria-label': string;
}

/**
 * Alloy toggle switch, built on React Aria's Switch (keyboard, focus, ARIA,
 * proper hidden checkbox). Controlled via isSelected/onChange.
 */
export function Switch(props: SwitchProps) {
  return (
    <AriaSwitch {...props} className={styles.root}>
      <span className={styles.track}>
        <span className={styles.thumb} />
      </span>
    </AriaSwitch>
  );
}
