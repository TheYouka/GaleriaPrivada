// Sesión vista desde el renderer (docs/DESIGN.md §13): bloqueada (selector de perfiles) o abierta
// con un perfil y sus preferencias. El renderer nunca tiene claves; al bloquear, main sustituye la
// ventana, así que no hay transición de "abierta" a "bloqueada" dentro de una misma ventana.
import { create } from 'zustand';
import type { AppError } from '@shared/errors';
import type { AppInfo, ProfilePrefs, ProfileSummary } from '@shared/types';
import { invoke, on } from '../lib/ipc';
import { useNavStore } from './nav-store';
import { useThemeStore } from './theme-store';

export type SessionStatus = 'loading' | 'locked' | 'unlocked' | 'locking';

interface SessionStoreState {
  status: SessionStatus;
  profile: ProfileSummary | null;
  prefs: ProfilePrefs | null;
  /** profiles:list; null mientras carga. */
  profiles: ProfileSummary[] | null;
  profilesError: AppError | null;
  appInfo: AppInfo | null;
  setUnlocked(profile: ProfileSummary, prefs: ProfilePrefs): void;
  setPrefs(prefs: ProfilePrefs): void;
}

export const useSessionStore = create<SessionStoreState>((set) => ({
  status: 'loading',
  profile: null,
  prefs: null,
  profiles: null,
  profilesError: null,
  appInfo: null,
  setUnlocked: (profile, prefs) => {
    useThemeStore
      .getState()
      .enterProfile({ themeId: prefs.themeId, colorScheme: prefs.colorScheme });
    set({ status: 'unlocked', profile, prefs });
    useNavStore.getState().navigate('gallery-all');
  },
  setPrefs: (prefs) => {
    useThemeStore
      .getState()
      .setProfileTheme({ themeId: prefs.themeId, colorScheme: prefs.colorScheme });
    set({ prefs });
  },
}));

/** profiles:list (con la bóveda bloqueada). */
export async function refreshProfiles(): Promise<void> {
  const res = await invoke('profiles:list');
  if (res.ok) useSessionStore.setState({ profiles: res.data, profilesError: null });
  else useSessionStore.setState({ profiles: [], profilesError: res.error });
}

/**
 * Arranque del renderer (§13.3, "El nuevo arranca en el selector"): estado de la sesión, ajustes
 * globales, información de la app y estado de la ventana. Una ventana nueva siempre nace con la
 * sesión bloqueada; si no (recarga en desarrollo), se bloquea.
 */
export async function bootstrapSession(): Promise<void> {
  const [state, settings, info, win] = await Promise.all([
    invoke('session:getState'),
    invoke('settings:get'),
    invoke('app:getInfo'),
    invoke('window:getState'),
  ]);
  const theme = useThemeStore.getState();
  if (settings.ok) theme.setGlobal(settings.data);
  if (win.ok) theme.setWindowState(win.data);
  if (info.ok) useSessionStore.setState({ appInfo: info.data });
  if (state.ok && state.data.state === 'locked') {
    useSessionStore.setState({ status: 'locked' });
    return;
  }
  useSessionStore.setState({ status: 'locking' });
  await invoke('session:lock');
}

/**
 * Bloqueo manual (candado y Ctrl+L, §13.2). main pinta el velo (session:locking) y sustituye la
 * ventana por otra nueva con el selector.
 */
export function lockSession(): void {
  void invoke('session:lock');
}

/** window:state → estado de la ventana (pausa del fondo, icono de maximizar). */
export function subscribeWindowState(): () => void {
  return on('window:state', (state) => useThemeStore.getState().setWindowState(state));
}
