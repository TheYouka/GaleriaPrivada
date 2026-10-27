// playlists:list, create, rename, delete, addItems, removeItems y reorder (docs/DESIGN.md §10.2,
// §14.8). Todos "U"; la DB se pide con la época de la sesión actual [H3-6]. playlists:setPresentation
// vive en presentation.ts (reglas de §10.2 sobre la música de la presentación).
//
// Tras cambiar los elementos de una playlist (añadir, quitar, reordenar o borrarla) se emite
// library:changed { reason: 'playlist' } sin ids: la galería filtrada por esa playlist recarga.
import type { ReqOf, ResOf } from '@shared/ipc-contract';
import {
  addItems,
  createPlaylist,
  deletePlaylist,
  listPlaylists,
  removeItems,
  renamePlaylist,
  reorderItems,
  type AddItemsOptions,
} from '../../db/repos/playlist-repo';
import type { SessionManager } from '../../session/session-manager';
import type { LibraryEvents } from '../library-events';
import { handle } from '../register';

export interface PlaylistHandlerDeps {
  session: Pick<SessionManager, 'epoch' | 'getDb'>;
  library: Pick<LibraryEvents, 'changed'>;
  now?: () => number;
  /** Solo tests ([H3-4] con 40 000 ids): límite de elementos distinto de 2000. */
  limit?: AddItemsOptions['limit'];
}

export interface PlaylistHandlers {
  list(): ResOf<'playlists:list'>;
  create(req: ReqOf<'playlists:create'>): ResOf<'playlists:create'>;
  rename(req: ReqOf<'playlists:rename'>): ResOf<'playlists:rename'>;
  delete(req: ReqOf<'playlists:delete'>): void;
  addItems(req: ReqOf<'playlists:addItems'>): ResOf<'playlists:addItems'>;
  removeItems(req: ReqOf<'playlists:removeItems'>): ResOf<'playlists:removeItems'>;
  reorder(req: ReqOf<'playlists:reorder'>): void;
}

/** Cuerpos de los handlers, sin ipcMain (los tests los llaman directamente). */
export function playlistHandlers(deps: PlaylistHandlerDeps): PlaylistHandlers {
  const { session, library } = deps;
  const now = deps.now ?? (() => Date.now());
  const db = () => session.getDb(session.epoch);
  const changed = (): void => library.changed('playlist');
  return {
    list: () => listPlaylists(db()),
    create: ({ name }) => createPlaylist(db(), name, now()),
    rename: ({ id, name }) => renamePlaylist(db(), id, name, now()),
    delete: ({ id }) => {
      deletePlaylist(db(), id);
      changed();
    },
    addItems: ({ id, mediaIds }) => {
      const res = addItems(db(), id, mediaIds, { now: now(), limit: deps.limit });
      if (res.added > 0) changed();
      return res;
    },
    removeItems: ({ id, mediaIds }) => {
      const res = removeItems(db(), id, mediaIds, now());
      if (res.removed > 0) changed();
      return res;
    },
    reorder: ({ id, mediaIds }) => {
      reorderItems(db(), id, mediaIds, now());
      changed();
    },
  };
}

export function registerPlaylistHandlers(deps: PlaylistHandlerDeps): PlaylistHandlers {
  const h = playlistHandlers(deps);
  handle('playlists:list', { requiresUnlock: true }, () => h.list());
  handle('playlists:create', { requiresUnlock: true }, (req) => h.create(req));
  handle('playlists:rename', { requiresUnlock: true }, (req) => h.rename(req));
  handle('playlists:delete', { requiresUnlock: true }, (req) => h.delete(req));
  handle('playlists:addItems', { requiresUnlock: true }, (req) => h.addItems(req));
  handle('playlists:removeItems', { requiresUnlock: true }, (req) => h.removeItems(req));
  handle('playlists:reorder', { requiresUnlock: true }, (req) => h.reorder(req));
  return h;
}
