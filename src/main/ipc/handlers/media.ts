// media:list, media:get, media:rename y media:delete (docs/DESIGN.md §10.2, §12.10). Todos "U".
// La DB y la carpeta de la bóveda se piden con la época de la sesión actual [H3-6].
import { AppErrorException } from '@shared/errors';
import { KIND_MEDIA, KIND_THUMB } from '../../crypto/file-format';
import {
  deleteMedia,
  getMedia,
  listMedia,
  renameMedia,
  type DeletedMedia,
} from '../../db/repos/media-repo';
import type { SessionManager } from '../../session/session-manager';
import { ObjectStore } from '../../vault/object-store';
import type { LibraryEvents } from '../library-events';
import { handle } from '../register';

export interface MediaHandlerDeps {
  session: Pick<SessionManager, 'epoch' | 'getDb' | 'getVaultDir'>;
  events: LibraryEvents;
}

/** Borrados criptográficos en paralelo (acotado): no necesitan claves y nunca lanzan. */
const ERASE_CONCURRENCY = 8;

/**
 * §12.10 punto 3: tras el COMMIT, borrado criptográfico de cada objeto y miniatura. Un fallo queda
 * en el log (`object.erase-failed`) y lo borrará el barrido de huérfanos de la reconciliación.
 */
export async function eraseDeletedObjects(
  store: ObjectStore,
  deleted: readonly DeletedMedia[],
): Promise<void> {
  const tasks: (() => Promise<unknown>)[] = [];
  for (const d of deleted) {
    tasks.push(() => store.eraseObject(d.id, KIND_MEDIA));
    if (d.thumbId) {
      const thumbId = d.thumbId;
      tasks.push(() => store.eraseObject(thumbId, KIND_THUMB));
    }
  }
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < tasks.length) {
      const task = tasks[next] as () => Promise<unknown>;
      next += 1;
      await task();
    }
  };
  await Promise.all(Array.from({ length: Math.min(ERASE_CONCURRENCY, tasks.length) }, worker));
}

export function registerMediaHandlers({ session, events }: MediaHandlerDeps): void {
  handle('media:list', { requiresUnlock: true }, (query) => ({
    items: listMedia(session.getDb(session.epoch), query),
  }));

  handle('media:get', { requiresUnlock: true }, ({ id }) => {
    const detail = getMedia(session.getDb(session.epoch), id);
    if (!detail) throw new AppErrorException({ code: 'NOT_FOUND' });
    return detail;
  });

  handle('media:rename', { requiresUnlock: true }, ({ id, name }) => {
    const item = renameMedia(session.getDb(session.epoch), id, name);
    events.changed('rename', [id]);
    return item;
  });

  handle('media:delete', { requiresUnlock: true }, async ({ ids }) => {
    const epoch = session.epoch;
    const db = session.getDb(epoch);
    const store = new ObjectStore(session.getVaultDir(epoch));
    // 1. La UI ya confirmó. 2. Una transacción con json_each(?) [H3-4].
    const deleted = deleteMedia(db, ids);
    // 3–4. Borrado criptográfico tras el COMMIT (sin claves: sigue aunque se bloquee).
    await eraseDeletedObjects(store, deleted);
    // 5. Evento, solo si la sesión sigue siendo la misma.
    if (deleted.length > 0 && session.epoch === epoch) {
      events.changed(
        'delete',
        deleted.map((d) => d.id),
      );
    }
    return { deleted: deleted.length };
  });
}
