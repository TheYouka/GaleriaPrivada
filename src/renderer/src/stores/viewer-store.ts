// Visor (docs/DESIGN.md §16.1): qué medio está abierto y desde qué mosaico. La lista de navegación
// es el resultado actual de la galería (library-store). `open` sigue siendo true durante la
// animación de cierre; `closedTick` avisa a la rejilla de que debe devolver el foco al mosaico.
import { create } from 'zustand';
import type { Id } from '@shared/types';

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
  currentId: Id | null;
  /** Solo para la primera capa: al navegar se descarta. */
  origin: ViewerOrigin | null;
  /** Aumenta al cerrar: la rejilla enfoca el mosaico de `closedId`. */
  closedTick: number;
  closedId: Id | null;
}

export const useViewerStore = create<ViewerState>(() => ({
  open: false,
  currentId: null,
  origin: null,
  closedTick: 0,
  closedId: null,
}));

export function openViewer(id: Id, origin: ViewerOrigin | null): void {
  useViewerStore.setState({ open: true, currentId: id, origin });
}

export function setViewerCurrent(id: Id): void {
  useViewerStore.setState({ currentId: id, origin: null });
}

/** Termina el cierre (ya sin animación) y pide a la rejilla que enfoque el mosaico actual. */
export function finishViewerClose(): void {
  useViewerStore.setState((s) => ({
    open: false,
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
