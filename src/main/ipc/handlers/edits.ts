// edits:save (docs/DESIGN.md §10.2, §16.5). Canal "U"; en `maintenance` el wrapper ya devuelve
// BUSY (§5.6). Sustituye la lista completa de operaciones del medio (`[]` = revertir) y regenera su
// miniatura con un objeto nuevo; el original nunca se toca.
//
//   1. el esquema zod ya validó `ops` (≤ 64, recortes dentro de rango, §10.3); el medio tiene que
//      ser una foto `ready` (si no existe, NOT_FOUND; un vídeo, VALIDATION) y se registra el
//      trabajo `edit` (BUSY si ya hay una edición del mismo medio, §12.11);
//   2–6. vault/thumb-replace.ts con la transacción de edit-repo.ts (filas de media_edits, thumb_id
//      nuevo y thumb_rev += 1);
//   7. library:changed { reason: 'edit', ids: [id] } (solo si la sesión sigue siendo la misma).
//
// Fallos (tabla de §16.5): INTEGRITY, INTERNAL, BUSY, LOCKED, DISK_FULL, IO. En todos se borra el
// .part y las ediciones guardadas no cambian.
import { AppErrorException } from '@shared/errors';
import { foldEdits } from '@shared/edits';
import type { ReqOf, ResOf } from '@shared/ipc-contract';
import { editTarget, saveEdits } from '../../db/repos/edit-repo';
import { log } from '../../log';
import type { SessionManager } from '../../session/session-manager';
import { replaceThumb, type ThumbReplaceDeps } from '../../vault/thumb-replace';
import type { LibraryEvents } from '../library-events';
import { handle } from '../register';

export interface EditsHandlerDeps extends Omit<ThumbReplaceDeps, 'session'> {
  session: Pick<
    SessionManager,
    | 'epoch'
    | 'startJob'
    | 'getDb'
    | 'getKeyRing'
    | 'getVaultDir'
    | 'registerReader'
    | 'registerWriter'
    | 'cleanup'
  >;
  library: Pick<LibraryEvents, 'changed'>;
}

export interface EditsHandlers {
  save(req: ReqOf<'edits:save'>): Promise<ResOf<'edits:save'>>;
}

/** Cuerpo del handler, sin ipcMain (los tests lo llaman también directamente). */
export function editsHandlers(deps: EditsHandlerDeps): EditsHandlers {
  const { session, library } = deps;
  return {
    save: async ({ mediaId, ops }) => {
      const epoch = session.epoch;
      // 1. Foto `ready` y trabajo `edit` (BUSY por mediaId).
      const target = editTarget(session.getDb(epoch), mediaId);
      if (!target) throw new AppErrorException({ code: 'NOT_FOUND' });
      if (target.kind !== 'photo') {
        throw new AppErrorException({ code: 'VALIDATION', details: { reason: 'not-photo' } });
      }
      const job = session.startJob('edit', { mediaId });
      try {
        // 2–6.
        const thumbRev = await replaceThumb(deps, {
          epoch: job.epoch,
          mediaId,
          signal: job.signal,
          state: foldEdits(ops),
          commit: (db, thumbId) => {
            const r = saveEdits(db, mediaId, ops, thumbId);
            return r ? { oldThumbId: r.oldThumbId, value: r.thumbRev } : null;
          },
        });
        // Borrado mientras se renderizaba: nada cambió.
        if (thumbRev === null) throw new AppErrorException({ code: 'NOT_FOUND' });
        // 7.
        if (session.epoch === epoch) library.changed('edit', [mediaId]);
        log.info('edit.saved', { mediaId, count: ops.length });
        return { edits: [...ops], thumbRev };
      } catch (err) {
        if (job.signal.aborted) {
          log.info('edit.failed', { mediaId, code: 'LOCKED' });
          throw new AppErrorException({ code: 'LOCKED' });
        }
        throw err;
      } finally {
        job.done();
      }
    },
  };
}

export function registerEditsHandlers(deps: EditsHandlerDeps): EditsHandlers {
  const h = editsHandlers(deps);
  handle('edits:save', { requiresUnlock: true }, (req) => h.save(req));
  return h;
}
