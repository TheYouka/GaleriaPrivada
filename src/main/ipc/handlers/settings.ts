// settings:* (global, sin "U": tema y esquema del selector) y prefs:* ("U": preferencias del perfil
// desbloqueado). Todo en claro (docs/DESIGN.md §8.4 y §15.9).
import { AppErrorException } from '@shared/errors';
import type { Id } from '@shared/types';
import type { SessionManager } from '../../session/session-manager';
import type { PrefsStore, SettingsStore } from '../../settings/settings-store';
import { handle } from '../register';

export interface SettingsHandlerDeps {
  settings: SettingsStore;
  prefs: PrefsStore;
  session: SessionManager;
}

/** Perfil de la sesión desbloqueada. register.ts ya devolvió LOCKED si no la hay; esto cubre una carrera. */
function activeProfile(session: SessionManager): Id {
  const id = session.currentProfileId;
  if (!id || !session.isUnlocked) throw new AppErrorException({ code: 'LOCKED' });
  return id;
}

export function registerSettingsHandlers({ settings, prefs, session }: SettingsHandlerDeps): void {
  handle('settings:get', { requiresUnlock: false }, () => settings.get());
  handle('settings:set', { requiresUnlock: false }, (patch) => settings.set(patch));

  handle('prefs:get', { requiresUnlock: true }, () => prefs.get(activeProfile(session)));
  handle('prefs:set', { requiresUnlock: true }, async (patch) => {
    const profileId = activeProfile(session);
    const next = await prefs.set(profileId, patch);
    // Inactividad y protección de contenido (D15) se aplican al momento.
    if (session.isUnlocked && session.currentProfileId === profileId) session.applyPrefs(next);
    return next;
  });
}
