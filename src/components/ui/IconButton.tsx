import { forwardRef, type ReactNode } from 'react';
import { Button, type ButtonProps } from './Button';
import { AlloyTooltip } from './Tooltip';

export interface IconButtonProps extends Omit<ButtonProps, 'size' | 'children' | 'aria-label' | 'title'> {
  /** Names the action: becomes both the accessible name and the tooltip. */
  label: string;
  /** The icon, normally a 14–20px inline SVG with aria-hidden. */
  children: ReactNode;
  size?: 'icon' | 'compactIcon';
  tooltipPlacement?: 'top' | 'bottom' | 'left' | 'right';
}

/**
 * Icon-only button. Requires a label so every icon control has an accessible
 * name and a tooltip; defaults to the quiet variant used in headers and rows.
 */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, children, variant = 'quiet', size = 'icon', tooltipPlacement = 'top', ...props },
  ref,
) {
  return (
    <AlloyTooltip content={label} placement={tooltipPlacement}>
      <Button {...props} ref={ref} variant={variant} size={size} aria-label={label}>
        {children}
      </Button>
    </AlloyTooltip>
  );
});
