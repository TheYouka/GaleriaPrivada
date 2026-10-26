// Importación vista desde el renderer (docs/DESIGN.md §12.2, §12.5.1 y §14.6): el trabajo en curso
// (import:progress), la confirmación de conversiones de D8 (import:confirmNeeded) y el resumen final
// (import:done). Solo puede haber una importación activa (§12.11). [H3-8] El renderer no construye
// rutas: los diálogos están en main y los archivos soltados llegan por galeria.importDropped.
import { create } from 'zustand';
import type { Id, ImportConfirmNeeded, ImportProgress, ImportReport } from '@shared/types';
import { errorMessage } from '../lib/errors-es';
import { invoke, on } from '../lib/ipc';
import { toast } from '../lib/toast';

export interface ImportJobView {
  jobId: Id;
  /** Null hasta el primer import:progress. */
  progress: ImportProgress | null;
  /** D8: pendiente de respuesta del usuario. */
  confirm: ImportConfirmNeeded | null;
  /** "Cancelar importación" pulsado: la respuesta llega con import:done. */
  cancelling: boolean;
}

interface ImportState {
  job: ImportJobView | null;
  /** Resumen del último trabajo, hasta que el usuario lo cierre. */
  report: ImportReport | null;
}

export const useImportStore = create<ImportState>(() => ({ job: null, report: null }));

/** Trabajos ya terminados: import:done puede llegar antes que la respuesta del invoke que lo lanzó. */
const finished = new Set<Id>();

/** Hay una importación en curso (incluida la espera de la confirmación de D8). */
export function isImporting(): boolean {
  return useImportStore.getState().job !== null;
}

function begin(jobId: Id): void {
  if (finished.has(jobId)) return;
  useImportStore.setState((s) =>
    s.job?.jobId === jobId
      ? s
      : { job: { jobId, progress: null, confirm: null, cancelling: false }, report: null },
  );
}

/** "Archivos…" y "Carpeta…": el diálogo nativo se abre en main (BUSY sin abrirlo si ya hay una). */
export async function startImport(source: 'files' | 'folder'): Promise<void> {
  if (isImporting()) return;
  const res = await invoke(source === 'files' ? 'import:chooseFiles' : 'import:chooseFolder');
  if (!res.ok) return void toast(errorMessage(res.error), 'error');
  if (res.data) begin(res.data.jobId);
}

/** Archivos o carpetas soltados en la ventana (§12.2). */
export async function importDropped(files: File[]): Promise<void> {
  if (isImporting()) {
    toast(errorMessage('BUSY'), 'error');
    return;
  }
  let res;
  try {
    res = await window.galeria.importDropped(files);
  } catch {
    res = { ok: false as const, error: { code: 'INTERNAL' as const } };
  }
  if (!res.ok) return void toast(errorMessage(res.error), 'error');
  begin(res.data.jobId);
}

/** Respuesta a la confirmación de D8: convertir o saltar esos vídeos. */
export async function answerConfirm(convert: boolean): Promise<void> {
  const job = useImportStore.getState().job;
  if (!job?.confirm) return;
  useImportStore.setState({ job: { ...job, confirm: null } });
  const res = await invoke('import:confirm', { jobId: job.jobId, convert });
  if (!res.ok && res.error.code !== 'NOT_FOUND') toast(errorMessage(res.error), 'error');
}

/** "Cancelar" (y "Cancelar importación" de D8). */
export async function cancelImport(): Promise<void> {
  const job = useImportStore.getState().job;
  if (!job || job.cancelling) return;
  useImportStore.setState({ job: { ...job, confirm: null, cancelling: true } });
  const res = await invoke('import:cancel', { jobId: job.jobId });
  if (!res.ok) toast(errorMessage(res.error), 'error');
}

export function closeImportReport(): void {
  useImportStore.setState({ report: null });
}

/** import:progress, import:confirmNeeded e import:done. Devuelve la función para darse de baja. */
export function subscribeImport(): () => void {
  const offProgress = on('import:progress', (progress) => {
    if (finished.has(progress.jobId)) return;
    useImportStore.setState((s) => {
      const same = s.job?.jobId === progress.jobId ? s.job : null;
      return {
        job: {
          jobId: progress.jobId,
          progress,
          confirm: progress.phase === 'awaiting-confirmation' ? (same?.confirm ?? null) : null,
          cancelling: same?.cancelling ?? false,
        },
        report: null,
      };
    });
  });
  const offConfirm = on('import:confirmNeeded', (confirm) => {
    if (finished.has(confirm.jobId)) return;
    useImportStore.setState((s) => {
      const same = s.job?.jobId === confirm.jobId ? s.job : null;
      return {
        job: {
          jobId: confirm.jobId,
          progress: same?.progress ?? null,
          confirm,
          cancelling: same?.cancelling ?? false,
        },
        report: null,
      };
    });
  });
  const offDone = on('import:done', (report) => {
    finished.add(report.jobId);
    useImportStore.setState({ job: null, report });
  });
  return () => {
    offProgress();
    offConfirm();
    offDone();
  };
}
