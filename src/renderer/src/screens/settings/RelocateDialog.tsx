// Diálogo de progreso del traslado (docs/DESIGN.md §8.7 paso 2 y §14.9): AlertDialog que no se
// cierra con Esc ni con un clic fuera, con la barra (copiedBytes / totalBytes) y "Cancelar" con el
// foco inicial. Desde el paso 5 el botón pasa a "Terminando…" deshabilitado (aria-disabled, para que
// el foco no se pierda). Se cierra solo con relocate:done. Va en UnlockedApp para que siga visible
// aunque cambie la pantalla.
import { useEffect, useRef } from 'react';
import { AlertDialog } from 'radix-ui';
import { Button } from '../../components/Button';
import {
  cancelRelocate,
  isFinishing,
  subscribeRelocate,
  useRelocateStore,
} from '../../stores/relocate-store';

export function RelocateDialog() {
  const job = useRelocateStore((s) => s.job);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => subscribeRelocate(), []);

  const finishing = job ? isFinishing(job) : false;
  const percent =
    job && job.totalBytes > 0
      ? Math.min(100, Math.floor((job.copiedBytes / job.totalBytes) * 100))
      : 0;
  const label = finishing ? 'Terminando…' : job?.cancelling ? 'Cancelando…' : 'Cancelar';
  const disabled = finishing || (job?.cancelling ?? false);

  return (
    <AlertDialog.Root open={job !== null}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-40 bg-black/60" />
        <AlertDialog.Content
          className="fixed top-1/2 left-1/2 z-50 w-[min(30rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-bg-elevated p-6 text-text shadow-lg"
          onEscapeKeyDown={(e) => e.preventDefault()}
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            cancelRef.current?.focus();
          }}
        >
          <AlertDialog.Title className="text-xl font-semibold">
            Moviendo la bóveda
          </AlertDialog.Title>
          <AlertDialog.Description className="mt-2 text-sm text-text">
            No cierres Galería ni desconectes el disco hasta que termine. La bóveda anterior no se
            borra hasta que la copia está comprobada.
          </AlertDialog.Description>
          <div className="mt-5 flex flex-col gap-2">
            <div
              role="progressbar"
              aria-label="Progreso del traslado"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent}
              aria-valuetext={finishing ? 'Terminando' : `${percent} %`}
              className="h-2 w-full overflow-hidden rounded-full bg-border-strong"
            >
              <div
                className="h-full rounded-full bg-accent transition-[width] duration-(--g-dur-fast)"
                style={{ width: `${percent}%` }}
              />
            </div>
            <p className="text-sm text-text-muted" aria-hidden="true">
              {finishing ? 'Terminando…' : `${percent} %`}
            </p>
          </div>
          <div className="mt-5 flex justify-end">
            <Button
              ref={cancelRef}
              aria-disabled={disabled || undefined}
              className={disabled ? 'cursor-not-allowed opacity-50' : undefined}
              onClick={() => {
                if (!disabled) void cancelRelocate();
              }}
            >
              {label}
            </Button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
