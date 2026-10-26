// Modelo puro de la rejilla de la galería (docs/DESIGN.md §14.6): filas de cabecera de mes y de
// mosaicos, y navegación con el teclado sobre ellas. Sin React ni DOM.
import type { MediaListItem } from '@shared/types';

/** Mosaicos de 120, 180 (por defecto) o 260 px CSS según `prefs.gridSize`. */
export const TILE_SIZES = { small: 120, medium: 180, large: 260 } as const;
export type GridSize = keyof typeof TILE_SIZES;

/** Qué fecha agrupa por mes: la de captura (hora naive) o la de importación (hora local). */
export type GridGrouping = 'captured' | 'imported' | null;

export type GridRow =
  | { kind: 'header'; key: string; label: string }
  | { kind: 'tiles'; key: string; start: number; count: number };

export interface GridModel {
  rows: readonly GridRow[];
  /** Fila en la que está cada elemento (por su posición en el resultado). */
  rowOfItem: Int32Array;
}

/** Columnas: floor((ancho + gap) / (tamaño + gap)), al menos una. */
export function columnsFor(width: number, size: number, gap: number): number {
  if (!Number.isFinite(width) || width <= 0) return 1;
  return Math.max(1, Math.floor((width + gap) / (size + gap)));
}

const MONTH_FORMAT = new Intl.DateTimeFormat('es', {
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});

/** Año y mes (0–11) de una fecha: los componentes "de pared" de captured_at (§12.8) o los locales. */
function monthOf(ms: number, naive: boolean): { year: number; month: number } {
  const d = new Date(ms);
  return naive
    ? { year: d.getUTCFullYear(), month: d.getUTCMonth() }
    : { year: d.getFullYear(), month: d.getMonth() };
}

/** "octubre de 2026". */
export function monthLabel(year: number, month: number): string {
  return MONTH_FORMAT.format(Date.UTC(year, month, 1));
}

/**
 * Filas de la rejilla: con `grouping`, una cabecera por cada cambio de mes (el resultado ya viene
 * ordenado por esa fecha) y los mosaicos de cada mes en filas de `cols`; sin él, una lista plana.
 */
export function buildGrid(
  items: readonly Pick<MediaListItem, 'capturedAt' | 'importedAt'>[],
  cols: number,
  grouping: GridGrouping,
): GridModel {
  const perRow = Math.max(1, Math.floor(cols));
  const rows: GridRow[] = [];
  const rowOfItem = new Int32Array(items.length);
  const pushTiles = (from: number, to: number): void => {
    for (let start = from; start < to; start += perRow) {
      const count = Math.min(perRow, to - start);
      const row = rows.length;
      rows.push({ kind: 'tiles', key: `t${start}`, start, count });
      rowOfItem.fill(row, start, start + count);
    }
  };
  if (grouping === null) {
    pushTiles(0, items.length);
    return { rows, rowOfItem };
  }
  let groupStart = 0;
  let current = '';
  for (let i = 0; i <= items.length; i += 1) {
    const item = items[i];
    const part =
      item === undefined
        ? null
        : monthOf(
            grouping === 'captured' ? item.capturedAt : item.importedAt,
            grouping === 'captured',
          );
    const key = part ? `${part.year}-${part.month}` : '';
    if (i === items.length || key !== current) {
      if (i > groupStart) pushTiles(groupStart, i);
      if (part) {
        rows.push({ kind: 'header', key: `h${key}`, label: monthLabel(part.year, part.month) });
        groupStart = i;
        current = key;
      }
    }
  }
  return { rows, rowOfItem };
}

export type GridKey =
  'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown' | 'Home' | 'End' | 'PageUp' | 'PageDown';

export function isGridKey(key: string): key is GridKey {
  return [
    'ArrowLeft',
    'ArrowRight',
    'ArrowUp',
    'ArrowDown',
    'Home',
    'End',
    'PageUp',
    'PageDown',
  ].includes(key);
}

/** Fila de mosaicos anterior (-1) o siguiente (+1) a `row`, saltando las cabeceras; -1 si no hay. */
function tileRowFrom(rows: readonly GridRow[], row: number, step: 1 | -1): number {
  for (let r = row + step; r >= 0 && r < rows.length; r += step) {
    if (rows[r]?.kind === 'tiles') return r;
  }
  return -1;
}

function moveVertical(model: GridModel, index: number, step: 1 | -1): number {
  const row = model.rows[model.rowOfItem[index] as number];
  if (row?.kind !== 'tiles') return index;
  const col = index - row.start;
  const target = model.rows[tileRowFrom(model.rows, model.rowOfItem[index] as number, step)];
  if (target?.kind !== 'tiles') return index;
  return target.start + Math.min(col, target.count - 1);
}

/**
 * Elemento al que va el foco con una tecla de navegación (§14.6): flechas, Home/End (principio y
 * final de la fila; con Ctrl, de todo), RePág/AvPág (`pageRows` filas de mosaicos). Las flechas
 * arriba y abajo conservan la columna y se recortan a la última de una fila más corta.
 */
export function moveFocus(
  model: GridModel,
  index: number,
  key: GridKey,
  options: { ctrl?: boolean; pageRows?: number } = {},
): number {
  const count = model.rowOfItem.length;
  if (count === 0) return -1;
  const at = Math.min(Math.max(index, 0), count - 1);
  const row = model.rows[model.rowOfItem[at] as number];
  switch (key) {
    case 'ArrowLeft':
      return Math.max(0, at - 1);
    case 'ArrowRight':
      return Math.min(count - 1, at + 1);
    case 'ArrowUp':
      return moveVertical(model, at, -1);
    case 'ArrowDown':
      return moveVertical(model, at, 1);
    case 'Home':
      return options.ctrl || row?.kind !== 'tiles' ? 0 : row.start;
    case 'End':
      return options.ctrl || row?.kind !== 'tiles' ? count - 1 : row.start + row.count - 1;
    case 'PageUp':
    case 'PageDown': {
      const step = key === 'PageUp' ? -1 : 1;
      let next = at;
      for (let i = 0; i < Math.max(1, options.pageRows ?? 1); i += 1) {
        const moved = moveVertical(model, next, step);
        if (moved === next) break;
        next = moved;
      }
      return next;
    }
  }
}
