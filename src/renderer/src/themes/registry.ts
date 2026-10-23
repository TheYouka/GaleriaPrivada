// Registro de temas (docs/DESIGN.md §15.1): definiciones completas de los temas implementados. F1:
// `fotos` completo y el stub de `ps3` (§15.13); F6 añade `xbox`, `macos` y `album`. Puro (sin React
// ni DOM): lo usan build-css, ThemeProvider y los tests.
import {
  DEFAULT_THEME_ID,
  getThemeEntry,
  resolveScheme,
  type ColorScheme,
  type ThemeId,
} from '@shared/themes';
import type { ColorSchemePref, GlobalSettings } from '@shared/types';
import type { ThemeDefinition } from './theme-types';
import { FOTOS_BG_EXTREMES, FOTOS_MOTION, FOTOS_TOKENS } from './tokens/fotos';
import { PS3_BG_EXTREMES, PS3_MOTION, PS3_TOKENS } from './tokens/ps3';

const FOTOS: ThemeDefinition = {
  id: 'fotos',
  displayName: getThemeEntry('fotos').displayName,
  schemes: getThemeEntry('fotos').schemes,
  tokens: FOTOS_TOKENS,
  shell: 'sidebar',
  titlebar: 'fluent',
  background: 'mica',
  tile: 'rounded',
  picker: 'fluent',
  motion: FOTOS_MOTION,
  bgExtremes: FOTOS_BG_EXTREMES,
};

const PS3: ThemeDefinition = {
  id: 'ps3',
  displayName: getThemeEntry('ps3').displayName,
  schemes: getThemeEntry('ps3').schemes,
  tokens: PS3_TOKENS,
  shell: 'xmb',
  titlebar: 'xmb',
  background: 'waves',
  tile: 'xmb',
  picker: 'xmb-row',
  motion: PS3_MOTION,
  bgExtremes: PS3_BG_EXTREMES,
};

/** Temas implementados, en el orden del catálogo de src/shared/themes.ts. */
export const THEMES: readonly ThemeDefinition[] = Object.freeze([FOTOS, PS3]);

const BY_ID: ReadonlyMap<ThemeId, ThemeDefinition> = new Map(THEMES.map((t) => [t.id, t]));

/** Definición del tema; si no está implementado en esta versión, la del predeterminado. */
export function getThemeDefinition(id: ThemeId): ThemeDefinition {
  return BY_ID.get(id) ?? (BY_ID.get(DEFAULT_THEME_ID) as ThemeDefinition);
}

export interface ThemeInputs {
  /** `picker`: selector, desbloqueo y pantallas de perfiles (bóveda bloqueada). */
  scope: 'picker' | 'profile';
  global: GlobalSettings;
  /** prefs del perfil desbloqueado; null = heredar el global (§15.9). */
  profileTheme: { themeId: ThemeId | null; colorScheme: ColorSchemePref | null };
  systemDark: boolean;
}

export interface ResolvedTheme {
  def: ThemeDefinition;
  scheme: ColorScheme;
  /** Preferencia efectiva antes de resolver `system` (para Ajustes). */
  schemePref: ColorSchemePref;
}

/**
 * Tema y esquema efectivos (§15.4, §15.9, §15.10): el del perfil tras desbloquear (o el global si
 * hereda), `system` resuelto con el sistema, el primero de `schemes` si el tema no admite el pedido,
 * y fondo oscuro forzado en las pantallas de perfiles del selector `fluent` (estilo Netflix).
 */
export function resolveTheme(input: ThemeInputs): ResolvedTheme {
  const inProfile = input.scope === 'profile';
  const themeId = (inProfile && input.profileTheme.themeId) || input.global.pickerThemeId;
  const def = getThemeDefinition(themeId);
  const schemePref = (inProfile && input.profileTheme.colorScheme) || input.global.colorScheme;
  const wanted: ColorScheme =
    schemePref === 'system' ? (input.systemDark ? 'dark' : 'light') : schemePref;
  let scheme = resolveScheme(def.id, wanted);
  if (!inProfile && def.picker === 'fluent' && def.schemes.includes('dark')) scheme = 'dark';
  return { def, scheme, schemePref };
}
