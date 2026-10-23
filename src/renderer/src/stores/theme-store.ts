// Tema (docs/DESIGN.md §15.4 y §15.9): ajustes globales (settings.json), tema del perfil
// desbloqueado (prefs; null = heredar), esquema del sistema, movimiento reducido y estado de la
// ventana (el fondo se pausa minimizado u oculto, §15.7). Todo en claro: no revela la bóveda.
import { create } from 'zustand';
import type { ThemeId } from '@shared/themes';
import type { ColorSchemePref, GlobalSettings, WindowState } from '@shared/types';
import { initialTheme } from '../lib/ipc';

export interface ProfileTheme {
  themeId: ThemeId | null;
  colorScheme: ColorSchemePref | null;
}

interface ThemeState {
  /** El selector y el desbloqueo usan el global; tras desbloquear, el del perfil. */
  scope: 'picker' | 'profile';
  global: GlobalSettings;
  profileTheme: ProfileTheme;
  systemDark: boolean;
  reducedMotion: boolean;
  windowState: WindowState;
  setGlobal(patch: Partial<GlobalSettings>): void;
  enterProfile(theme: ProfileTheme): void;
  setProfileTheme(patch: Partial<ProfileTheme>): void;
  setSystemDark(dark: boolean): void;
  setReducedMotion(reduced: boolean): void;
  setWindowState(state: WindowState): void;
}

function media(query: string): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia(query).matches;
}

// Hasta que llega settings:get, el tema y el esquema que calculó main al crear la ventana (§15.4).
const start = initialTheme();

export const useThemeStore = create<ThemeState>((set) => ({
  scope: 'picker',
  global: { pickerThemeId: start.themeId, colorScheme: start.scheme },
  profileTheme: { themeId: null, colorScheme: null },
  systemDark: media('(prefers-color-scheme: dark)'),
  reducedMotion: media('(prefers-reduced-motion: reduce)'),
  windowState: {
    maximized: false,
    minimized: false,
    fullscreen: false,
    focused: true,
    visible: true,
  },
  setGlobal: (patch) => set((s) => ({ global: { ...s.global, ...patch } })),
  enterProfile: (theme) => set({ scope: 'profile', profileTheme: { ...theme } }),
  setProfileTheme: (patch) => set((s) => ({ profileTheme: { ...s.profileTheme, ...patch } })),
  setSystemDark: (systemDark) => set({ systemDark }),
  setReducedMotion: (reducedMotion) => set({ reducedMotion }),
  setWindowState: (windowState) => set({ windowState }),
}));
