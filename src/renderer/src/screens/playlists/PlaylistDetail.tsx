// Detalle de una playlist (docs/DESIGN.md §14.8): cabecera con el nombre y las acciones, y la lista
// vertical reordenable (@dnd-kit/sortable) con miniatura, nombre, tipo o duración y "Quitar".
//  - Ratón: se arrastra por el asa. Teclado: Tab hasta el asa; Espacio o Intro levanta la fila, ↑/↓
//    la mueve, Espacio la suelta y Esc cancela. Además, Alt+↑/↓ mueve una posición directamente.
//  - Los anuncios en español van por `announcements` de dnd-kit y, para Alt+↑/↓, por la región global.
//  - Guardado optimista: al soltar se envía playlists:reorder con la permutación completa; si
//    falla, se restaura el orden anterior (el de la DB) y se muestra un toast.
// Selección (PLAN.md notas 192, 194 y 195, mismas reglas que la galería): un clic en cualquier parte de
// la fila SIEMPRE alterna su casilla (Ctrl+clic alterna, Mayús+clic marca el rango en el orden de la
// playlist). Intro (en la casilla) y el doble clic abren el visor con la lista de la playlist (el doble
// clic deja la selección como estaba); Espacio alterna; Esc y «Cancelar selección» salen. El
// asa, la casilla y «Quitar» llevan `data-row-control`: su clic no alterna la fila, y el asa conserva
// el arrastre intacto. La selección es un almacén propio (`usePlaylistSelectionStore`).
// Quitar de la playlist no borra el medio. La lista no está virtualizada (límite de 2000, §9.2).
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from 'react';
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type Modifier,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import {
  ArrowLeft,
  Check,
  Film,
  GalleryVerticalEnd,
  GripVertical,
  Music,
  Pencil,
  Play,
  Settings,
  Trash2,
  X,
} from 'lucide-react';
import type { Id, MediaListItem } from '@shared/types';
import { Button } from '../../components/Button';
import { IconButton } from '../../components/IconButton';
import { ScreenHeading } from '../../components/ScreenHeading';
import { announce } from '../../lib/announce';
import { cx } from '../../lib/cx';
import { errorMessage } from '../../lib/errors-es';
import { formatDuration } from '../../lib/format';
import { invoke } from '../../lib/ipc';
import { toast } from '../../lib/toast';
import { thumbUrl } from '../../lib/vault-url';
import { setPlaylistFilter } from '../../stores/library-store';
import { useNavStore } from '../../stores/nav-store';
import {
  closePlaylist,
  loadPlaylistDetail,
  plural,
  removeFromPlaylist,
  requestDeletePlaylist,
  requestRenamePlaylist,
  setPlaylistDetailItems,
  usePlaylistSelectionStore,
  usePlaylistsStore,
} from '../../stores/playlists-store';
import { startFromPlaylist, usePresentationStore } from '../../stores/presentation-store';
import {
  tileClickAction,
  type SelectionAction,
  type SelectionState,
} from '../../stores/selection-store';
import { openViewer, useViewerStore } from '../../stores/viewer-store';
import {
  announceMoved,
  moveId,
  moveIndex,
  REORDER_INSTRUCTIONS,
  reorderAnnouncements,
  sameOrder,
} from './playlist-order';
import { PlaylistMusicDialog } from './PlaylistMusicDialog';
import { PlaylistPresentationDialog } from './PlaylistPresentationDialog';
import { PlaylistSelectionBar } from './PlaylistSelectionBar';

/** La fila solo se mueve en vertical. */
const restrictToVertical: Modifier = ({ transform }) => ({ ...transform, x: 0 });

function kindText(item: MediaListItem): string {
  if (item.kind === 'photo') return 'Foto';
  return item.durationMs === null ? 'Vídeo' : `Vídeo · ${formatDuration(item.durationMs)}`;
}

interface RowProps {
  item: MediaListItem;
  index: number;
  total: number;
  selected: boolean;
  /** Hay filas marcadas: las casillas se ven en todas. */
  selectionMode: boolean;
  registerHandle(id: string, el: HTMLButtonElement | null): void;
  registerCheckbox(id: string, el: HTMLButtonElement | null): void;
  onMove(id: string, delta: number): void;
  onRemove(item: MediaListItem): void;
  onRowClick(e: MouseEvent<HTMLLIElement>, item: MediaListItem): void;
  onRowDoubleClick(e: MouseEvent<HTMLLIElement>, item: MediaListItem): void;
  onToggle(item: MediaListItem): void;
  onOpen(row: HTMLElement, item: MediaListItem): void;
}

function SortableRow({
  item,
  index,
  total,
  selected,
  selectionMode,
  registerHandle,
  registerCheckbox,
  onMove,
  onRemove,
  onRowClick,
  onRowDoubleClick,
  onToggle,
  onOpen,
}: RowProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: item.id });

  const onHandleKeyDown = (e: KeyboardEvent<HTMLButtonElement>): void => {
    // Alt+↑/↓ mueve una posición sin levantar la fila (§14.8).
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      e.stopPropagation();
      onMove(item.id, e.key === 'ArrowUp' ? -1 : 1);
      return;
    }
    listeners?.onKeyDown?.(e);
  };

  return (
    // El clic en la fila es un atajo de ratón: la vía de teclado es la casilla de la fila (Espacio
    // alterna, Intro abre), que es un botón enfocable.
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions
    <li
      ref={setNodeRef}
      data-media-id={item.id}
      data-selected={selected ? '' : undefined}
      onClick={(e) => onRowClick(e, item)}
      onDoubleClick={(e) => onRowDoubleClick(e, item)}
      onMouseDown={(e) => {
        // Mayús+clic no debe marcar texto entre dos filas.
        if (e.shiftKey) e.preventDefault();
      }}
      style={{
        transform: transform ? `translate3d(0, ${Math.round(transform.y)}px, 0)` : undefined,
        transition,
      }}
      className={cx(
        'group relative flex cursor-pointer items-center gap-3 rounded-md border px-2 py-1.5 text-text',
        selected ? 'border-selection-border bg-selection' : 'border-border bg-surface',
        isDragging && 'z-10 border-accent bg-surface-hover shadow-md',
      )}
    >
      <button
        type="button"
        role="checkbox"
        aria-checked={selected}
        aria-label={`Seleccionar «${item.name}»`}
        data-row-control=""
        ref={(el) => registerCheckbox(item.id, el)}
        onClick={(e) => {
          e.stopPropagation();
          onToggle(item);
        }}
        onDoubleClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
          e.preventDefault();
          const row = e.currentTarget.closest('li');
          if (row) onOpen(row, item);
        }}
        className={cx(
          'inline-flex size-6 shrink-0 items-center justify-center rounded-full border-2 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100',
          selected
            ? 'border-white bg-accent opacity-100'
            : cx('border-text-muted', selectionMode ? 'opacity-100' : 'opacity-0'),
        )}
      >
        {selected ? (
          <Check aria-hidden="true" size={14} strokeWidth={3} className="text-on-accent" />
        ) : null}
      </button>
      <button
        type="button"
        data-row-control=""
        ref={(el) => {
          setActivatorNodeRef(el);
          registerHandle(item.id, el);
        }}
        {...attributes}
        {...listeners}
        onKeyDown={onHandleKeyDown}
        aria-label={`Mover «${item.name}», posición ${index + 1} de ${total}`}
        title="Arrastra, o usa Espacio y las flechas. Alt+↑/↓ mueve una posición."
        className="inline-flex h-10 w-8 shrink-0 cursor-grab touch-none items-center justify-center rounded-sm text-text-muted hover:bg-surface-hover hover:text-text active:cursor-grabbing"
      >
        <GripVertical aria-hidden="true" size={18} />
      </button>
      <span aria-hidden="true" className="w-7 shrink-0 text-right text-sm text-text-muted">
        {index + 1}
      </span>
      <img
        src={thumbUrl(item.id, item.thumbRev)}
        alt=""
        draggable={false}
        className="size-12 shrink-0 rounded-sm bg-tile-placeholder object-cover"
      />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{item.name}</p>
        <p className="flex items-center gap-1 text-xs text-text-muted">
          {item.kind === 'video' ? <Film aria-hidden="true" size={12} /> : null}
          {kindText(item)}
        </p>
      </div>
      <IconButton
        label={`Quitar «${item.name}» de la playlist`}
        icon={X}
        data-row-control=""
        onClick={() => onRemove(item)}
        onDoubleClick={(e) => e.stopPropagation()}
      />
    </li>
  );
}

export function PlaylistDetail({ id }: { id: string }) {
  const playlist = usePlaylistsStore((s) => s.playlists.find((p) => p.id === id));
  const tick = usePlaylistsStore((s) => s.tick);
  const items = usePlaylistsStore((s) => s.detail.items);
  const status = usePlaylistsStore((s) => s.detail.status);
  const loadError = usePlaylistsStore((s) => s.detail.error);
  const presentationLoading = usePresentationStore((s) => s.loading);
  const [musicOpen, setMusicOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const busy = useRef(false);
  const handles = useRef(new Map<string, HTMLButtonElement>());
  const focusAfter = useRef<string | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const dragging = useRef(false);
  const checkboxes = useRef(new Map<string, HTMLButtonElement>());
  const selected = usePlaylistSelectionStore((s) => s.selected);
  const selectionMode = selected.size > 0;
  const closedTick = useViewerStore((s) => s.closedTick);

  const load = useCallback(() => loadPlaylistDetail(id), [id]);

  useEffect(() => {
    void load();
  }, [load]);
  // library:changed (añadir desde la galería, borrar medios…): recarga si no hay un movimiento en curso.
  const firstTick = useRef(tick);
  useEffect(() => {
    if (tick === firstTick.current) return;
    firstTick.current = tick;
    if (!busy.current && !dragging.current) void load();
  }, [tick, load]);

  // Devuelve el foco al asa del elemento movido (React recoloca el nodo y puede perderlo).
  useEffect(() => {
    const target = focusAfter.current;
    if (target === null) return;
    focusAfter.current = null;
    handles.current.get(target)?.focus();
  }, [items]);

  const ids = useMemo(() => items.map((i) => i.id), [items]);
  const dispatchSelection = useCallback((action: SelectionAction): void => {
    const order = usePlaylistsStore.getState().detail.items.map((i) => i.id);
    usePlaylistSelectionStore.getState().dispatch(action, order);
  }, []);

  // En el shell XMB, Esc dentro del contenido devuelve el foco a la barra de navegación: durante
  // un arrastre con teclado, Esc solo cancela el arrastre (la rama de la selección va después de
  // comprobarlo); fuera de un arrastre, Esc limpia la selección y no hace nada más. Ctrl+A marca todo.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key === 'Escape') {
        if (dragging.current) {
          e.preventDefault();
          return;
        }
        if (usePlaylistSelectionStore.getState().selected.size === 0) return;
        e.preventDefault();
        e.stopPropagation();
        dispatchSelection({ type: 'escape' });
        return;
      }
      if (
        !dragging.current &&
        e.ctrlKey &&
        !e.altKey &&
        !e.shiftKey &&
        e.key.toLowerCase() === 'a'
      ) {
        e.preventDefault();
        dispatchSelection({ type: 'all' });
      }
    };
    list.addEventListener('keydown', onKey);
    return () => list.removeEventListener('keydown', onKey);
  }, [status, dispatchSelection]);

  const registerHandle = useCallback((itemId: string, el: HTMLButtonElement | null): void => {
    if (el) handles.current.set(itemId, el);
    else handles.current.delete(itemId);
  }, []);
  const registerCheckbox = useCallback((itemId: string, el: HTMLButtonElement | null): void => {
    if (el) checkboxes.current.set(itemId, el);
    else checkboxes.current.delete(itemId);
  }, []);

  // Al cerrar el visor, el foco vuelve a la casilla de la fila que se abrió (como en la galería).
  const lastClosedTick = useRef(closedTick);
  useEffect(() => {
    if (lastClosedTick.current === closedTick) return;
    lastClosedTick.current = closedTick;
    const closedId = useViewerStore.getState().closedId;
    if (closedId !== null) checkboxes.current.get(closedId)?.focus({ preventScroll: true });
  }, [closedTick]);

  // Instantánea de la selección antes del primer clic de un posible doble clic (ver GalleryGrid).
  const clickSnapshot = useRef<{ id: Id; state: SelectionState } | null>(null);

  /** Abre el visor sobre la lista de la playlist (FLIP desde la miniatura de la fila). */
  const openRow = useCallback((row: HTMLElement, item: MediaListItem): void => {
    const img = row.querySelector('img');
    const r = (img ?? row).getBoundingClientRect();
    const loaded = img !== null && img.complete && img.naturalWidth > 0 && img.naturalHeight > 0;
    openViewer(
      item.id,
      {
        rect: { left: r.left, top: r.top, width: r.width, height: r.height },
        radius: img ? Number.parseFloat(getComputedStyle(img).borderTopLeftRadius) || 0 : 0,
        aspect: loaded ? img.naturalWidth / img.naturalHeight : null,
      },
      'playlist',
    );
  }, []);

  const onRowClick = (e: MouseEvent<HTMLLIElement>, item: MediaListItem): void => {
    // Asa, casilla y «Quitar» no alternan la fila.
    if ((e.target as HTMLElement).closest('[data-row-control]')) return;
    const modified = e.ctrlKey || e.metaKey || e.shiftKey;
    if (e.detail >= 2 && !modified) return;
    const store = usePlaylistSelectionStore.getState();
    const action = tileClickAction(
      { ctrl: e.ctrlKey, meta: e.metaKey, shift: e.shiftKey },
      item.id,
    );
    clickSnapshot.current = {
      id: item.id,
      state: { selected: store.selected, anchor: store.anchor },
    };
    dispatchSelection(action);
  };

  const onRowDoubleClick = (e: MouseEvent<HTMLLIElement>, item: MediaListItem): void => {
    if ((e.target as HTMLElement).closest('[data-row-control]')) return;
    if (e.ctrlKey || e.metaKey || e.shiftKey || useViewerStore.getState().open) return;
    const snapshot = clickSnapshot.current;
    clickSnapshot.current = null;
    if (snapshot?.id === item.id) dispatchSelection({ type: 'restore', state: snapshot.state });
    openRow(e.currentTarget, item);
  };

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const announcements = useMemo(
    () =>
      reorderAnnouncements({
        nameOf: (itemId) => items.find((i) => i.id === itemId)?.name ?? 'Elemento',
        order: () => ids,
      }),
    [items, ids],
  );

  /** Aplica un orden nuevo: optimista, guarda con playlists:reorder y restaura si falla. */
  const applyOrder = useCallback(
    async (nextIds: readonly string[], focusId: string): Promise<void> => {
      const byId = new Map(items.map((i) => [i.id, i]));
      const next = nextIds.map((n) => byId.get(n)).filter((i): i is MediaListItem => !!i);
      focusAfter.current = focusId;
      setPlaylistDetailItems(next);
      busy.current = true;
      const res = await invoke('playlists:reorder', { id, mediaIds: [...nextIds] });
      busy.current = false;
      if (!res.ok) {
        toast(errorMessage(res.error), 'error');
        announce('No se pudo guardar el nuevo orden. Se ha restaurado el anterior.');
        focusAfter.current = focusId;
        await load();
      }
    },
    [id, items, load],
  );

  const onMove = useCallback(
    (itemId: string, delta: number): void => {
      const moved = moveId(ids, itemId, delta);
      const current = ids;
      const name = items.find((i) => i.id === itemId)?.name ?? 'Elemento';
      if (moved.from === -1) return;
      if (moved.from === moved.to) {
        announce(announceMoved(name, moved.to, current.length, false));
        return;
      }
      announce(announceMoved(name, moved.to, current.length, true));
      void applyOrder(moved.ids, itemId);
    },
    [applyOrder, ids, items],
  );

  const onDragEnd = (e: DragEndEvent): void => {
    dragging.current = false;
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const current = ids;
    const from = current.indexOf(String(active.id));
    const to = current.indexOf(String(over.id));
    const next = moveIndex(current, from, to);
    if (sameOrder(next, current)) return;
    void applyOrder(next, String(active.id));
  };

  const onRemove = (item: MediaListItem): void => {
    if (!playlist) return;
    const index = items.findIndex((i) => i.id === item.id);
    const neighbour = items[index + 1] ?? items[index - 1];
    void removeFromPlaylist(playlist, [item.id]).then((ok) => {
      if (!ok) return;
      focusAfter.current = neighbour?.id ?? null;
      setPlaylistDetailItems(
        usePlaylistsStore.getState().detail.items.filter((i) => i.id !== item.id),
      );
    });
  };

  if (!playlist) {
    return (
      <div className="flex flex-col items-start gap-3 p-8">
        <p className="text-text">Esta playlist ya no existe.</p>
        <Button onClick={closePlaylist}>Volver a Playlists</Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 p-6">
      <div>
        <Button size="sm" variant="ghost" className="-ml-2 px-2" onClick={closePlaylist}>
          <ArrowLeft aria-hidden="true" size={16} strokeWidth={1.75} />
          Playlists
        </Button>
      </div>
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex basis-full items-baseline gap-3">
          <ScreenHeading className="min-w-0 truncate text-2xl text-text">
            {playlist.name}
          </ScreenHeading>
          <p className="shrink-0 text-sm text-text-muted">
            {plural(playlist.itemCount, 'elemento', 'elementos')}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="primary"
            disabled={presentationLoading}
            onClick={() => void startFromPlaylist(playlist)}
          >
            <Play aria-hidden="true" size={16} strokeWidth={1.75} />
            Reproducir presentación
          </Button>
          <Button onClick={() => setMusicOpen(true)}>
            <Music aria-hidden="true" size={16} strokeWidth={1.75} />
            Música
          </Button>
          <Button onClick={() => setSettingsOpen(true)}>
            <Settings aria-hidden="true" size={16} strokeWidth={1.75} />
            Ajustes de presentación
          </Button>
          <Button
            onClick={() => {
              setPlaylistFilter(id);
              useNavStore.getState().navigate('gallery-all');
            }}
          >
            <GalleryVerticalEnd aria-hidden="true" size={16} strokeWidth={1.75} />
            Ver en la galería
          </Button>
          <Button onClick={() => requestRenamePlaylist(playlist)}>
            <Pencil aria-hidden="true" size={16} strokeWidth={1.75} />
            Renombrar
          </Button>
          <Button variant="danger-ghost" onClick={() => requestDeletePlaylist(playlist)}>
            <Trash2 aria-hidden="true" size={16} strokeWidth={1.75} />
            Eliminar
          </Button>
        </div>
      </header>

      {status === 'error' ? (
        <div className="flex flex-col items-start gap-3">
          <p role="alert" className="text-danger-text">
            {errorMessage(loadError)}
          </p>
          <Button onClick={() => void load()}>Reintentar</Button>
        </div>
      ) : status === 'loading' ? (
        <p role="status" className="text-text-muted">
          Cargando…
        </p>
      ) : items.length === 0 ? (
        <div className="flex flex-col items-start gap-3">
          <p className="max-w-prose text-text">
            Esta playlist está vacía. En la galería, selecciona fotos y vídeos y elige «Añadir a
            playlist».
          </p>
          <Button onClick={() => useNavStore.getState().navigate('gallery-all')}>
            Ir a la galería
          </Button>
        </div>
      ) : (
        <>
          <p className="max-w-prose text-sm text-text-muted">
            Arrastra por el asa para reordenar. Con el teclado: Tab hasta el asa, Espacio para
            levantar, flechas para mover, Espacio para soltar y Esc para cancelar. Alt+↑/↓ mueve una
            posición. Un clic marca o desmarca la fila; el doble clic o Intro abre el elemento.
          </p>
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            modifiers={[restrictToVertical]}
            accessibility={{
              announcements,
              screenReaderInstructions: { draggable: REORDER_INSTRUCTIONS },
            }}
            onDragStart={() => {
              dragging.current = true;
            }}
            onDragEnd={onDragEnd}
            onDragCancel={() => {
              dragging.current = false;
            }}
          >
            <SortableContext items={ids} strategy={verticalListSortingStrategy}>
              <ul
                ref={listRef}
                aria-label={`Elementos de «${playlist.name}»`}
                className="flex max-w-3xl flex-col gap-1.5"
              >
                {items.map((item, index) => (
                  <SortableRow
                    key={item.id}
                    item={item}
                    index={index}
                    total={items.length}
                    selected={selected.has(item.id)}
                    selectionMode={selectionMode}
                    registerHandle={registerHandle}
                    registerCheckbox={registerCheckbox}
                    onMove={onMove}
                    onRemove={onRemove}
                    onRowClick={onRowClick}
                    onRowDoubleClick={onRowDoubleClick}
                    onToggle={(row) => dispatchSelection({ type: 'toggle', id: row.id })}
                    onOpen={openRow}
                  />
                ))}
              </ul>
            </SortableContext>
          </DndContext>
          <PlaylistSelectionBar playlist={playlist} items={items} />
        </>
      )}

      <PlaylistMusicDialog playlist={playlist} open={musicOpen} onOpenChange={setMusicOpen} />
      <PlaylistPresentationDialog
        playlist={playlist}
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
      />
    </div>
  );
}
