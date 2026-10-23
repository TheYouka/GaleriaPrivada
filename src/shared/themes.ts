// Catálogo de temas (docs/DESIGN.md §15.1, §15.2 y §15.12). Solo datos puros: lo usan main
// (validación de settings/prefs y additionalArguments), el preload (data-theme inicial) y el
// renderer (ThemePicker). Las definiciones completas (tokens, shell, fondo…) viven en
// src/renderer/src/themes/registry.ts.
//
// D10: los nombres visibles son neutros; los ids internos solo aparecen en el código.

export const THEME_IDS = ['fotos', 'xbox', 'ps3', 'macos', 'album'] as const;

export type ThemeId = (typeof THEME_IDS)[number];

export type ColorScheme = 'light' | 'dark';

/** Tema predeterminado de la app (§15.2). */
export const DEFAULT_THEME_ID: ThemeId = 'fotos';

export interface ThemeCatalogEntry {
  id: ThemeId;
  /** Nombre neutro visible en la UI (D10). */
  displayName: string;
  /** Esquemas admitidos; el primero es el predeterminado (§15.1, §15.4). */
  schemes: readonly ColorScheme[];
  /**
   * El tema está implementado en esta versión. F1: `fotos` completo y el stub de `ps3` (§15.13);
   * F6 completa el resto.
   */
  available: boolean;
}

export const THEME_CATALOG: readonly ThemeCatalogEntry[] = Object.freeze([
  { id: 'fotos', displayName: 'Clásico', schemes: ['light', 'dark'], available: true },
  { id: 'xbox', displayName: 'Mosaico', schemes: ['dark'], available: false },
  { id: 'ps3', displayName: 'Ondas', schemes: ['dark'], available: true },
  { id: 'macos', displayName: 'Cristal', schemes: ['light', 'dark'], available: false },
  { id: 'album', displayName: 'Álbum', schemes: ['light'], available: false },
] satisfies ThemeCatalogEntry[]);

const BY_ID: ReadonlyMap<ThemeId, ThemeCatalogEntry> = new Map(THEME_CATALOG.map((t) => [t.id, t]));

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === 'string' && (THEME_IDS as readonly string[]).includes(value);
}

export function getThemeEntry(id: ThemeId): ThemeCatalogEntry {
  // THEME_CATALOG cubre todos los ids (lo comprueba tests/unit/shared/themes.test.ts).
  return BY_ID.get(id) as ThemeCatalogEntry;
}

/** Ids de los temas implementados en esta versión, en el orden del catálogo. */
export const AVAILABLE_THEME_IDS: readonly ThemeId[] = Object.freeze(
  THEME_CATALOG.filter((t) => t.available).map((t) => t.id),
);

/** Si el tema no admite el esquema pedido, se usa el primero de `schemes` (§15.4). */
export function resolveScheme(id: ThemeId, scheme: ColorScheme): ColorScheme {
  const { schemes } = getThemeEntry(id);
  return schemes.includes(scheme) ? scheme : (schemes[0] as ColorScheme);
}
