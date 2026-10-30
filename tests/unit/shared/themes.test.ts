// Catálogo de temas (docs/DESIGN.md §15.2, §15.4 y D10).
import { describe, expect, it } from 'vitest';
import {
  AVAILABLE_THEME_IDS,
  DEFAULT_THEME_ID,
  THEME_CATALOG,
  THEME_IDS,
  getThemeEntry,
  isThemeId,
  resolveScheme,
} from '@shared/themes';

describe('catálogo de temas', () => {
  it('tiene una entrada por id, en el mismo orden', () => {
    expect(THEME_CATALOG.map((t) => t.id)).toEqual([...THEME_IDS]);
    for (const id of THEME_IDS) expect(getThemeEntry(id).id).toBe(id);
  });

  it('los nombres visibles son los neutros de D10', () => {
    expect(Object.fromEntries(THEME_CATALOG.map((t) => [t.id, t.displayName]))).toEqual({
      fotos: 'Clásico',
      xbox: 'Mosaico',
      ps3: 'Ondas',
      macos: 'Cristal',
      cine: 'Cine',
    });
  });

  it('los cinco temas están disponibles y "Clásico" es el predeterminado', () => {
    expect(DEFAULT_THEME_ID).toBe('fotos');
    expect(AVAILABLE_THEME_IDS).toEqual(['fotos', 'xbox', 'ps3', 'macos', 'cine']);
  });

  it('esquemas admitidos de §15.2', () => {
    expect(getThemeEntry('fotos').schemes).toEqual(['light', 'dark']);
    expect(getThemeEntry('ps3').schemes).toEqual(['dark']);
    expect(getThemeEntry('xbox').schemes).toEqual(['dark']);
    expect(getThemeEntry('macos').schemes).toEqual(['light', 'dark']);
    expect(getThemeEntry('cine').schemes).toEqual(['dark']);
  });

  it('un esquema no admitido cae en el primero de schemes (§15.4)', () => {
    expect(resolveScheme('ps3', 'light')).toBe('dark');
    expect(resolveScheme('fotos', 'dark')).toBe('dark');
    expect(resolveScheme('cine', 'light')).toBe('dark');
    expect(resolveScheme('macos', 'light')).toBe('light');
  });

  it('isThemeId solo acepta los ids del catálogo', () => {
    expect(isThemeId('ps3')).toBe(true);
    expect(isThemeId('cine')).toBe(true);
    expect(isThemeId('album')).toBe(false);
    expect(isThemeId('Ondas')).toBe(false);
    expect(isThemeId('FOTOS')).toBe(false);
    expect(isThemeId(undefined)).toBe(false);
    expect(isThemeId(3)).toBe(false);
  });
});
