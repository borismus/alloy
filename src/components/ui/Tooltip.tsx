import type { ReactElement } from 'react';
import { Tooltip, TooltipTrigger } from 'react-aria-components';
import styles from './Tooltip.module.css';

type Placement = 'top' | 'bottom' | 'left' | 'right';

export interface AlloyTooltipProps {
  content: string;
  placement?: Placement;
  /** A single React Aria pressable element, normally Alloy's Button. */
  children: ReactElement;
}

/**
 * Accessible, styled tooltip built on React Aria. Wrap any focusable element;
 * the tooltip shows on hover (after a short delay) and on keyboard focus. Use
 * on icon-only controls in place of the native `title=` attribute.
 */
export function AlloyTooltip({ content, placement = 'top', children }: AlloyTooltipProps) {
  return (
    <TooltipTrigger delay={500} closeDelay={0}>
      {children}
      <Tooltip className={styles.tooltip} placement={placement} offset={6}>
        {content}
      </Tooltip>
    </TooltipTrigger>
  );
}
