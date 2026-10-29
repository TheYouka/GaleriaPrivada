// Vídeo dual y fusión vistos desde el renderer (docs/DESIGN.md §18.1 y §18.7): los dos vídeos
// elegidos (el detalle de media:get, sin rutas), el modo de controles, el volumen, la velocidad y el
// bucle de cada lado, el selector «Elegir vídeo…» y el estado del diálogo de fusión (merge:progress y
// merge:done). Todo vive solo en memoria: al bloquear no queda nada (la ventana se sustituye).
import { create } from 'zustand';
import type { Id, MediaDetail, MergeDone, MergeProgress, MergeRequest } from '@shared/types';
import { announce } from '../lib/announce';
import { errorMessage } from '../lib/errors-es';
import { invoke, on } from '../lib/ipc';
import { toast } from '../lib/toast';
import { DEFAULT_SPEED, SPEEDS } from '../screens/player/player-math';
import { mergeErrorMessage } from '../screens/dual/merge-model';
import type { Side } from '../screens/dual/sync';
import { useNavStore } from './nav-store';

export type MergeView =
  /** Diálogo cerrado. */
  | { name: 'idle' }
  /** Opciones; `error` es el fallo de merge:start (BUSY, VALIDATION…). */
  | { name: 'form'; error: string | null }
  /** `jobId` es null hasta que responde merge:start. */
  | { name: 'running'; jobId: Id | null; fraction: number; cancelling: boolean }
  | { name: 'done'; mediaId: Id; existed: boolean }
  | { name: 'failed'; message: string };

interface DualState {
  left: MediaDetail | null;
  right: MediaDetail | null;
  /** Aumenta cada vez que se elige o se quita el vídeo de un lado (aunque sea el mismo): el <video> se crea de nuevo. */
  epoch: Record<Side, number>;
  /** «Controles sincronizados» (por defecto sí). */
  synced: boolean;
  /** Volumen 0–1 y silencio de cada lado: por defecto suena el izquierdo y el derecho está silenciado. */
  volume: Record<Side, number>;
  muted: Record<Side, boolean>;
  speed: Record<Side, number>;
  loop: Record<Side, boolean>;
  /** El selector «Elegir vídeo…» abierto para este lado. */
  picking: Side | null;
  merge: MergeView;
}

const initial = (): DualState => ({
  left: null,
  right: null,
  epoch: { left: 0, right: 0 },
  synced: true,
  volume: { left: 1, right: 1 },
  muted: { left: false, right: true },
  speed: { left: DEFAULT_SPEED, right: DEFAULT_SPEED },
  loop: { left: false, right: false },
  picking: null,
  merge: { name: 'idle' },
});

export const useDualStore = create<DualState>(initial);

export const SIDE_LABEL: Readonly<Record<Side, string>> = Object.freeze({
  left: 'izquierdo',
  right: 'derecho',
});

/** Al bloquear o desmontar la bóveda no queda nada en memoria. */
export function resetDual(): void {
  useDualStore.setState(initial());
}

export function setSynced(synced: boolean): void {
  useDualStore.setState({ synced });
  announce(synced ? 'Controles sincronizados' : 'Controles independientes');
}

export function setVolume(side: Side, volume: number): void {
  useDualStore.setState((s) => ({
    volume: { ...s.volume, [side]: Math.min(1, Math.max(0, volume)) },
  }));
}

export function setMuted(side: Side, muted: boolean): void {
  useDualStore.setState((s) => ({ muted: { ...s.muted, [side]: muted } }));
}

/** `'both'`: el modo sincronizado cambia los dos lados a la vez. */
export function setSpeed(side: Side | 'both', speed: number): void {
  if (!(SPEEDS as readonly number[]).includes(speed)) return;
  useDualStore.setState((s) => ({
    speed: side === 'both' ? { left: speed, right: speed } : { ...s.speed, [side]: speed },
  }));
}

export function setLoop(side: Side | 'both', loop: boolean): void {
  useDualStore.setState((s) => ({
    loop: side === 'both' ? { left: loop, right: loop } : { ...s.loop, [side]: loop },
  }));
}

export function requestPick(side: Side): void {
  useDualStore.setState({ picking: side });
}

export function closePick(): void {
  useDualStore.setState({ picking: null });
}

/** media:get de un vídeo; null (con aviso) si ya no existe o no es un vídeo. */
async function loadVideo(id: Id): Promise<MediaDetail | null> {
  const res = await invoke('media:get', { id });
  if (!res.ok) {
    toast(
      res.error.code === 'NOT_FOUND' ? 'Ese vídeo ya no está disponible.' : errorMessage(res.error),
      'error',
    );
    return null;
  }
  if (res.data.kind !== 'video') {
    toast('Solo se pueden elegir vídeos.', 'error');
    return null;
  }
  return res.data;
}

function withSide(side: Side, detail: MediaDetail | null): Partial<DualState> {
  return side === 'left' ? { left: detail } : { right: detail };
}

/** Cambia el vídeo de un lado: el <video> y su estado empiezan de cero. */
function replaceSide(side: Side, detail: MediaDetail | null, extra: Partial<DualState> = {}): void {
  useDualStore.setState((s) => ({
    ...withSide(side, detail),
    ...extra,
    epoch: { ...s.epoch, [side]: s.epoch[side] + 1 },
  }));
}

/** Elige el vídeo de un lado (desde «Elegir vídeo…»). */
export async function chooseVideo(side: Side, id: Id): Promise<void> {
  const detail = await loadVideo(id);
  if (!detail) return;
  replaceSide(side, detail, { picking: null });
  announce(`Vídeo ${SIDE_LABEL[side]}: ${detail.name}`);
}

export function clearSide(side: Side): void {
  replaceSide(side, null);
}

/**
 * Abre la pantalla con dos vídeos (la barra de selección de la galería): el primero a la izquierda y
 * el segundo a la derecha, en el orden de la galería. No navega si alguno falla.
 */
export async function openDual(leftId: Id, rightId: Id): Promise<void> {
  const [left, right] = await Promise.all([loadVideo(leftId), loadVideo(rightId)]);
  if (!left || !right) return;
  useDualStore.setState((s) => ({
    left,
    right,
    picking: null,
    epoch: { left: s.epoch.left + 1, right: s.epoch.right + 1 },
  }));
  useNavStore.getState().navigate('dual');
}

/** Al mostrar la pantalla: quita los lados cuyo vídeo se borró mientras tanto. */
export async function refreshSides(): Promise<void> {
  for (const side of ['left', 'right'] as const) {
    const current = useDualStore.getState()[side];
    if (!current) continue;
    const res = await invoke('media:get', { id: current.id });
    if (res.ok) {
      useDualStore.setState((s) => (s[side]?.id === current.id ? withSide(side, res.data) : s));
    } else if (res.error.code === 'NOT_FOUND') {
      if (useDualStore.getState()[side]?.id === current.id) clearSide(side);
      toast(`El vídeo ${SIDE_LABEL[side]} ya no está disponible.`, 'error');
    }
  }
}

// ── Fusión (merge:start, merge:progress, merge:done) ───────────────────────────────────────────

/** merge:done puede llegar antes que la respuesta de merge:start que lo lanzó. */
const earlyDone = new Map<Id, MergeDone>();
let cancelRequested = false;

export function isMerging(): boolean {
  return useDualStore.getState().merge.name === 'running';
}

export function openMergeDialog(): void {
  const { left, right, merge } = useDualStore.getState();
  if (!left || !right || merge.name === 'running') return;
  useDualStore.setState({ merge: { name: 'form', error: null } });
}

/** Cierra el diálogo (no mientras la fusión está en curso: se cancela con «Cancelar fusión»). */
export function closeMergeDialog(): void {
  if (isMerging()) return;
  useDualStore.setState({ merge: { name: 'idle' } });
}

function applyDone(done: MergeDone): void {
  cancelRequested = false;
  if (done.result.ok) {
    const { mediaId, existed } = done.result.data;
    useDualStore.setState({ merge: { name: 'done', mediaId, existed } });
    announce(existed ? 'Ya existía un vídeo idéntico' : 'Vídeo fusionado creado');
    return;
  }
  if (done.result.error.code === 'CANCELLED') {
    useDualStore.setState({ merge: { name: 'form', error: null } });
    toast('Fusión cancelada.');
    announce('Fusión cancelada');
    return;
  }
  useDualStore.setState({
    merge: { name: 'failed', message: mergeErrorMessage(done.result.error) },
  });
}

/** «Crear vídeo fusionado»: lanza merge:start y deja el diálogo en el progreso. */
export async function startMerge(req: MergeRequest): Promise<void> {
  if (isMerging()) return;
  cancelRequested = false;
  useDualStore.setState({
    merge: { name: 'running', jobId: null, fraction: 0, cancelling: false },
  });
  const res = await invoke('merge:start', req);
  if (!res.ok) {
    useDualStore.setState({ merge: { name: 'form', error: mergeErrorMessage(res.error) } });
    return;
  }
  const { jobId } = res.data;
  const early = earlyDone.get(jobId);
  if (early) {
    earlyDone.delete(jobId);
    applyDone(early);
    return;
  }
  useDualStore.setState((s) =>
    s.merge.name === 'running' ? { merge: { ...s.merge, jobId, cancelling: cancelRequested } } : s,
  );
  if (cancelRequested) void invoke('merge:cancel', { jobId });
}

/** «Cancelar fusión»: la respuesta llega con merge:done (CANCELLED). */
export async function cancelMerge(): Promise<void> {
  const { merge } = useDualStore.getState();
  if (merge.name !== 'running' || merge.cancelling) return;
  useDualStore.setState({ merge: { ...merge, cancelling: true } });
  if (merge.jobId === null) {
    // merge:start todavía no ha respondido: se cancela en cuanto haya jobId.
    cancelRequested = true;
    return;
  }
  const res = await invoke('merge:cancel', { jobId: merge.jobId });
  if (!res.ok) toast(errorMessage(res.error), 'error');
}

/** merge:progress y merge:done. Devuelve la función para darse de baja. */
export function subscribeMerge(): () => void {
  const offProgress = on('merge:progress', (progress: MergeProgress) => {
    useDualStore.setState((s) =>
      s.merge.name === 'running' && (s.merge.jobId === null || s.merge.jobId === progress.jobId)
        ? { merge: { ...s.merge, fraction: progress.fraction } }
        : s,
    );
  });
  const offDone = on('merge:done', (done: MergeDone) => {
    const { merge } = useDualStore.getState();
    if (merge.name === 'running' && merge.jobId === done.jobId) applyDone(done);
    else if (merge.name === 'running' && merge.jobId === null) earlyDone.set(done.jobId, done);
  });
  return () => {
    offProgress();
    offDone();
  };
}
