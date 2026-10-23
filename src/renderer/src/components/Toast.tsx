// Avisos breves sobre Radix Toast (anunciados por su propia región aria-live). La cola está en
// lib/toast.ts.
import { Toast as RToast } from 'radix-ui';
import { dismissToast, useToastStore } from '../lib/toast';
import { cx } from '../lib/cx';

export function Toaster() {
  const items = useToastStore((s) => s.items);
  return (
    <RToast.Provider label="Notificación" duration={5000} swipeDirection="right">
      {items.map((t) => (
        <RToast.Root
          key={t.id}
          type={t.tone === 'error' ? 'foreground' : 'background'}
          onOpenChange={(open) => {
            if (!open) dismissToast(t.id);
          }}
          className={cx(
            'flex items-center gap-3 rounded-md border bg-bg-elevated px-4 py-3 text-sm text-text shadow-md',
            t.tone === 'error' ? 'border-danger-text' : 'border-border',
          )}
        >
          <RToast.Description className="flex-1">{t.message}</RToast.Description>
          <RToast.Close className="rounded-sm px-2 py-1 text-xs text-text-muted hover:bg-surface-hover">
            Cerrar
          </RToast.Close>
        </RToast.Root>
      ))}
      {/* Nombre de la región en español (el de Radix por defecto es "Notifications ({hotkey})"). */}
      <RToast.Viewport
        label="Notificaciones ({hotkey})"
        className="fixed right-4 bottom-4 z-[60] flex w-96 max-w-[calc(100vw-2rem)] flex-col gap-2 outline-none"
      />
    </RToast.Provider>
  );
}
