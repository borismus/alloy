import type { ReactNode } from 'react';
import {
  Button,
  Dialog,
  Heading,
  Modal,
  ModalOverlay,
} from 'react-aria-components';
import styles from './Dialog.module.css';

export interface AlloyDialogProps {
  title: string;
  /** Render prop receives a `close` callback to dismiss the dialog. */
  children: (close: () => void) => ReactNode;
  size?: 'compact' | 'regular';
  /** Whether clicking the overlay / pressing Escape dismisses. Default true. */
  dismissable?: boolean;
}

/**
 * Alloy modal dialog, built on React Aria's ModalOverlay/Modal/Dialog. Provides
 * focus trapping, focus restoration, Escape-to-close, and background inertness.
 * On narrow viewports it renders as a bottom sheet. Pair with a `DialogTrigger`
 * (from react-aria-components) around a trigger button and this component.
 */
export function AlloyDialog({
  title,
  children,
  size = 'regular',
  dismissable = true,
}: AlloyDialogProps) {
  return (
    <ModalOverlay className={styles.overlay} isDismissable={dismissable}>
      <Modal className={`${styles.modal} ${styles[size]}`}>
        <Dialog className={styles.dialog}>
          {({ close }) => (
            <>
              <header className={styles.header}>
                <Heading slot="title" className={styles.title}>{title}</Heading>
                <Button className={styles.close} onPress={close} aria-label="Close dialog">×</Button>
              </header>
              {children(close)}
            </>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
