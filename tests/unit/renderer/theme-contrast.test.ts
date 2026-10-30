// Contraste AA de §15.11 para los 5 temas y todos sus esquemas (`fotos` y `macos` claro y oscuro;
// `xbox`, `ps3` y `cine` oscuro), con `surface-alpha` compuesto sobre el fondo y sobre los dos
// `bgExtremes`.
import { describe, expect, it } from 'vitest';
import { THEME_IDS } from '@shared/themes';
import {
  composite,
  contrastRatio,
  mix,
  parseColor,
  themeContrastChecks,
  toHex,
} from '@renderer/themes/contrast';
import { ALL_THEMES } from '@renderer/themes/registry';
import { CINE_PALETTE } from '@renderer/themes/tokens/cine';
import { MACOS_WALLPAPER } from '@renderer/themes/tokens/macos';
import { XBOX_VIGNETTE } from '@renderer/themes/tokens/xbox';
import { WAVES_PALETTE, wavesExtremes } from '@renderer/themes/backgrounds/waves';

describe('contrast.ts', () => {
  it('parsea hex corto, largo, con alfa y rgb/rgba', () => {
    expect(parseColor('#fff')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseColor('#005FB8')).toEqual({ r: 0, g: 95, b: 184, a: 1 });
    expect(parseColor('#00000080').a).toBeCloseTo(128 / 255);
    expect(parseColor('rgba(6, 16, 34, 0.6)')).toEqual({ r: 6, g: 16, b: 34, a: 0.6 });
    expect(parseColor('rgb(1,2,3)')).toEqual({ r: 1, g: 2, b: 3, a: 1 });
    expect(() => parseColor('red')).toThrow(RangeError);
    expect(() => parseColor('rgb(300, 0, 0)')).toThrow(RangeError);
  });

  it('valores de referencia de WCAG', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
    expect(contrastRatio('#FFFFFF', '#FFFFFF')).toBeCloseTo(1, 5);
    expect(contrastRatio('#767676', '#FFFFFF')).toBeGreaterThan(4.5);
    expect(contrastRatio('#777777', '#FFFFFF')).toBeLessThan(4.5);
    expect(() => contrastRatio('rgba(0,0,0,0.5)', '#FFFFFF')).toThrow(RangeError);
  });

  it('compone un color translúcido sobre uno opaco', () => {
    expect(toHex(composite(parseColor('rgba(0, 0, 0, 0.5)'), parseColor('#FFFFFF')))).toBe(
      '#808080',
    );
    expect(mix('#000000', '#FFFFFF', 0.25)).toBe('#404040');
  });
});

describe('contraste AA de los 5 temas (§15.11)', () => {
  it('se prueban los 5 temas del catálogo y todos sus esquemas', () => {
    expect(ALL_THEMES.map((t) => t.id)).toEqual([...THEME_IDS]);
    expect(ALL_THEMES.flatMap((t) => t.schemes.map((s) => `${t.id}/${s}`))).toEqual([
      'fotos/light',
      'fotos/dark',
      'xbox/dark',
      'ps3/dark',
      'macos/light',
      'macos/dark',
      'cine/dark',
    ]);
  });

  for (const def of ALL_THEMES) {
    for (const scheme of def.schemes) {
      it(`${def.id} ${scheme}`, () => {
        const checks = themeContrastChecks(def, scheme);
        expect(checks.length).toBeGreaterThan(30);
        const failures = checks
          .filter((c) => c.ratio < c.min)
          .map((c) => `${c.label}: ${c.ratio.toFixed(2)} < ${c.min}`);
        expect(failures).toEqual([]);
      });
    }
  }

  it('los extremos de `ps3` son los que pintan las ondas', () => {
    const ps3 = ALL_THEMES.find((t) => t.id === 'ps3');
    expect(ps3?.bgExtremes.dark).toEqual(wavesExtremes());
    // El más oscuro cubre los 12 meses con el brillo mínimo (no más claro que el azul base).
    expect(contrastRatio(wavesExtremes()[0], WAVES_PALETTE.top)).toBeGreaterThan(1);
    // Tres cintas al 7 % de blanco sobre el azul de abajo: más claro que el de abajo.
    expect(contrastRatio(wavesExtremes()[1], WAVES_PALETTE.bottom)).toBeGreaterThan(1);
  });

  it('los extremos de `fotos` son el fondo y el fondo con el acento al 15 % (mica)', () => {
    const fotos = ALL_THEMES.find((t) => t.id === 'fotos');
    for (const scheme of ['light', 'dark'] as const) {
      const t = fotos?.tokens[scheme];
      expect(fotos?.bgExtremes[scheme]).toEqual([t?.bg, mix(t?.bg ?? '', t?.accent ?? '', 0.15)]);
    }
  });

  it('los extremos de `xbox`, `macos` y `cine` son los colores que pinta su fondo', () => {
    const by = (id: string) => ALL_THEMES.find((t) => t.id === id);
    expect(by('xbox')?.bgExtremes.dark).toEqual([XBOX_VIGNETTE.edge, XBOX_VIGNETTE.center]);
    for (const scheme of ['light', 'dark'] as const) {
      expect(by('macos')?.bgExtremes[scheme]).toEqual([
        MACOS_WALLPAPER[scheme].from,
        MACOS_WALLPAPER[scheme].to,
      ]);
    }
    expect(by('cine')?.bgExtremes.dark).toEqual([CINE_PALETTE.bgTop, CINE_PALETTE.glow]);
    expect(by('cine')?.tokens.dark?.bg).toBe(CINE_PALETTE.bgTop);
    expect(by('cine')?.tokens.dark?.['focus-ring']).toBe('#FFFFFF');
  });

  it('cada tema admite solo los esquemas con tokens y extremos, y `cine` solo el oscuro', () => {
    for (const def of ALL_THEMES) {
      for (const scheme of ['light', 'dark'] as const) {
        const supported = def.schemes.includes(scheme);
        expect(def.tokens[scheme] !== undefined).toBe(supported);
        expect(def.bgExtremes[scheme] !== undefined).toBe(supported);
      }
    }
    expect(ALL_THEMES.find((t) => t.id === 'cine')?.schemes).toEqual(['dark']);
  });
});
