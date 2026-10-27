// presentation:getConfig, presentation:saveDefaults y playlists:setPresentation (docs/DESIGN.md
// §10.2, §17.2). Todos "U". Fuente de verdad única de la música (§9.2): las pistas de una playlist
// solo en playlist_music y las pistas por defecto solo en kv['presentation.defaultTracks'] (las dos
// en la DB cifrada); `presentation_json` y prefs.presentationDefaults nunca llevan `trackIds`.
//
// - getConfig { playlistId? }: con `presentation_json`, ese JSON + playlist_music por `position`;
//   si no (o sin playlistId), prefs.presentationDefaults + kv. Los ids que ya no existen en
//   music_tracks se descartan al componer y `tracks` va en el mismo orden. NOT_FOUND si la playlist
//   no existe. Un `presentation_json` que no valida se trata como ausente (`warn`).
// - saveDefaults { settings }: trackIds tienen que existir (NOT_FOUND); kv en la DB y la parte en
//   claro en prefs/<profileId>.json.
// - setPresentation { id, settings | null }: una transacción en playlist-repo.ts.
import { AppErrorException } from '@shared/errors';
import type { ReqOf, ResOf } from '@shared/ipc-contract';
import { splitPresentation } from '@shared/presentation';
import type { Id, PresentationPlainSettings } from '@shared/types';
import type { Db } from '../../db/database';
import { KV_DEFAULT_TRACKS, kvGet, kvSet } from '../../db/repos/kv-repo';
import { allTracksExist, tracksInOrder } from '../../db/repos/music-repo';
import { playlistPresentation, setPlaylistPresentation } from '../../db/repos/playlist-repo';
import { log } from '../../log';
import type { SessionManager } from '../../session/session-manager';
import { PRESENTATION_PLAIN_SCHEMA, type PrefsStore } from '../../settings/settings-store';
import { handle } from '../register';

export interface PresentationHandlerDeps {
  session: Pick<SessionManager, 'epoch' | 'getDb' | 'currentProfileId' | 'isUnlocked'>;
  prefs: Pick<PrefsStore, 'get' | 'set'>;
  now?: () => number;
}

export interface PresentationHandlers {
  getConfig(req: ReqOf<'presentation:getConfig'>): Promise<ResOf<'presentation:getConfig'>>;
  saveDefaults(req: ReqOf<'presentation:saveDefaults'>): Promise<void>;
  setPresentation(req: ReqOf<'playlists:setPresentation'>): void;
}

function activeProfile(session: PresentationHandlerDeps['session']): Id {
  const id = session.currentProfileId;
  if (!id || !session.isUnlocked) throw new AppErrorException({ code: 'LOCKED' });
  return id;
}

/** Ajustes propios de una playlist ya guardados, o null si no tiene (o no validan). */
function storedPlain(json: string | null): PresentationPlainSettings | null {
  if (json === null) return null;
  try {
    const parsed = PRESENTATION_PLAIN_SCHEMA.safeParse(JSON.parse(json));
    if (parsed.success) return parsed.data;
  } catch {
    // cae al warn
  }
  log.warn('presentation.invalid-json');
  return null;
}

function compose(db: Db, plain: PresentationPlainSettings, ids: readonly Id[]) {
  const tracks = tracksInOrder(db, ids);
  return { settings: { ...plain, trackIds: tracks.map((t) => t.id) }, tracks };
}

/** Cuerpos de los handlers, sin ipcMain (los tests los llaman directamente). */
export function presentationHandlers(deps: PresentationHandlerDeps): PresentationHandlers {
  const { session, prefs } = deps;
  const now = deps.now ?? (() => Date.now());
  return {
    getConfig: async ({ playlistId }) => {
      const profileId = activeProfile(session);
      const epoch = session.epoch;
      if (playlistId !== undefined) {
        const stored = playlistPresentation(session.getDb(epoch), playlistId);
        if (!stored) throw new AppErrorException({ code: 'NOT_FOUND' });
        const plain = storedPlain(stored.json);
        if (plain) return compose(session.getDb(epoch), plain, stored.trackIds);
      }
      const defaults = (await prefs.get(profileId)).presentationDefaults;
      // Tras el await, la DB de la MISMA sesión (si se bloqueó, LOCKED).
      const db = session.getDb(epoch);
      return compose(db, defaults, kvGet(db, KV_DEFAULT_TRACKS) ?? []);
    },
    saveDefaults: async ({ settings }) => {
      const profileId = activeProfile(session);
      const { plain, trackIds } = splitPresentation(settings);
      const db = session.getDb(session.epoch);
      if (!allTracksExist(db, trackIds)) throw new AppErrorException({ code: 'NOT_FOUND' });
      kvSet(db, KV_DEFAULT_TRACKS, trackIds);
      await prefs.set(profileId, { presentationDefaults: plain });
    },
    setPresentation: ({ id, settings }) => {
      setPlaylistPresentation(
        session.getDb(session.epoch),
        id,
        settings ? splitPresentation(settings) : null,
        now(),
      );
    },
  };
}

export function registerPresentationHandlers(deps: PresentationHandlerDeps): PresentationHandlers {
  const h = presentationHandlers(deps);
  handle('presentation:getConfig', { requiresUnlock: true }, (req) => h.getConfig(req));
  handle('presentation:saveDefaults', { requiresUnlock: true }, (req) => h.saveDefaults(req));
  handle('playlists:setPresentation', { requiresUnlock: true }, (req) => h.setPresentation(req));
  return h;
}
