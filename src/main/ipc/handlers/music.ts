// music:import, music:list, music:rename y music:delete (docs/DESIGN.md §8.6.1, §10.2). Todos "U".
//
// - music:import reserva el trabajo `music-import` ANTES de abrir el diálogo (BUSY sin diálogo con
//   otra importación de música o un traslado, §12.11) y lo libera si se cancela. Más de 200
//   archivos → VALIDATION antes de empezar. El diálogo lleva `dontAddToRecent` (§24.2, límite 2).
// - music:delete: la fila y el id de kv['presentation.defaultTracks'] en una transacción; después
//   del COMMIT, unlink del archivo (en claro: no hace falta sobrescribirlo). Si falla, `warn` y la
//   reconciliación lo borrará como huérfano (§12.6 punto 5).
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { OpenDialogOptions, OpenDialogReturnValue } from 'electron';
import { AppErrorException } from '@shared/errors';
import { MUSIC_DIALOG_EXTENSIONS, MUSIC_IMPORT_MAX_FILES } from '@shared/constants';
import type { ReqOf, ResOf } from '@shared/ipc-contract';
import { deleteTrack, listTracks, renameTrack } from '../../db/repos/music-repo';
import { log } from '../../log';
import type { MusicService } from '../../music/music-service';
import { MUSIC_FILE_NAME } from '../../music/music-sniff';
import type { SessionManager } from '../../session/session-manager';
import { vaultPaths } from '../../vault/vault-layout';
import { handle } from '../register';

export const CHOOSE_MUSIC_OPTIONS: OpenDialogOptions = Object.freeze({
  properties: ['openFile', 'multiSelections', 'dontAddToRecent'],
  filters: [{ name: 'Música', extensions: [...MUSIC_DIALOG_EXTENSIONS] }],
}) as OpenDialogOptions;

export interface MusicHandlerDeps {
  service: Pick<MusicService, 'reserve' | 'release' | 'importFiles'>;
  session: Pick<SessionManager, 'epoch' | 'getDb' | 'getVaultDir'>;
  /** dialog.showOpenDialog con la ventana actual como padre. */
  showOpenDialog(options: OpenDialogOptions): Promise<OpenDialogReturnValue>;
}

export interface MusicHandlers {
  import(): Promise<ResOf<'music:import'>>;
  list(): ResOf<'music:list'>;
  rename(req: ReqOf<'music:rename'>): ResOf<'music:rename'>;
  delete(req: ReqOf<'music:delete'>): Promise<void>;
}

/** Cuerpos de los handlers, sin ipcMain (los tests los llaman directamente). */
export function musicHandlers({
  service,
  session,
  showOpenDialog,
}: MusicHandlerDeps): MusicHandlers {
  const db = () => session.getDb(session.epoch);
  return {
    import: async () => {
      const job = service.reserve(); // BUSY o LOCKED sin abrir el diálogo
      let result: OpenDialogReturnValue;
      try {
        result = await showOpenDialog({ ...CHOOSE_MUSIC_OPTIONS });
      } catch (err) {
        service.release(job);
        throw err;
      }
      if (result.canceled || result.filePaths.length === 0) {
        service.release(job);
        return null;
      }
      if (result.filePaths.length > MUSIC_IMPORT_MAX_FILES) {
        service.release(job);
        throw new AppErrorException({
          code: 'VALIDATION',
          details: { reason: 'too-many-files', count: result.filePaths.length },
        });
      }
      // Las rutas salen del diálogo nativo, en main.
      return service.importFiles(job, result.filePaths);
    },
    list: () => listTracks(db()),
    rename: ({ id, title }) => renameTrack(db(), id, title),
    delete: async ({ id }) => {
      const epoch = session.epoch;
      const musicDir = vaultPaths(session.getVaultDir(epoch)).music;
      const fileName = deleteTrack(session.getDb(epoch), id);
      if (fileName === null) throw new AppErrorException({ code: 'NOT_FOUND' });
      // Tras el COMMIT. El nombre sale de la DB, pero solo se borra si tiene la forma <id>.<ext>.
      if (!MUSIC_FILE_NAME.test(fileName)) return;
      try {
        await unlink(join(musicDir, fileName));
      } catch (err) {
        const errno = (err as { code?: unknown } | null)?.code;
        if (errno !== 'ENOENT') {
          log.warn('music.unlink-failed', { errno: typeof errno === 'string' ? errno : undefined });
        }
      }
    },
  };
}

export function registerMusicHandlers(deps: MusicHandlerDeps): MusicHandlers {
  const h = musicHandlers(deps);
  handle('music:import', { requiresUnlock: true }, () => h.import());
  handle('music:list', { requiresUnlock: true }, () => h.list());
  handle('music:rename', { requiresUnlock: true }, (req) => h.rename(req));
  handle('music:delete', { requiresUnlock: true }, (req) => h.delete(req));
  return h;
}
