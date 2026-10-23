// Contraste AA de §15.11 para `fotos` claro y oscuro y `ps3` oscuro, con `surface-alpha` compuesto
// sobre el fondo y sobre los dos `bgExtremes`.
import { describe, expect, it } from 'vitest';
import { AVAILABLE_THEME_IDS } from '@shared/themes';
import {
  composite,
  contrastRatio,
  mix,
  parseColor,
  themeContrastChecks,
  toHex,
} from '@renderer/themes/contrast';
import { THEMES } from '@renderer/themes/registry';
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

describe('contraste AA de los temas implementados (§15.11)', () => {
  it('se prueban exactamente los temas disponibles', () => {
    expect(THEMES.map((t) => t.id)).toEqual([...AVAILABLE_THEME_IDS]);
  });

  for (const def of THEMES) {
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
    const ps3 = THEMES.find((t) => t.id === 'ps3');
    expect(ps3?.bgExtremes.dark).toEqual(wavesExtremes());
    expect(wavesExtremes()[0]).toBe(WAVES_PALETTE.top);
    // Tres cintas al 7 % de blanco sobre el azul de abajo: más claro que el de abajo.
    expect(contrastRatio(wavesExtremes()[1], WAVES_PALETTE.bottom)).toBeGreaterThan(1);
  });

  it('los extremos de `fotos` son el fondo y el fondo con el acento al 15 % (mica)', () => {
    const fotos = THEMES.find((t) => t.id === 'fotos');
    for (const scheme of ['light', 'dark'] as const) {
      const t = fotos?.tokens[scheme];
      expect(fotos?.bgExtremes[scheme]).toEqual([t?.bg, mix(t?.bg ?? '', t?.accent ?? '', 0.15)]);
    }
  });
});
