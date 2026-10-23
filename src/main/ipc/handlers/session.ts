// session:* (docs/DESIGN.md §10.2 y §13). unlock, lock y getState no son "U"; activity y
// setPlayback sí.
import { toSummary } from '../../profiles/profile-service';
import type { SessionManager } from '../../session/session-manager';
import { handle } from '../register';

export interface SessionHandlerDeps {
  session: SessionManager;
}

export function registerSessionHandlers({ session }: SessionHandlerDeps): void {
  // [H3-8] Con la bóveda ausente, SessionManager.unlock lanza VAULT_UNAVAILABLE con
  // details.path = la ruta configurada (ya está en claro en profiles.json).
  handle('session:unlock', { requiresUnlock: false }, async ({ profileId, password }) => {
    const { profile, prefs } = await session.unlock(profileId, password);
    return { profile: toSummary(profile, 'ok', prefs.themeId), prefs };
  });
  handle('session:lock', { requiresUnlock: false }, () => session.lock('manual'));
  handle('session:getState', { requiresUnlock: false }, () => session.getState());
  handle('session:activity', { requiresUnlock: true }, () => {
    session.activity();
  });
  handle('session:setPlayback', { requiresUnlock: true }, ({ active }) => {
    session.setPlayback(active);
  });
}
