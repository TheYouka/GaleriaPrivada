// Selector «Elegir vídeo…» de la pantalla de vídeo dual (docs/DESIGN.md §18.1): un diálogo con los
// vídeos listos de la galería (miniatura, nombre y duración) y una búsqueda por nombre. Elegir uno lo
// pone en el lado que lo pidió. Solo ve ids y miniaturas: nunca rutas.
import { useEffect, useState } from 'react';
import { Film, X } from 'lucide-react';
import { Dialog } from 'radix-ui';
import type { MediaListItem } from '@shared/types';
import { IconButton } from '../../components/IconButton';
import { FIELD_INPUT_CLASS } from '../../components/TextField';
import { errorMessage } from '../../lib/errors-es';
import { formatDuration } from '../../lib/format';
import { invoke } from '../../lib/ipc';
import { thumbUrl } from '../../lib/vault-url';
import { chooseVideo, closePick, SIDE_LABEL, useDualStore } from '../../stores/dual-store';
import { filterVideos, PICKER_LIMIT } from './picker-model';
import type { Side } from './sync';

type Load =
  | { name: 'loading' }
  | { name: 'ready'; items: readonly MediaListItem[] }
  | { name: 'error'; message: string };

/** El contenido se monta al abrir el diálogo: cada vez carga la lista y empieza sin búsqueda. */
function PickerContent({ side }: { side: Side }) {
  const otherId = useDualStore((s) => (side === 'left' ? s.right?.id : s.left?.id));
  const [load, setLoad] = useState<Load>({ name: 'loading' });
  const [search, setSearch] = useState('');

  useEffect(() => {
    let cancelled = false;
    void invoke('media:list', { kind: 'video', sort: { field: 'captured', dir: 'desc' } }).then(
      (res) => {
        if (cancelled) return;
        setLoad(
          res.ok
            ? { name: 'ready', items: res.data.items }
            : { name: 'error', message: errorMessage(res.error) },
        );
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const shown = load.name === 'ready' ? filterVideos(load.items, search) : [];
  const visible = shown.slice(0, PICKER_LIMIT);

  return (
    <>
      <div className="flex items-start gap-3 px-6 pt-5 pb-3">
        <div className="min-w-0 flex-1">
          <Dialog.Title className="text-xl font-semibold">Elegir vídeo</Dialog.Title>
          <Dialog.Description
            id="video-picker-description"
            className="mt-1 text-sm text-text-muted"
          >
            Para el lado {SIDE_LABEL[side]}.
          </Dialog.Description>
        </div>
        <Dialog.Close asChild>
          <IconButton label="Cerrar" icon={X} />
        </Dialog.Close>
      </div>
      <div className="px-6 pb-3">
        <label htmlFor="video-picker-search" className="text-sm font-medium text-text">
          Buscar por nombre
        </label>
        <input
          id="video-picker-search"
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className={`mt-1.5 ${FIELD_INPUT_CLASS}`}
          autoComplete="off"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-5">
        {load.name === 'loading' ? (
          <p role="status" className="py-6 text-center text-text-muted">
            Cargando…
          </p>
        ) : load.name === 'error' ? (
          <p role="alert" className="py-6 text-center text-danger-text">
            {load.message}
          </p>
        ) : shown.length === 0 ? (
          <p role="status" className="py-6 text-center text-text-muted">
            {load.items.length === 0
              ? 'Todavía no hay vídeos en la galería.'
              : 'Ningún vídeo coincide con la búsqueda.'}
          </p>
        ) : (
          <>
            <ul
              aria-label="Vídeos"
              className="grid grid-cols-[repeat(auto-fill,minmax(9.5rem,1fr))] gap-2"
            >
              {visible.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    data-picker-item=""
                    aria-label={
                      item.durationMs === null
                        ? item.name
                        : `${item.name}, ${formatDuration(item.durationMs)}`
                    }
                    disabled={item.id === otherId}
                    onClick={() => void chooseVideo(side, item.id)}
                    className="flex w-full flex-col gap-1.5 rounded-md border border-border bg-surface p-1.5 text-left transition-colors hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <span className="relative block aspect-video overflow-hidden rounded-sm bg-black">
                      <img
                        src={thumbUrl(item.id, item.thumbRev)}
                        alt=""
                        loading="lazy"
                        className="size-full object-cover"
                      />
                      {item.durationMs !== null ? (
                        <span className="absolute right-1 bottom-1 rounded-sm bg-black/70 px-1 text-xs text-white tabular-nums">
                          {formatDuration(item.durationMs)}
                        </span>
                      ) : null}
                    </span>
                    <span className="flex items-center gap-1 text-sm">
                      <Film aria-hidden="true" size={14} className="shrink-0 text-text-muted" />
                      <span className="min-w-0 truncate">{item.name}</span>
                    </span>
                    {item.id === otherId ? (
                      <span className="text-xs text-text-muted">Ya está en el otro lado</span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
            {shown.length > visible.length ? (
              <p className="mt-3 text-center text-sm text-text-muted">
                Se muestran {visible.length} de {shown.length}. Usa la búsqueda para acotar.
              </p>
            ) : null}
          </>
        )}
      </div>
    </>
  );
}

export function VideoPicker() {
  const picking = useDualStore((s) => s.picking);
  return (
    <Dialog.Root open={picking !== null} onOpenChange={(open) => (!open ? closePick() : undefined)}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60" />
        <Dialog.Content
          data-video-picker=""
          aria-describedby="video-picker-description"
          className="fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100vh-3rem)] w-[min(46rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg border border-border bg-bg-elevated text-text shadow-lg"
        >
          {picking ? <PickerContent side={picking} /> : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
