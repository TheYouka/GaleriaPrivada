// Traslado de la bóveda visto desde el renderer (docs/DESIGN.md §8.7 y §14.9): la información de
// Ajustes → Almacenamiento y el trabajo en curso (relocate:progress / relocate:done). [H3-8] El
// renderer nunca envía rutas: solo pide 'choose' (diálogo en main) o 'default', y solo ve la
// ubicación de la bóveda y, si quedan, los restos de la anterior.
import { create } from 'zustand';
import type { AppError } from '@shared/errors';
import type { Id, VaultInfo } from '@shared/types';
import { errorMessage } from '../lib/errors-es';
import { invoke, on } from '../lib/ipc';
import { toast } from '../lib/toast';

export interface RelocateJobView {
  jobId: Id;
  copiedBytes: number;
  totalBytes: number;
  /** "Cancelar" pulsado (la respuesta llega con relocate:done). */
  cancelling: boolean;
}

interface RelocateState {
  info: VaultInfo | null;
  infoError: AppError | null;
  loading: boolean;
  job: RelocateJobView | null;
  /** Restos de la ubicación anterior que no se pudieron borrar (§8.7, paso 8). */
  leftoverPath: string | null;
  /** Último error al empezar un traslado (paso 1). */
  startError: AppError | null;
}

export const useRelocateStore = create<RelocateState>(() => ({
  info: null,
  infoError: null,
  loading: false,
  job: null,
  leftoverPath: null,
  startError: null,
}));

/** true desde el paso 5: "Cancelar" ya no tiene efecto ("Terminando…"). */
export function isFinishing(job: RelocateJobView): boolean {
  return job.totalBytes > 0 && job.copiedBytes >= job.totalBytes;
}

export async function refreshVaultInfo(): Promise<void> {
  useRelocateStore.setState({ loading: true });
  const res = await invoke('vault:getInfo');
  if (res.ok) useRelocateStore.setState({ info: res.data, infoError: null, loading: false });
  else useRelocateStore.setState({ infoError: res.error, loading: false });
}

/** "Mover bóveda…" ('choose') o "Volver a la ubicación predeterminada" ('default'). */
export async function startRelocate(target: 'choose' | 'default'): Promise<void> {
  useRelocateStore.setState({ startError: null });
  const res = await invoke('vault:relocate', { target });
  if (!res.ok) {
    // StorageTab lo muestra en una región role="alert".
    useRelocateStore.setState({ startError: res.error });
    return;
  }
  if (!res.data) return; // diálogo cancelado
  const { jobId } = res.data;
  useRelocateStore.setState((s) =>
    s.job?.jobId === jobId
      ? {}
      : { job: { jobId, copiedBytes: 0, totalBytes: 0, cancelling: false }, leftoverPath: null },
  );
}

export async function cancelRelocate(): Promise<void> {
  const job = useRelocateStore.getState().job;
  if (!job || job.cancelling || isFinishing(job)) return;
  useRelocateStore.setState({ job: { ...job, cancelling: true } });
  const res = await invoke('vault:relocateCancel', { jobId: job.jobId });
  if (!res.ok && res.error.code !== 'NOT_FOUND') toast(errorMessage(res.error), 'error');
}

/** relocate:progress y relocate:done. Devuelve la función para darse de baja. */
export function subscribeRelocate(): () => void {
  const offProgress = on('relocate:progress', (p) => {
    useRelocateStore.setState((s) => ({
      job: {
        jobId: p.jobId,
        copiedBytes: p.copiedBytes,
        totalBytes: p.totalBytes,
        cancelling: s.job?.jobId === p.jobId ? s.job.cancelling : false,
      },
    }));
  });
  const offDone = on('relocate:done', ({ result }) => {
    useRelocateStore.setState({ job: null });
    if (result.ok) {
      const { leftoverPath, ...info } = result.data;
      useRelocateStore.setState({ info, infoError: null, leftoverPath: leftoverPath ?? null });
      toast(
        leftoverPath
          ? 'La bóveda se ha movido, pero quedan restos en la ubicación anterior.'
          : 'La bóveda se ha movido.',
      );
    } else if (result.error.code === 'CANCELLED') {
      toast('Traslado cancelado. La bóveda sigue en su sitio.');
    } else {
      const message = errorMessage(result.error);
      toast(
        result.error.details?.reason === 'relocate-verify'
          ? message
          : `${message} La bóveda sigue en su sitio.`,
        'error',
      );
    }
    void refreshVaultInfo();
  });
  return () => {
    offProgress();
    offDone();
  };
}
