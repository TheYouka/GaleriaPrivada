// Barra de selección (docs/DESIGN.md §14.6): visible con al menos un elemento seleccionado (modo
// selección, PLAN.md nota 192). Es una superposición anclada abajo de la rejilla (nota 193): al aparecer
// no desplaza los mosaicos, así los clics seguidos siempre aciertan la tarjeta que se ve.
// "Presentación" abre el diálogo de inicio con los elementos seleccionados en el orden de la galería.
// "Vídeo dual" abre la pantalla de vídeo dual (Fase 5) y solo está habilitado con EXACTAMENTE dos
// vídeos seleccionados (izquierdo = el primero en el orden de la galería); si no, aparece
// deshabilitado (aria-disabled, enfocable) con el tooltip que lo explica. "Añadir a playlist" abre un
// menú con las playlists existentes y "Nueva playlist…"; "Quitar de la playlist" solo aparece con un
// filtro de playlist; los elementos se añaden en el orden de la galería. "Renombrar" solo con un elemento; "Eliminar" pide confirmación (el borrado
// es permanente).
import { Columns2, ListMinus, ListPlus, Pencil, Play, Plus, Trash2, X } from 'lucide-react';
import { DropdownMenu } from 'radix-ui';
import { Button } from '../../components/Button';
import { IconButton } from '../../components/IconButton';
import { Tooltip } from '../../components/Tooltip';
import { cx } from '../../lib/cx';
import { openDual } from '../../stores/dual-store';
import { requestDelete, requestRename, useLibraryStore } from '../../stores/library-store';
import {
  addToPlaylist,
  removeFromPlaylist,
  requestCreatePlaylist,
  usePlaylistsStore,
} from '../../stores/playlists-store';
import { startFromGallery, usePresentationStore } from '../../stores/presentation-store';
import { useSelectionStore } from '../../stores/selection-store';
import { DUAL_NEEDS_TWO, dualPair } from './dual-pair';

const MENU_CONTENT =
  'z-50 max-h-80 min-w-56 overflow-y-auto rounded-md border border-border bg-bg-elevated p-1 text-text shadow-md';
const MENU_ITEM =
  'relative flex h-9 cursor-default items-center gap-2 rounded-sm px-3 text-sm outline-none data-highlighted:bg-surface-hover data-highlighted:outline-2 data-highlighted:outline-focus-ring';

/** "Añadir a playlist": las playlists existentes y "Nueva playlist…" (§14.6). */
function AddToPlaylistMenu({ ids }: { ids: readonly string[] }) {
  const playlists = usePlaylistsStore((s) => s.playlists);
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <Button size="sm" className="px-2">
          <ListPlus aria-hidden="true" size={14} strokeWidth={1.75} />
          Añadir a playlist
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          sideOffset={6}
          aria-label="Añadir a playlist"
          className={MENU_CONTENT}
        >
          {playlists.length > 0 ? (
            <>
              <DropdownMenu.Label className="px-3 py-1.5 text-xs text-text-muted">
                Playlists
              </DropdownMenu.Label>
              {playlists.map((p) => (
                <DropdownMenu.Item
                  key={p.id}
                  className={MENU_ITEM}
                  onSelect={() => void addToPlaylist(p, ids)}
                >
                  <span className="min-w-0 flex-1 truncate">{p.name}</span>
                  <span className="shrink-0 text-xs text-text-muted">{p.itemCount}</span>
                </DropdownMenu.Item>
              ))}
              <DropdownMenu.Separator className="my-1 h-px bg-border" />
            </>
          ) : null}
          <DropdownMenu.Item className={MENU_ITEM} onSelect={() => requestCreatePlaylist(ids)}>
            <Plus aria-hidden="true" size={16} />
            Nueva playlist…
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export function SelectionBar() {
  const selected = useSelectionStore((s) => s.selected);
  const items = useLibraryStore((s) => s.items);
  const filterPlaylist = useLibraryStore((s) => s.filters.playlistId);
  const filterPlaylistName = usePlaylistsStore(
    (s) => s.playlists.find((p) => p.id === filterPlaylist)?.name,
  );
  const presentationLoading = usePresentationStore((s) => s.loading);
  const count = selected.size;
  if (count === 0) return null;
  const pair = dualPair(items, selected);

  const only = count === 1 ? items.find((i) => selected.has(i.id)) : undefined;
  const clear = (): void => useSelectionStore.getState().dispatch({ type: 'escape' }, []);

  return (
    <section
      aria-label="Selección"
      className="absolute inset-x-6 bottom-3 z-20 flex flex-wrap items-center gap-x-1.5 gap-y-1.5 rounded-md border border-border-strong bg-bg-elevated px-3 py-1.5 shadow-md"
    >
      <p role="status" className="mr-1 text-sm font-medium text-text">
        {count === 1 ? '1 seleccionado' : `${count} seleccionados`}
      </p>
      <Button
        size="sm"
        className="px-2"
        disabled={presentationLoading}
        onClick={() => void startFromGallery()}
      >
        <Play aria-hidden="true" size={14} strokeWidth={1.75} />
        Presentación
      </Button>
      <AddToPlaylistMenu ids={items.filter((i) => selected.has(i.id)).map((i) => i.id)} />
      {filterPlaylist !== null ? (
        <Button
          size="sm"
          className="px-2"
          onClick={() =>
            void removeFromPlaylist({ id: filterPlaylist, name: filterPlaylistName ?? '' }, [
              ...selected,
            ])
          }
        >
          <ListMinus aria-hidden="true" size={14} strokeWidth={1.75} />
          Quitar de la playlist
        </Button>
      ) : null}
      <Button
        size="sm"
        className="px-2"
        disabled={!only}
        onClick={() => only && requestRename(only)}
      >
        <Pencil aria-hidden="true" size={14} strokeWidth={1.75} />
        Renombrar
      </Button>
      <Tooltip content={DUAL_NEEDS_TWO} enabled={pair === null}>
        <Button
          size="sm"
          aria-disabled={pair === null ? 'true' : undefined}
          className={cx('px-2', pair === null && 'cursor-not-allowed opacity-50')}
          onClick={() => {
            if (pair) void openDual(pair[0].id, pair[1].id);
          }}
        >
          <Columns2 aria-hidden="true" size={14} strokeWidth={1.75} />
          Vídeo dual
        </Button>
      </Tooltip>
      <Button
        size="sm"
        variant="danger"
        className="px-2"
        onClick={() => requestDelete([...selected])}
      >
        <Trash2 aria-hidden="true" size={14} strokeWidth={1.75} />
        Eliminar
      </Button>
      <IconButton
        label="Cancelar selección"
        icon={X}
        iconSize={16}
        className="ml-auto size-8"
        onClick={clear}
      />
    </section>
  );
}
