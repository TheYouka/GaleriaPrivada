// merge:start y merge:cancel (docs/DESIGN.md §10.2, §18). Los dos "U"; en `maintenance` el wrapper
// ya devuelve BUSY (§5.6). El esquema zod exige `leftId ≠ rightId` (§10.3); que los dos sean vídeos
// `ready` lo comprueba merge-service en la DB (VALIDATION). La fusión sigue en segundo plano y su
// resultado llega por merge:progress y merge:done.
import type { ReqOf, ResOf } from '@shared/ipc-contract';
import type { MergeService } from '../../media/merge-service';
import { handle } from '../register';

export interface MergeHandlerDeps {
  service: Pick<MergeService, 'start' | 'cancel'>;
}

export interface MergeHandlers {
  start(req: ReqOf<'merge:start'>): ResOf<'merge:start'>;
  cancel(req: ReqOf<'merge:cancel'>): void;
}

/** Cuerpos de los handlers, sin ipcMain (los tests los llaman directamente). */
export function mergeHandlers({ service }: MergeHandlerDeps): MergeHandlers {
  return {
    start: (req) => ({ jobId: service.start(req).jobId }),
    cancel: ({ jobId }) => service.cancel(jobId),
  };
}

export function registerMergeHandlers(deps: MergeHandlerDeps): MergeHandlers {
  const h = mergeHandlers(deps);
  handle('merge:start', { requiresUnlock: true }, (req) => h.start(req));
  handle('merge:cancel', { requiresUnlock: true }, (req) => h.cancel(req));
  return h;
}
