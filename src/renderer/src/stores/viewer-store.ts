// Visor (docs/DESIGN.md §16.1): qué medio está abierto y desde qué mosaico. La lista de navegación
// es el resultado actual de la galería (library-store) o, si se abrió desde el detalle de una playlist
// (`source: 'playlist'`, PLAN.md nota 194), los elementos de esa playlist en su orden. `open` sigue
// siendo true durante la animación de cierre; `closedTick` avisa a la rejilla de que debe devolver el
// foco al mosaico.
import { create } from 'zustand';
import type { Id, MediaListItem } from '@shared/types';
import { useLibraryStore } from './library-store';
import { usePlaylistsStore } from './playlists-store';

/** De dónde sale la lista por la que navega el visor. */
export type ViewerSource = 'library' | 'playlist';

/** Mosaico desde el que se abrió el visor (para la animación FLIP). */
export interface ViewerOrigin {
  rect: { left: number; top: number; width: number; height: number };
  /** Radio de las esquinas del mosaico (px). */
  radius: number;
  /** Proporción de la miniatura ya cargada en el mosaico (la de la foto editada), si se conoce. */
  aspect: number | null;
}

interface ViewerState {
  open: boolean;
  source: ViewerSource;
  currentId: Id | null;
  /** Solo para la primera capa: al navegar se descarta. */
  origin: ViewerOrigin | null;
  /** Aumenta al cerrar: la rejilla enfoca el mosaico de `closedId`. */
  closedTick: number;
  closedId: Id | null;
}

export const useViewerStore = create<ViewerState>(() => ({
  open: false,
  source: 'library',
  currentId: null,
  origin: null,
  closedTick: 0,
  closedId: null,
}));

export function openViewer(
  id: Id,
  origin: ViewerOrigin | null,
  source: ViewerSource = 'library',
): void {
  useViewerStore.setState({ open: true, currentId: id, origin, source });
}

/** La lista por la que navega el visor (galería o playlist abierta). */
export function useViewerItems(): readonly MediaListItem[] {
  const source = useViewerStore((s) => s.source);
  const library = useLibraryStore((s) => s.items);
  const playlist = usePlaylistsStore((s) => s.detail.items);
  return source === 'playlist' ? playlist : library;
}

export function setViewerCurrent(id: Id): void {
  useViewerStore.setState({ currentId: id, origin: null });
}

/** Termina el cierre (ya sin animación) y pide a la rejilla que enfoque el mosaico actual. */
export function finishViewerClose(): void {
  useViewerStore.setState((s) => ({
    open: false,
    source: 'library',
    origin: null,
    closedTick: s.closedTick + 1,
    closedId: s.currentId,
    currentId: null,
  }));
}

export function isViewerOpen(): boolean {
  return useViewerStore.getState().open;
}

/** Devuelve el foco al diálogo del visor (por ejemplo, al cerrar la confirmación de borrado). */
export function focusViewer(): boolean {
  const dialog = document.querySelector<HTMLElement>('[data-viewer]');
  if (!dialog) return false;
  dialog.focus({ preventScroll: true });
  return true;
}
