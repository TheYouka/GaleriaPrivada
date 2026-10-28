// Presentación vista desde el renderer (docs/DESIGN.md §17.1, §17.2 y §17.10): el diálogo de inicio
// con los ajustes efectivos (los de la playlist o los predeterminados) y la presentación en curso.
// Se empieza desde la selección de la galería (o de todo lo visible, F5) o desde una playlist; en
// los dos casos `presentation:getConfig` da los ajustes y las pistas. Todo vive solo en memoria: al
// bloquear no queda nada (la ventana se sustituye, §13.3).
import { create } from 'zustand';
import type { Id, MediaListItem, PresentationSettings } from '@shared/types';
import { announce } from '../lib/announce';
import { errorMessage } from '../lib/errors-es';
import { invoke } from '../lib/ipc';
import { toast } from '../lib/toast';
import { cloneSettings } from '../screens/presentation/presentation-form-model';
import { PresentationRuntime } from '../screens/presentation/presentation-runtime';
import { useLibraryStore } from './library-store';
import { useSelectionStore } from './selection-store';

export interface PresentationSource {
  items: readonly MediaListItem[];
  /** De qué playlist viene (null = selección o galería). */
  playlist: { id: Id; name: string } | null;
}

export interface SetupState extends PresentationSource {
  settings: PresentationSettings;
  /** El control que tenía el foco al pedirla: el foco vuelve a él al salir de la presentación. */
  returnFocus: HTMLElement | null;
}

export interface ActivePresentation extends PresentationSource {
  /** Aumenta en cada presentación: la pantalla se monta de nuevo. */
  seq: number;
  /** El anfitrión del motor (planificador, audio, capas); lo arranca y lo suelta la pantalla. */
  runtime: PresentationRuntime;
  /** Ajustes vivos; los cambios del panel y del teclado se escriben aquí. */
  settings: PresentationSettings;
  /** El control que la inició: el foco vuelve a él al salir. */
  returnFocus: HTMLElement | null;
}

interface PresentationState {
  /** El diálogo de inicio abierto. */
  setup: SetupState | null;
  /** Se está pidiendo la configuración a main (los botones no se pueden repetir). */
  loading: boolean;
  active: ActivePresentation | null;
}

export const usePresentationStore = create<PresentationState>(() => ({
  setup: null,
  loading: false,
  active: null,
}));

let seq = 0;

export function resetPresentation(): void {
  usePresentationStore.setState({ setup: null, loading: false, active: null });
}

export const NOTHING_TO_SHOW = 'No hay fotos ni vídeos para la presentación.';

/**
 * Abre el diálogo de inicio con los ajustes efectivos de `playlist` (o los predeterminados). Si
 * `presentation:getConfig` falla, no empieza y avisa con el mensaje del código (§17.10).
 */
export async function openPresentationSetup(source: PresentationSource): Promise<boolean> {
  const state = usePresentationStore.getState();
  if (state.loading || state.setup || state.active) return false;
  if (source.items.length === 0) {
    toast(NOTHING_TO_SHOW);
    announce(NOTHING_TO_SHOW);
    return false;
  }
  const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  usePresentationStore.setState({ loading: true });
  const res = await invoke(
    'presentation:getConfig',
    source.playlist ? { playlistId: source.playlist.id } : {},
  );
  if (!res.ok) {
    usePresentationStore.setState({ loading: false });
    toast(errorMessage(res.error), 'error');
    return false;
  }
  usePresentationStore.setState({
    loading: false,
    setup: { ...source, settings: cloneSettings(res.data.settings), returnFocus },
  });
  return true;
}

export function changeSetup(patch: Partial<PresentationSettings>): void {
  usePresentationStore.setState((s) =>
    s.setup ? { setup: { ...s.setup, settings: { ...s.setup.settings, ...patch } } } : s,
  );
}

export function cancelSetup(): void {
  usePresentationStore.setState({ setup: null });
}

/** «Iniciar presentación»: del diálogo a la pantalla. */
export function beginPresentation(): void {
  const { setup, active } = usePresentationStore.getState();
  if (!setup || active) return;
  seq += 1;
  const settings = cloneSettings(setup.settings);
  const runtime = new PresentationRuntime({
    items: setup.items,
    settings,
    // Todas las diapositivas fallaron (§17.10): sale con el aviso que ya dio el anfitrión.
    onFailedAll: endPresentation,
    notify: (message, tone) => toast(message, tone),
    onMusicDisabled: () => changeActive({ musicEnabled: false }),
  });
  usePresentationStore.setState({
    setup: null,
    active: {
      items: setup.items,
      playlist: setup.playlist,
      runtime,
      settings,
      seq,
      returnFocus: setup.returnFocus,
    },
  });
}

export function endPresentation(): void {
  usePresentationStore.setState({ active: null });
}

/** Cambia un ajuste de la presentación en curso (el audio se aplica al momento). */
export function changeActive(patch: Partial<PresentationSettings>): void {
  usePresentationStore.setState((s) =>
    s.active ? { active: { ...s.active, settings: { ...s.active.settings, ...patch } } } : s,
  );
}

// ── Desde la galería y las playlists ───────────────────────────────────────────────────────────

/** Los elementos seleccionados, en el orden actual de la galería; sin selección, todo lo visible. */
export function gallerySlideItems(): readonly MediaListItem[] {
  const items = useLibraryStore.getState().items;
  const selected = useSelectionStore.getState().selected;
  return selected.size === 0 ? items : items.filter((i) => selected.has(i.id));
}

export function startFromGallery(): Promise<boolean> {
  return openPresentationSetup({ items: gallerySlideItems(), playlist: null });
}

/** Los elementos de una playlist en su orden (media:list con position). */
export async function startFromPlaylist(playlist: { id: Id; name: string }): Promise<boolean> {
  const res = await invoke('media:list', {
    kind: 'all',
    playlistId: playlist.id,
    sort: { field: 'position', dir: 'asc' },
  });
  if (!res.ok) {
    toast(errorMessage(res.error), 'error');
    return false;
  }
  if (res.data.items.length === 0) {
    const message = `«${playlist.name}» está vacía. Añade fotos o vídeos para ver su presentación.`;
    toast(message);
    announce(message);
    return false;
  }
  return openPresentationSetup({ items: res.data.items, playlist });
}

// ── Guardar ────────────────────────────────────────────────────────────────────────────────────

/** presentation:saveDefaults con aviso. */
export async function saveAsDefaults(settings: PresentationSettings): Promise<boolean> {
  const res = await invoke('presentation:saveDefaults', { settings });
  if (!res.ok) {
    toast(errorMessage(res.error), 'error');
    return false;
  }
  const message = 'Ajustes guardados como predeterminados.';
  toast(message);
  announce(message);
  return true;
}

/** playlists:setPresentation con aviso. */
export async function saveForPlaylist(
  playlist: { id: Id; name: string },
  settings: PresentationSettings,
): Promise<boolean> {
  const res = await invoke('playlists:setPresentation', { id: playlist.id, settings });
  if (!res.ok) {
    toast(errorMessage(res.error), 'error');
    return false;
  }
  const message = `Ajustes guardados para «${playlist.name}».`;
  toast(message);
  announce(message);
  return true;
}
