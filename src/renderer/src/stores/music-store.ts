// Biblioteca de música del perfil vista desde el renderer (docs/DESIGN.md §8.6.1 y §14.9): las pistas
// (título, duración, tamaño), la importación (diálogo nativo en main; copia sin cifrar y el original
// no se toca) y su resumen, renombrar y eliminar. Los archivos están en claro en music/ con nombres
// neutros; los títulos y las playlists que las usan viven en la DB cifrada.
import { create } from 'zustand';
import type { AppError } from '@shared/errors';
import type { Id, MusicImportResult, MusicTrack } from '@shared/types';
import { announce } from '../lib/announce';
import { errorMessage } from '../lib/errors-es';
import { invoke } from '../lib/ipc';
import { toast } from '../lib/toast';

export interface MusicState {
  tracks: readonly MusicTrack[];
  status: 'idle' | 'loading' | 'ready' | 'error';
  error: AppError | null;
  /** music:import en curso (el diálogo nativo o la copia). */
  importing: boolean;
  /** Resumen de la última importación (pistas añadidas y fallos con su nombre y motivo). */
  summary: MusicImportResult | null;
  importError: AppError | null;
}

const INITIAL: MusicState = {
  tracks: [],
  status: 'idle',
  error: null,
  importing: false,
  summary: null,
  importError: null,
};

export const useMusicStore = create<MusicState>(() => INITIAL);

export function resetMusic(): void {
  useMusicStore.setState({ ...INITIAL });
}

let loadSeq = 0;

export async function loadMusic(): Promise<void> {
  const seq = ++loadSeq;
  useMusicStore.setState((s) => (s.status === 'ready' ? s : { status: 'loading' }));
  const res = await invoke('music:list');
  if (seq !== loadSeq) return;
  if (!res.ok) {
    useMusicStore.setState({ status: 'error', error: res.error });
    return;
  }
  useMusicStore.setState({ tracks: res.data, status: 'ready', error: null });
}

export function dismissMusicSummary(): void {
  useMusicStore.setState({ summary: null, importError: null });
}

/** music:import: abre el diálogo nativo (en main), copia las pistas y deja el resumen. */
export async function importMusic(): Promise<void> {
  if (useMusicStore.getState().importing) return;
  useMusicStore.setState({ importing: true, summary: null, importError: null });
  const res = await invoke('music:import');
  if (!res.ok) {
    useMusicStore.setState({ importing: false, importError: res.error });
    announce(errorMessage(res.error));
    return;
  }
  const result = res.data;
  useMusicStore.setState({ importing: false, summary: result });
  if (result === null) return; // diálogo cancelado: sin cambios
  const n = result.imported.length;
  const failed = result.failed.length;
  announce(
    `Música importada: ${n === 1 ? '1 pista añadida' : `${n} pistas añadidas`}` +
      (failed > 0 ? `, ${failed === 1 ? '1 fallo' : `${failed} fallos`}` : '') +
      '.',
  );
  await loadMusic();
}

/** music:rename. Devuelve el error para que el diálogo lo muestre, o null si fue bien. */
export async function renameTrack(id: Id, title: string): Promise<AppError | null> {
  const res = await invoke('music:rename', { id, title });
  if (!res.ok) return res.error;
  useMusicStore.setState((s) => ({
    tracks: s.tracks.map((t) => (t.id === id ? res.data : t)),
  }));
  announce(`Pista renombrada a «${res.data.title}».`);
  return null;
}

/** music:delete: quita la pista de las playlists y borra su copia (el original nunca se tocó). */
export async function deleteTrack(track: MusicTrack): Promise<boolean> {
  const res = await invoke('music:delete', { id: track.id });
  if (!res.ok) {
    toast(errorMessage(res.error), 'error');
    return false;
  }
  useMusicStore.setState((s) => ({ tracks: s.tracks.filter((t) => t.id !== track.id) }));
  const message = `Pista «${track.title}» eliminada de la biblioteca.`;
  toast(message);
  announce(message);
  return true;
}
