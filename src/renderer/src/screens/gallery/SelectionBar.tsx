// Barra de selección (docs/DESIGN.md §14.6): visible con al menos un elemento seleccionado.
// "Presentación", "Añadir a playlist" y "Vídeo dual" llegan con F4 y F5: aparecen deshabilitados
// (aria-disabled, enfocables) con el tooltip "Disponible próximamente". "Renombrar" solo con un
// elemento; "Eliminar" pide confirmación (el borrado es permanente).
import { Columns2, ListPlus, Pencil, Play, Trash2 } from 'lucide-react';
import { Button } from '../../components/Button';
import { Tooltip } from '../../components/Tooltip';
import { cx } from '../../lib/cx';
import { requestDelete, requestRename, useLibraryStore } from '../../stores/library-store';
import { useSelectionStore } from '../../stores/selection-store';

export const COMING_SOON = 'Disponible próximamente';

function SoonButton({ icon: Icon, children }: { icon: typeof Play; children: string }) {
  return (
    <Tooltip content={COMING_SOON}>
      <Button size="sm" aria-disabled="true" className={cx('cursor-not-allowed px-2.5 opacity-50')}>
        <Icon aria-hidden="true" size={14} strokeWidth={1.75} />
        {children}
      </Button>
    </Tooltip>
  );
}

export function SelectionBar() {
  const selected = useSelectionStore((s) => s.selected);
  const items = useLibraryStore((s) => s.items);
  const count = selected.size;
  if (count === 0) return null;

  const only = count === 1 ? items.find((i) => selected.has(i.id)) : undefined;
  const clear = (): void => useSelectionStore.getState().dispatch({ type: 'escape' }, []);

  return (
    <section
      aria-label="Selección"
      className="mx-6 mb-2 flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-md border border-border-strong bg-surface px-3 py-1.5"
    >
      <p role="status" className="mr-1 text-sm font-medium text-text">
        {count === 1 ? '1 seleccionado' : `${count} seleccionados`}
      </p>
      <SoonButton icon={Play}>Presentación</SoonButton>
      <SoonButton icon={ListPlus}>Añadir a playlist</SoonButton>
      <Button
        size="sm"
        className="px-2.5"
        disabled={!only}
        onClick={() => only && requestRename(only)}
      >
        <Pencil aria-hidden="true" size={14} strokeWidth={1.75} />
        Renombrar
      </Button>
      <SoonButton icon={Columns2}>Vídeo dual</SoonButton>
      <Button
        size="sm"
        variant="danger"
        className="px-2.5"
        onClick={() => requestDelete([...selected])}
      >
        <Trash2 aria-hidden="true" size={14} strokeWidth={1.75} />
        Eliminar
      </Button>
      <Button size="sm" variant="ghost" className="ml-auto px-2.5" onClick={clear}>
        Cancelar selección
      </Button>
    </section>
  );
}
