import type { ReactElement } from 'react';
import { Focusable, Tooltip, TooltipTrigger } from 'react-aria-components';
import styles from './Tooltip.module.css';

type Placement = 'top' | 'bottom' | 'left' | 'right';

export interface AlloyTooltipProps {
  content: string;
  placement?: Placement;
  /** A single focusable element (e.g. an icon button). */
  children: ReactElement;
}

/**
 * Accessible, styled tooltip built on React Aria. Wrap any focusable element;
 * the tooltip shows on hover (after a short delay) and on keyboard focus. Use
 * on icon-only controls in place of the native `title=` attribute.
 */
export function AlloyTooltip({ content, placement = 'top', children }: AlloyTooltipProps) {
  // Focusable clones the child and injects interaction props; a plain focusable
  // element (e.g. a <button>) satisfies this at runtime.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const trigger = children as ReactElement<any, string>;
  return (
    <TooltipTrigger delay={500} closeDelay={0}>
      <Focusable>{trigger}</Focusable>
      <Tooltip className={styles.tooltip} placement={placement} offset={6}>
        {content}
      </Tooltip>
    </TooltipTrigger>
  );
}
