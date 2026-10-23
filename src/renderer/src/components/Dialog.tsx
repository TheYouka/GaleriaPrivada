// Diálogo modal sobre Radix Dialog (docs/DESIGN.md §14.1): trampa de foco, cierre con Esc y
// devolución del foco al control que lo abrió. Con `busy`, ni Esc ni un clic fuera lo cierran.
import type { ReactNode } from 'react';
import { Dialog as RDialog } from 'radix-ui';
import { cx } from '../lib/cx';

export interface DialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  title: ReactNode;
  description?: ReactNode;
  /** Encima del título (por ejemplo, el avatar del desbloqueo). */
  header?: ReactNode;
  children?: ReactNode;
  busy?: boolean;
  className?: string;
  onOpenAutoFocus?: (event: Event) => void;
  onCloseAutoFocus?: (event: Event) => void;
}

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  header,
  children,
  busy = false,
  className,
  onOpenAutoFocus,
  onCloseAutoFocus,
}: DialogProps) {
  const block = (e: Event): void => {
    if (busy) e.preventDefault();
  };
  return (
    <RDialog.Root
      open={open}
      onOpenChange={(next) => (!next && busy ? undefined : onOpenChange(next))}
    >
      <RDialog.Portal>
        <RDialog.Overlay className="fixed inset-0 z-40 bg-black/60" />
        <RDialog.Content
          className={cx(
            'fixed top-1/2 left-1/2 z-50 max-h-[calc(100vh-3rem)] w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-auto rounded-lg border border-border bg-bg-elevated p-6 text-text shadow-lg',
            className,
          )}
          // Sin descripción, Radix pide aria-describedby={undefined} explícito.
          {...(description ? {} : { 'aria-describedby': undefined })}
          onOpenAutoFocus={onOpenAutoFocus}
          onCloseAutoFocus={onCloseAutoFocus}
          onEscapeKeyDown={block}
          onPointerDownOutside={block}
          onInteractOutside={block}
        >
          {header}
          <RDialog.Title className="text-xl font-semibold">{title}</RDialog.Title>
          {description ? (
            <RDialog.Description className="mt-1 text-sm text-text-muted">
              {description}
            </RDialog.Description>
          ) : null}
          {children}
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}
