// Registro de temas (docs/DESIGN.md §15.1): definiciones de los 5 temas (`ALL_THEMES`) y de los
// disponibles en esta versión (`THEMES`, los que marca `available` el catálogo de src/shared/themes.ts).
// F6 (6.1) define los tokens de `xbox`, `macos` y `cine`; sus shells, fondos y selectores llegan con
// 6.2–6.4, que los marcan como disponibles. Puro (sin React ni DOM): lo usan build-css,
// ThemeProvider y los tests.
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
import { CINE_BG_EXTREMES, CINE_MOTION, CINE_TOKENS } from './tokens/cine';
import { MACOS_BG_EXTREMES, MACOS_MOTION, MACOS_TOKENS } from './tokens/macos';
import { PS3_BG_EXTREMES, PS3_MOTION, PS3_TOKENS } from './tokens/ps3';
import { XBOX_BG_EXTREMES, XBOX_MOTION, XBOX_TOKENS } from './tokens/xbox';

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

const XBOX: ThemeDefinition = {
  id: 'xbox',
  displayName: getThemeEntry('xbox').displayName,
  schemes: getThemeEntry('xbox').schemes,
  tokens: XBOX_TOKENS,
  shell: 'pivot',
  titlebar: 'xbox',
  background: 'solid',
  tile: 'flat',
  picker: 'tiles',
  motion: XBOX_MOTION,
  bgExtremes: XBOX_BG_EXTREMES,
};

const MACOS: ThemeDefinition = {
  id: 'macos',
  displayName: getThemeEntry('macos').displayName,
  schemes: getThemeEntry('macos').schemes,
  tokens: MACOS_TOKENS,
  shell: 'vibrancy',
  titlebar: 'traffic-lights',
  background: 'wallpaper',
  tile: 'vibrancy',
  picker: 'login',
  motion: MACOS_MOTION,
  bgExtremes: MACOS_BG_EXTREMES,
};

const CINE: ThemeDefinition = {
  id: 'cine',
  displayName: getThemeEntry('cine').displayName,
  schemes: getThemeEntry('cine').schemes,
  tokens: CINE_TOKENS,
  shell: 'topbar',
  titlebar: 'cine',
  background: 'gradient',
  tile: 'poster',
  picker: 'showcase',
  motion: CINE_MOTION,
  bgExtremes: CINE_BG_EXTREMES,
};

/** Los 5 temas, en el orden del catálogo de src/shared/themes.ts (tokens, CSS y test de contraste). */
export const ALL_THEMES: readonly ThemeDefinition[] = Object.freeze([
  FOTOS,
  XBOX,
  PS3,
  MACOS,
  CINE,
]);

/** Temas disponibles en esta versión (los que ofrece el selector y acepta main). */
export const THEMES: readonly ThemeDefinition[] = Object.freeze(
  ALL_THEMES.filter((t) => getThemeEntry(t.id).available),
);

const BY_ID: ReadonlyMap<ThemeId, ThemeDefinition> = new Map(THEMES.map((t) => [t.id, t]));

/** Definición del tema; si no está disponible en esta versión, la del predeterminado. */
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
