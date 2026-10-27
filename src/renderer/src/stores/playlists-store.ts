// Playlists vistas desde el renderer (docs/DESIGN.md §14.8 y §10.2): la lista (nombre, recuento y
// portada), la playlist abierta en la pantalla Playlists y los diálogos de crear, renombrar y
// eliminar. Las acciones hablan con main por IPC y avisan con toast + región aria-live. Todo vive en
// la DB cifrada; aquí solo hay copias en memoria que se descartan al bloquear.
import { create } from 'zustand';
import type { AppError } from '@shared/errors';
import type { Id, MediaListItem, PlaylistSummary } from '@shared/types';
import { announce } from '../lib/announce';
import { errorMessage } from '../lib/errors-es';
import { invoke, on } from '../lib/ipc';
import { toast } from '../lib/toast';
import { reloadLibrary, setPlaylistFilter, useLibraryStore } from './library-store';

export type PlaylistDialog =
  /** `mediaIds`: elementos que se añaden a la playlist nueva (desde la selección de la galería). */
  | { kind: 'create'; mediaIds: readonly Id[] }
  | { kind: 'rename'; playlist: PlaylistSummary }
  | { kind: 'delete'; playlist: PlaylistSummary };

/** Los elementos de la playlist abierta, en su orden (media:list con position). */
export interface PlaylistDetailState {
  id: Id | null;
  items: readonly MediaListItem[];
  status: 'loading' | 'ready' | 'error';
  error: AppError | null;
}

const NO_DETAIL: PlaylistDetailState = Object.freeze({
  id: null,
  items: [],
  status: 'loading',
  error: null,
});

export interface PlaylistsState {
  playlists: readonly PlaylistSummary[];
  status: 'idle' | 'loading' | 'ready' | 'error';
  error: AppError | null;
  /** Playlist abierta en la pantalla Playlists (null = la lista de tarjetas). */
  openId: Id | null;
  dialog: PlaylistDialog | null;
  /** Un borrado en curso (la confirmación no se puede repetir). */
  deleting: boolean;
  detail: PlaylistDetailState;
  /** Aumenta con cada library:changed: el detalle de la playlist abierta recarga sus elementos. */
  tick: number;
}

const INITIAL: PlaylistsState = {
  playlists: [],
  status: 'idle',
  error: null,
  openId: null,
  dialog: null,
  deleting: false,
  detail: NO_DETAIL,
  tick: 0,
};

export const usePlaylistsStore = create<PlaylistsState>(() => INITIAL);

export function resetPlaylists(): void {
  usePlaylistsStore.setState({ ...INITIAL });
}

export function playlistById(id: Id | null): PlaylistSummary | undefined {
  return id === null ? undefined : usePlaylistsStore.getState().playlists.find((p) => p.id === id);
}

export function plural(n: number, one: string, many: string): string {
  return n === 1 ? `1 ${one}` : `${n} ${many}`;
}

let loadSeq = 0;

export async function loadPlaylists(): Promise<void> {
  const seq = ++loadSeq;
  const res = await invoke('playlists:list');
  if (seq !== loadSeq) return;
  if (!res.ok) {
    usePlaylistsStore.setState({ status: 'error', error: res.error });
    return;
  }
  const playlists = res.data;
  usePlaylistsStore.setState((s) => ({
    playlists,
    status: 'ready',
    error: null,
    // La playlist abierta o usada como filtro ya no existe (borrada desde otro sitio).
    openId: s.openId !== null && playlists.some((p) => p.id === s.openId) ? s.openId : null,
  }));
  const filtered = useLibraryStore.getState().filters.playlistId;
  if (filtered !== null && !playlists.some((p) => p.id === filtered)) setPlaylistFilter(null);
}

/** library:changed → recarga la lista y avisa al detalle abierto (con un debounce corto). */
export function subscribePlaylists(): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const off = on('library:changed', () => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      usePlaylistsStore.setState((s) => ({ tick: s.tick + 1 }));
      void loadPlaylists();
    }, 250);
  });
  return () => {
    off();
    if (timer !== null) clearTimeout(timer);
  };
}

export function openPlaylist(id: Id): void {
  usePlaylistsStore.setState({ openId: id, detail: { ...NO_DETAIL, id } });
}

export function closePlaylist(): void {
  usePlaylistsStore.setState({ openId: null, detail: NO_DETAIL });
}

let detailSeq = 0;

/** Carga los elementos de la playlist abierta en su orden (media:list con position). */
export async function loadPlaylistDetail(id: Id): Promise<void> {
  const seq = ++detailSeq;
  const res = await invoke('media:list', {
    kind: 'all',
    playlistId: id,
    sort: { field: 'position', dir: 'asc' },
  });
  if (seq !== detailSeq || usePlaylistsStore.getState().openId !== id) return;
  usePlaylistsStore.setState({
    detail: res.ok
      ? { id, items: res.data.items, status: 'ready', error: null }
      : { id, items: [], status: 'error', error: res.error },
  });
}

/** Cambia los elementos mostrados (reordenar u quitar de forma optimista). */
export function setPlaylistDetailItems(items: readonly MediaListItem[]): void {
  usePlaylistsStore.setState((s) => ({ detail: { ...s.detail, items } }));
}

// ── Diálogos ───────────────────────────────────────────────────────────────────────────────────

export function requestCreatePlaylist(mediaIds: readonly Id[] = []): void {
  usePlaylistsStore.setState({ dialog: { kind: 'create', mediaIds } });
}

export function requestRenamePlaylist(playlist: PlaylistSummary): void {
  usePlaylistsStore.setState({ dialog: { kind: 'rename', playlist } });
}

export function requestDeletePlaylist(playlist: PlaylistSummary): void {
  usePlaylistsStore.setState({ dialog: { kind: 'delete', playlist } });
}

export function closePlaylistDialog(): void {
  if (!usePlaylistsStore.getState().deleting) usePlaylistsStore.setState({ dialog: null });
}

// ── Acciones ───────────────────────────────────────────────────────────────────────────────────

/** Texto del resultado de añadir elementos a una playlist (`alreadyPresent` ya estaban). */
export function addedMessage(name: string, added: number, alreadyPresent: number): string {
  if (added === 0) {
    return alreadyPresent === 1
      ? `Ese elemento ya estaba en «${name}».`
      : `Esos ${alreadyPresent} elementos ya estaban en «${name}».`;
  }
  const base =
    added === 1
      ? `Se añadió 1 elemento a «${name}».`
      : `Se añadieron ${added} elementos a «${name}».`;
  if (alreadyPresent === 0) return base;
  return `${base} ${alreadyPresent === 1 ? '1 ya estaba.' : `${alreadyPresent} ya estaban.`}`;
}

/** playlists:addItems con aviso. Devuelve true si main aceptó la petición. */
export async function addToPlaylist(
  playlist: Pick<PlaylistSummary, 'id' | 'name'>,
  mediaIds: readonly Id[],
): Promise<boolean> {
  if (mediaIds.length === 0) return false;
  const res = await invoke('playlists:addItems', { id: playlist.id, mediaIds: [...mediaIds] });
  if (!res.ok) {
    toast(errorMessage(res.error), 'error');
    return false;
  }
  const message = addedMessage(playlist.name, res.data.added, res.data.alreadyPresent);
  toast(message);
  announce(message);
  void loadPlaylists();
  return true;
}

/** playlists:removeItems con aviso; recarga la galería filtrada. */
export async function removeFromPlaylist(
  playlist: Pick<PlaylistSummary, 'id' | 'name'>,
  mediaIds: readonly Id[],
): Promise<boolean> {
  if (mediaIds.length === 0) return false;
  const res = await invoke('playlists:removeItems', { id: playlist.id, mediaIds: [...mediaIds] });
  if (!res.ok) {
    toast(errorMessage(res.error), 'error');
    return false;
  }
  const n = res.data.removed;
  const message =
    n === 1
      ? `Se quitó 1 elemento de «${playlist.name}». Sigue en la galería.`
      : `Se quitaron ${n} elementos de «${playlist.name}». Siguen en la galería.`;
  toast(message);
  announce(message);
  void loadPlaylists();
  reloadLibrary();
  return true;
}

/**
 * Crear (y, si hay `mediaIds`, añadir) o renombrar. Devuelve el error para que el diálogo lo
 * muestre, o null si fue bien (el diálogo se cierra).
 */
export async function submitPlaylistName(name: string): Promise<AppError | null> {
  const dialog = usePlaylistsStore.getState().dialog;
  if (!dialog || dialog.kind === 'delete') return null;
  if (dialog.kind === 'rename') {
    const res = await invoke('playlists:rename', { id: dialog.playlist.id, name });
    if (!res.ok) return res.error;
    const renamed = res.data;
    usePlaylistsStore.setState((s) => ({
      playlists: s.playlists.map((p) => (p.id === renamed.id ? renamed : p)),
      dialog: null,
    }));
    announce(`Playlist renombrada a «${renamed.name}».`);
    void loadPlaylists();
    return null;
  }
  const res = await invoke('playlists:create', { name });
  if (!res.ok) return res.error;
  const created = res.data;
  usePlaylistsStore.setState((s) => ({ playlists: [...s.playlists, created], dialog: null }));
  if (dialog.mediaIds.length > 0) {
    await addToPlaylist(created, dialog.mediaIds);
  } else {
    announce(`Playlist «${created.name}» creada.`);
    toast(`Playlist «${created.name}» creada.`);
  }
  void loadPlaylists();
  return null;
}

/** playlists:delete tras la confirmación. Borra la playlist, nunca los medios. */
export async function confirmDeletePlaylist(): Promise<void> {
  const { dialog, deleting } = usePlaylistsStore.getState();
  if (!dialog || dialog.kind !== 'delete' || deleting) return;
  const { playlist } = dialog;
  usePlaylistsStore.setState({ deleting: true });
  const res = await invoke('playlists:delete', { id: playlist.id });
  usePlaylistsStore.setState({ deleting: false, dialog: null });
  if (!res.ok) {
    toast(errorMessage(res.error), 'error');
    return;
  }
  const message = `Playlist «${playlist.name}» eliminada. Las fotos y los vídeos siguen en la galería.`;
  toast(message);
  announce(message);
  usePlaylistsStore.setState((s) => ({
    playlists: s.playlists.filter((p) => p.id !== playlist.id),
    openId: s.openId === playlist.id ? null : s.openId,
  }));
  if (useLibraryStore.getState().filters.playlistId === playlist.id) setPlaylistFilter(null);
  void loadPlaylists();
}
