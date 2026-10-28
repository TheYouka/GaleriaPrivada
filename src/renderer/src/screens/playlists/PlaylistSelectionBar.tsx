// Barra de selección del detalle de una playlist (PLAN.md nota 194): aparece con ≥ 1 fila marcada, con
// el contador en una región de estado. «Presentación» usa los elementos marcados en el orden de la
// playlist; «Quitar de la playlist» quita por lote (no borra los medios); «Cancelar selección» sale
// del modo selección. A propósito no tiene «Eliminar» (borrar medios de la bóveda desde la lista de una
// playlist se confundiría con «Quitar»; está en la galería), ni «Añadir a playlist» ni «Renombrar».
// Va `sticky` al final del contenido: no ocupa sitio por encima de la lista, así que no la desplaza.
import { ListMinus, Play, X } from 'lucide-react';
import type { MediaListItem } from '@shared/types';
import { Button } from '../../components/Button';
import { IconButton } from '../../components/IconButton';
import {
  removeFromPlaylist,
  setPlaylistDetailItems,
  usePlaylistSelectionStore,
  usePlaylistsStore,
} from '../../stores/playlists-store';
import { openPresentationSetup, usePresentationStore } from '../../stores/presentation-store';

export interface PlaylistSelectionBarProps {
  playlist: { id: string; name: string };
  /** Los elementos de la playlist, en su orden. */
  items: readonly MediaListItem[];
}

export function PlaylistSelectionBar({ playlist, items }: PlaylistSelectionBarProps) {
  const selected = usePlaylistSelectionStore((s) => s.selected);
  const presentationLoading = usePresentationStore((s) => s.loading);
  const count = selected.size;
  if (count === 0) return null;

  const chosen = items.filter((i) => selected.has(i.id));
  const clear = (): void => usePlaylistSelectionStore.getState().dispatch({ type: 'escape' }, []);

  return (
    <section
      aria-label="Selección"
      className="sticky bottom-3 z-20 flex max-w-3xl flex-wrap items-center gap-x-1.5 gap-y-1.5 rounded-md border border-border-strong bg-bg-elevated px-3 py-1.5 shadow-md"
    >
      <p role="status" className="mr-1 text-sm font-medium text-text">
        {count === 1 ? '1 seleccionado' : `${count} seleccionados`}
      </p>
      <Button
        size="sm"
        className="px-2"
        disabled={presentationLoading}
        onClick={() =>
          void openPresentationSetup({
            items: chosen,
            playlist: { id: playlist.id, name: playlist.name },
          })
        }
      >
        <Play aria-hidden="true" size={14} strokeWidth={1.75} />
        Presentación
      </Button>
      <Button
        size="sm"
        className="px-2"
        onClick={() => {
          const removed = new Set(chosen.map((i) => i.id));
          void removeFromPlaylist(playlist, [...removed]).then((ok) => {
            if (!ok) return;
            setPlaylistDetailItems(
              usePlaylistsStore.getState().detail.items.filter((i) => !removed.has(i.id)),
            );
          });
        }}
      >
        <ListMinus aria-hidden="true" size={14} strokeWidth={1.75} />
        Quitar de la playlist
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
