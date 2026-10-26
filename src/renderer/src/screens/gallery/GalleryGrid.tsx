// Rejilla virtualizada de la galería (docs/DESIGN.md §14.6): TanStack Virtual sobre filas (cabeceras
// de mes solo al ordenar por fecha, mosaicos cuadrados de 120/180/260 px), `role="grid"` con una
// sola parada de Tab (roving tabindex), selección con Ctrl/Shift/Ctrl+A, atajos de teclado y menú
// contextual. En esta fase un clic o Enter seleccionan (el visor llega en F3).
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from 'react';
import { defaultRangeExtractor, useVirtualizer, type Range } from '@tanstack/react-virtual';
import { Check, Film } from 'lucide-react';
import { ContextMenu } from 'radix-ui';
import type { Id, MediaListItem } from '@shared/types';
import { cx } from '../../lib/cx';
import { formatDuration } from '../../lib/format';
import { thumbUrl } from '../../lib/vault-url';
import { requestDelete, requestRename, useLibraryStore } from '../../stores/library-store';
import { useSelectionStore, type SelectionAction } from '../../stores/selection-store';
import { useTheme } from '../../themes/use-theme';
import { focusGalleryCell } from './gallery-focus';
import {
  buildGrid,
  columnsFor,
  isGridKey,
  moveFocus,
  TILE_SIZES,
  type GridGrouping,
  type GridSize,
} from './grid-model';

/** Alto de la fila de la cabecera de mes (px). */
const HEADER_HEIGHT = 44;
const ARROWS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']);

const MENU_CONTENT =
  'z-50 min-w-52 rounded-md border border-border bg-bg-elevated p-1 text-text shadow-md';
const MENU_ITEM =
  'flex h-9 cursor-default items-center justify-between gap-6 rounded-sm px-3 text-sm outline-none data-disabled:opacity-50 data-highlighted:bg-surface-hover data-highlighted:outline-2 data-highlighted:outline-focus-ring';

function parseGap(value: string | undefined): number {
  const px = Number.parseFloat(value ?? '');
  return Number.isFinite(px) ? px : 4;
}

export interface GalleryGridProps {
  items: readonly MediaListItem[];
  size: GridSize;
  grouping: GridGrouping;
}

function cellLabel(item: MediaListItem): string {
  if (item.kind !== 'video') return item.name;
  return item.durationMs === null
    ? `${item.name}, vídeo`
    : `${item.name}, vídeo, ${formatDuration(item.durationMs)}`;
}

export function GalleryGrid({ items, size, grouping }: GalleryGridProps) {
  const theme = useTheme();
  const gap = parseGap(theme.def.tokens[theme.scheme]?.['tile-gap']);
  const tile = TILE_SIZES[size];
  const selected = useSelectionStore((s) => s.selected);
  const removedTick = useLibraryStore((s) => s.removedTick);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const cols = columnsFor(width, tile, gap);
  const model = useMemo(() => buildGrid(items, cols, grouping), [items, cols, grouping]);
  const ids = useMemo(() => items.map((i) => i.id), [items]);

  // Roving tabindex: la celda con el foco (o la última que lo tuvo) es la única parada de Tab.
  const [focusIndex, setFocusIndex] = useState(0);
  const active = Math.max(0, Math.min(focusIndex, items.length - 1));
  const pendingFocus = useRef(false);

  const rangeExtractor = useCallback(
    (range: Range): number[] => {
      const base = defaultRangeExtractor(range);
      // La fila de la celda activa se mantiene montada aunque salga de la vista: si no, no habría
      // ninguna parada de Tab.
      const keep = model.rowOfItem[active];
      if (keep === undefined || base.includes(keep)) return base;
      return [...base, keep].sort((a, b) => a - b);
    },
    [model, active],
  );

  // El proyecto no usa React Compiler; el aviso de react-hooks/incompatible-library no aplica.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: model.rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (model.rows[i]?.kind === 'header' ? HEADER_HEIGHT : tile + gap),
    getItemKey: (i) => model.rows[i]?.key ?? i,
    overscan: 3,
    rangeExtractor,
  });
  useEffect(() => {
    virtualizer.measure();
  }, [virtualizer, model, tile, gap]);

  // Mueve el foco DOM a la celda activa cuando ya está montada (tras un scrollToIndex).
  useEffect(() => {
    if (!pendingFocus.current) return;
    const cell = scrollRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    if (!cell) return;
    pendingFocus.current = false;
    cell.focus({ preventScroll: true });
  });

  // Tras un borrado, la celda enfocada puede haber desaparecido: el foco pasa a la que ocupa su sitio.
  const lastRemovedTick = useRef(removedTick);
  useEffect(() => {
    if (lastRemovedTick.current === removedTick) return;
    lastRemovedTick.current = removedTick;
    pendingFocus.current = true;
  }, [removedTick]);

  const focusItem = useCallback(
    (index: number): void => {
      setFocusIndex(index);
      pendingFocus.current = true;
      const row = model.rowOfItem[index];
      if (row !== undefined) virtualizer.scrollToIndex(row, { align: 'auto' });
    },
    [model, virtualizer],
  );

  // Esc limpia la selección antes de que lo vea el shell (en Ondas, Esc en el contenido devuelve el
  // foco a la barra XMB; con una selección, primero hay que limpiarla).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onKeyDown = (e: globalThis.KeyboardEvent): void => {
      if (e.key !== 'Escape' || useSelectionStore.getState().selected.size === 0) return;
      e.preventDefault();
      e.stopPropagation();
      useSelectionStore.getState().dispatch({ type: 'escape' }, []);
    };
    el.addEventListener('keydown', onKeyDown);
    return () => el.removeEventListener('keydown', onKeyDown);
  }, []);

  const dispatch = (action: SelectionAction): void =>
    useSelectionStore.getState().dispatch(action, ids);

  const onCellClick = (e: MouseEvent, item: MediaListItem): void => {
    if (e.ctrlKey || e.metaKey) dispatch({ type: 'ctrl', id: item.id });
    else if (e.shiftKey) dispatch({ type: 'shift', id: item.id });
    else dispatch({ type: 'click', id: item.id });
  };

  const renameTargetFor = (item: MediaListItem): MediaListItem | null => {
    const sel = useSelectionStore.getState().selected;
    if (sel.size === 0) return item;
    if (sel.size === 1) return items.find((i) => sel.has(i.id)) ?? null;
    return null;
  };

  const deleteIdsFor = (item: MediaListItem): Id[] => {
    const sel = useSelectionStore.getState().selected;
    return sel.size > 0 ? [...sel] : [item.id];
  };

  const onCellKeyDown = (e: KeyboardEvent<HTMLDivElement>, index: number): void => {
    const item = items[index];
    if (!item) return;
    if (isGridKey(e.key)) {
      e.preventDefault();
      const page = Math.floor((scrollRef.current?.clientHeight ?? 600) / (tile + gap)) - 1;
      const next = moveFocus(model, index, e.key, { ctrl: e.ctrlKey, pageRows: page });
      const target = items[next];
      if (!target) return;
      if (e.shiftKey && ARROWS.has(e.key)) {
        // Mayús+flechas amplía la selección desde el ancla (la celda actual si no hay ninguna).
        if (useSelectionStore.getState().anchor === null) dispatch({ type: 'click', id: item.id });
        dispatch({ type: 'shift', id: target.id });
      }
      focusItem(next);
      return;
    }
    if (e.ctrlKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      dispatch({ type: 'all' });
      return;
    }
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    switch (e.key) {
      case ' ':
        e.preventDefault();
        dispatch({ type: 'ctrl', id: item.id });
        break;
      case 'Enter':
        e.preventDefault();
        dispatch({ type: 'click', id: item.id });
        break;
      case 'F2': {
        e.preventDefault();
        const target = renameTargetFor(item);
        if (target) requestRename(target);
        break;
      }
      case 'Delete':
        e.preventDefault();
        requestDelete(deleteIdsFor(item));
        break;
    }
  };

  // Clic derecho (o tecla Menú / Mayús+F10, que Chromium convierte en `contextmenu` sobre la celda
  // enfocada): si la celda no estaba seleccionada, pasa a ser la única selección antes de abrir el menú.
  const onContextMenu = (e: MouseEvent): void => {
    const cell = (e.target as HTMLElement).closest<HTMLElement>('[data-index]');
    const item = cell ? items[Number(cell.dataset.index)] : undefined;
    if (item && !useSelectionStore.getState().selected.has(item.id)) {
      dispatch({ type: 'click', id: item.id });
    }
  };

  // Ctrl+A con el foco en la propia rejilla (un hueco, tras pulsar fuera de las celdas): las celdas ya
  // lo atienden y marcan el evento como gestionado.
  const onGridKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.defaultPrevented || e.target !== e.currentTarget) return;
    if (e.ctrlKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      dispatch({ type: 'all' });
    }
  };

  const onlyOne = selected.size === 1;
  const rows = model.rows;

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <div
          ref={scrollRef}
          role="grid"
          data-gallery-grid=""
          tabIndex={-1}
          aria-label="Galería"
          aria-multiselectable="true"
          aria-rowcount={rows.length}
          aria-colcount={cols}
          onContextMenu={onContextMenu}
          onKeyDown={onGridKeyDown}
          className="absolute inset-0 overflow-auto p-3"
        >
          <div
            role="rowgroup"
            className="relative w-full"
            style={{ height: virtualizer.getTotalSize() }}
          >
            {virtualizer.getVirtualItems().map((v) => {
              const row = rows[v.index];
              if (!row) return null;
              return (
                <div
                  key={v.key}
                  role="row"
                  aria-rowindex={v.index + 1}
                  className="absolute top-0 left-0 flex w-full"
                  style={{ transform: `translateY(${v.start}px)`, height: v.size, gap }}
                >
                  {row.kind === 'header' ? (
                    <div
                      role="rowheader"
                      aria-colspan={cols}
                      className="self-end pb-2 text-lg font-semibold text-text"
                    >
                      {row.label}
                    </div>
                  ) : (
                    Array.from({ length: row.count }, (_, c) => {
                      const index = row.start + c;
                      const item = items[index];
                      if (!item) return null;
                      const isSelected = selected.has(item.id);
                      return (
                        <div
                          key={item.id}
                          role="gridcell"
                          data-index={index}
                          aria-selected={isSelected}
                          aria-label={cellLabel(item)}
                          tabIndex={index === active ? 0 : -1}
                          onFocus={() => setFocusIndex(index)}
                          onClick={(e) => onCellClick(e, item)}
                          onMouseDown={(e) => {
                            // Mayús+clic no debe marcar texto entre dos celdas.
                            if (e.shiftKey) e.preventDefault();
                          }}
                          onKeyDown={(e) => onCellKeyDown(e, index)}
                          className="group relative shrink-0 overflow-hidden rounded-tile bg-tile-placeholder"
                          style={{ width: tile, height: tile }}
                        >
                          <img
                            src={thumbUrl(item.id, item.thumbRev)}
                            alt={item.name}
                            loading="lazy"
                            decoding="async"
                            className="size-full object-cover"
                          />
                          {item.kind === 'video' ? (
                            <span className="pointer-events-none absolute right-1.5 bottom-1.5 inline-flex items-center gap-1 rounded-sm bg-black/70 px-1.5 py-0.5 text-xs text-white">
                              <Film aria-hidden="true" size={12} />
                              {item.durationMs === null ? 'Vídeo' : formatDuration(item.durationMs)}
                            </span>
                          ) : null}
                          {isSelected ? (
                            <span className="pointer-events-none absolute inset-0 border-[3px] border-selection-border bg-selection" />
                          ) : null}
                          <button
                            type="button"
                            role="checkbox"
                            aria-checked={isSelected}
                            aria-label={`Seleccionar ${item.name}`}
                            tabIndex={-1}
                            onClick={(e) => {
                              e.stopPropagation();
                              dispatch({ type: 'ctrl', id: item.id });
                            }}
                            className={cx(
                              'absolute top-1.5 left-1.5 inline-flex size-6 items-center justify-center rounded-full border-2 border-white text-white transition-opacity group-focus-within:opacity-100 group-hover:opacity-100',
                              isSelected ? 'bg-accent opacity-100' : 'bg-black/50 opacity-0',
                            )}
                          >
                            {isSelected ? (
                              <Check
                                aria-hidden="true"
                                size={14}
                                strokeWidth={3}
                                className="text-on-accent"
                              />
                            ) : null}
                          </button>
                        </div>
                      );
                    })
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content
          className={MENU_CONTENT}
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            focusGalleryCell();
          }}
        >
          <ContextMenu.Item
            disabled={!onlyOne}
            className={MENU_ITEM}
            onSelect={() => {
              const only = items.find((i) => selected.has(i.id));
              if (only) requestRename(only);
            }}
          >
            Renombrar
            <span className="text-xs text-text-muted">F2</span>
          </ContextMenu.Item>
          <ContextMenu.Item
            disabled={selected.size === 0}
            className={MENU_ITEM}
            onSelect={() => requestDelete([...selected])}
          >
            Eliminar
            <span className="text-xs text-text-muted">Supr</span>
          </ContextMenu.Item>
          <ContextMenu.Separator className="my-1 h-px bg-border" />
          <ContextMenu.Item className={MENU_ITEM} onSelect={() => dispatch({ type: 'all' })}>
            Seleccionar todo
            <span className="text-xs text-text-muted">Ctrl+A</span>
          </ContextMenu.Item>
          <ContextMenu.Item
            disabled={selected.size === 0}
            className={MENU_ITEM}
            onSelect={() => dispatch({ type: 'escape' })}
          >
            Cancelar selección
            <span className="text-xs text-text-muted">Esc</span>
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
