// Confirmación sobre Radix AlertDialog (docs/DESIGN.md §14.1): el foco inicial está en "Cancelar",
// la opción que no pierde nada. La acción no cierra el diálogo por sí sola: el llamador decide
// cuándo (por ejemplo, tras una respuesta de main).
import type { FormEvent, ReactNode } from 'react';
import { AlertDialog } from 'radix-ui';
import { cx } from '../lib/cx';
import { Button } from './Button';

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  title: ReactNode;
  description: ReactNode;
  children?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
  confirmDisabled?: boolean;
  busy?: boolean;
  /** Si no se pasa, solo se muestra el botón de cancelar (con `cancelLabel`). */
  onConfirm?: () => void;
  className?: string;
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  confirmLabel,
  cancelLabel = 'Cancelar',
  danger = false,
  confirmDisabled = false,
  busy = false,
  onConfirm,
  className,
}: ConfirmDialogProps) {
  const submit = (e: FormEvent): void => {
    e.preventDefault();
    if (!confirmDisabled && !busy) onConfirm?.();
  };
  return (
    <AlertDialog.Root
      open={open}
      onOpenChange={(next) => (!next && busy ? undefined : onOpenChange(next))}
    >
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-40 bg-black/60" />
        <AlertDialog.Content
          className={cx(
            'fixed top-1/2 left-1/2 z-50 max-h-[calc(100vh-3rem)] w-[min(30rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-auto rounded-lg border border-border bg-bg-elevated p-6 text-text shadow-lg',
            className,
          )}
          onEscapeKeyDown={(e) => {
            if (busy) e.preventDefault();
          }}
        >
          <AlertDialog.Title className="text-xl font-semibold">{title}</AlertDialog.Title>
          <AlertDialog.Description className="mt-2 text-sm text-text">
            {description}
          </AlertDialog.Description>
          <form
            onSubmit={submit}
            aria-busy={busy || undefined}
            className="mt-4 flex flex-col gap-4"
          >
            {children}
            <div className="mt-2 flex justify-end gap-3">
              <AlertDialog.Cancel asChild>
                <Button disabled={busy}>{cancelLabel}</Button>
              </AlertDialog.Cancel>
              {onConfirm ? (
                <Button
                  type="submit"
                  variant={danger ? 'danger' : 'primary'}
                  disabled={confirmDisabled || busy}
                >
                  {confirmLabel}
                </Button>
              ) : null}
            </div>
          </form>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
