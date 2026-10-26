// Biblioteca vista desde el renderer (docs/DESIGN.md §14.6 y §10.2): el resultado de media:list para
// la consulta actual (R13: la biblioteca entera, con el orden total de §9.2), los filtros que no se
// guardan (búsqueda y fechas) y los diálogos de renombrar y eliminar. El orden y el tamaño de las
// miniaturas viven en prefs (gallerySort, gridSize) y el tipo en la entrada activa del NavModel.
import { create } from 'zustand';
import type { AppError } from '@shared/errors';
import { DATE_MAX_MS } from '@shared/constants';
import type { Id, MediaKind, MediaListItem, MediaQuery, MediaSort } from '@shared/types';
import { announce } from '../lib/announce';
import { errorMessage } from '../lib/errors-es';
import { invoke, on } from '../lib/ipc';
import { toast } from '../lib/toast';
import { useSelectionStore } from './selection-store';

/** Filtros del usuario que no se guardan en prefs. Las fechas son "AAAA-MM-DD" (input type=date). */
export interface LibraryFilters {
  search: string;
  dateFrom: string | null;
  dateTo: string | null;
}

export const NO_FILTERS: LibraryFilters = Object.freeze({
  search: '',
  dateFrom: null,
  dateTo: null,
});

/** Debounce de la recarga tras library:changed (§10.2). */
export const RELOAD_DEBOUNCE_MS = 500;

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** 00:00:00.000 del día, en hora naive (§14.6); null si no es una fecha válida. */
export function dayStartMs(day: string | null): number | null {
  const m = day ? DAY.exec(day) : null;
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0);
  return Number.isFinite(ms) && new Date(ms).toISOString().startsWith(day as string) ? ms : null;
}

/** 23:59:59.999 del día, en hora naive. */
export function dayEndMs(day: string | null): number | null {
  const start = dayStartMs(day);
  return start === null ? null : start + 86_400_000 - 1;
}

/** "Desde" posterior a "hasta": main rechazaría la consulta (§10.3), así que no se envían. */
export function isDateRangeInvalid(filters: Pick<LibraryFilters, 'dateFrom' | 'dateTo'>): boolean {
  const from = dayStartMs(filters.dateFrom);
  const to = dayEndMs(filters.dateTo);
  return from !== null && to !== null && from > to;
}

export function buildQuery(
  kind: 'all' | MediaKind,
  filters: LibraryFilters,
  sort: MediaSort,
): MediaQuery {
  const query: MediaQuery = { kind, sort };
  const search = filters.search.trim();
  if (search) query.search = search;
  if (!isDateRangeInvalid(filters)) {
    const from = dayStartMs(filters.dateFrom);
    const to = dayEndMs(filters.dateTo);
    // main acepta fechas entre 0 y 9999-12-31 (§10.3): se recortan a ese intervalo.
    if (from !== null) query.dateFrom = Math.min(Math.max(0, from), DATE_MAX_MS);
    if (to !== null) query.dateTo = Math.min(Math.max(0, to), DATE_MAX_MS);
  }
  return query;
}

export interface LibraryState {
  items: readonly MediaListItem[];
  status: 'idle' | 'loading' | 'ready' | 'error';
  error: AppError | null;
  query: MediaQuery | null;
  filters: LibraryFilters;
  /** Diálogo "Renombrar" abierto para este elemento. */
  renameTarget: MediaListItem | null;
  /** Diálogo "Eliminar" abierto para estos ids (permanente, con confirmación). */
  deleteIds: readonly Id[] | null;
  /** Un borrado en curso (la confirmación no se puede repetir). */
  deleting: boolean;
  /** Aumenta tras cada borrado: la rejilla devuelve el foco a una celda que exista. */
  removedTick: number;
}

export const useLibraryStore = create<LibraryState>(() => ({
  items: [],
  status: 'idle',
  error: null,
  query: null,
  filters: NO_FILTERS,
  renameTarget: null,
  deleteIds: null,
  deleting: false,
  removedTick: 0,
}));

let loadSeq = 0;

/** Pide media:list y descarta la respuesta si ya hay una consulta más reciente. */
async function load(query: MediaQuery): Promise<void> {
  const seq = ++loadSeq;
  useLibraryStore.setState((s) => (s.status === 'ready' ? s : { status: 'loading' }));
  const res = await invoke('media:list', query);
  if (seq !== loadSeq) return;
  if (!res.ok) {
    useLibraryStore.setState({ status: 'error', error: res.error });
    return;
  }
  const items = res.data.items;
  useLibraryStore.setState({ items, status: 'ready', error: null });
  // Si cambia la consulta, se conserva la intersección con el resultado nuevo (§14.6).
  useSelectionStore.getState().dispatch(
    { type: 'intersect' },
    items.map((i) => i.id),
  );
}

/** Fija la consulta actual y la carga. No hace nada si no ha cambiado. */
export function setLibraryQuery(query: MediaQuery): void {
  const current = useLibraryStore.getState().query;
  if (current && JSON.stringify(current) === JSON.stringify(query)) return;
  useLibraryStore.setState({ query });
  void load(query);
}

export function reloadLibrary(): void {
  const query = useLibraryStore.getState().query;
  if (query) void load(query);
}

export function setFilters(patch: Partial<LibraryFilters>): void {
  useLibraryStore.setState((s) => ({ filters: { ...s.filters, ...patch } }));
}

export function clearFilters(): void {
  useLibraryStore.setState({ filters: NO_FILTERS });
}

/** library:changed → recarga con un debounce de 500 ms desde el último evento (§10.2). */
export function subscribeLibrary(): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const off = on('library:changed', () => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      reloadLibrary();
    }, RELOAD_DEBOUNCE_MS);
  });
  return () => {
    off();
    if (timer !== null) clearTimeout(timer);
  };
}

// ── Renombrar y eliminar ───────────────────────────────────────────────────────────────────────

export function requestRename(item: MediaListItem): void {
  useLibraryStore.setState({ renameTarget: item });
}

export function cancelRename(): void {
  useLibraryStore.setState({ renameTarget: null });
}

/** media:rename. Devuelve el error para que el diálogo lo muestre, o null si fue bien. */
export async function renameItem(id: Id, name: string): Promise<AppError | null> {
  const res = await invoke('media:rename', { id, name });
  if (!res.ok) return res.error;
  useLibraryStore.setState((s) => ({
    items: s.items.map((i) => (i.id === id ? res.data : i)),
    renameTarget: null,
  }));
  announce(`Renombrado a ${res.data.name}`);
  // El orden puede cambiar (por nombre) o el filtro dejar de coincidir: recarga la consulta.
  reloadLibrary();
  return null;
}

export function requestDelete(ids: readonly Id[]): void {
  if (ids.length > 0) useLibraryStore.setState({ deleteIds: ids });
}

export function cancelDelete(): void {
  if (!useLibraryStore.getState().deleting) useLibraryStore.setState({ deleteIds: null });
}

/** media:delete tras la confirmación. Permanente (§12.10). */
export async function confirmDelete(): Promise<void> {
  const ids = useLibraryStore.getState().deleteIds;
  if (!ids || useLibraryStore.getState().deleting) return;
  useLibraryStore.setState({ deleting: true });
  const res = await invoke('media:delete', { ids: [...ids] });
  useLibraryStore.setState({ deleting: false, deleteIds: null });
  if (!res.ok) {
    toast(errorMessage(res.error), 'error');
    return;
  }
  const n = res.data.deleted;
  const message = n === 1 ? 'Se eliminó 1 elemento.' : `Se eliminaron ${n} elementos.`;
  toast(message);
  announce(message);
  const removed = new Set(ids);
  const items = useLibraryStore.getState().items.filter((i) => !removed.has(i.id));
  useLibraryStore.setState((s) => ({ items, removedTick: s.removedTick + 1 }));
  useSelectionStore.getState().dispatch(
    { type: 'intersect' },
    items.map((i) => i.id),
  );
  reloadLibrary();
}
