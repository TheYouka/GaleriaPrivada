// build-css.ts: una regla por tema y esquema admitido, con todos los tokens --g-* de §15.3.
import { describe, expect, it } from 'vitest';
import { buildThemeCss, buildThemeRule, themeSelector } from '@renderer/themes/build-css';
import { getThemeDefinition, resolveTheme, THEMES } from '@renderer/themes/registry';
import { TOKEN_NAMES, type ThemeDefinition } from '@renderer/themes/theme-types';

function rulesOf(css: string): { selector: string; body: string }[] {
  return [...css.matchAll(/(\[data-theme="[^"]+"\]\[data-scheme="[^"]+"\]) \{\n([^}]*)\}/g)].map(
    (m) => ({ selector: m[1] as string, body: m[2] as string }),
  );
}

describe('buildThemeCss', () => {
  const css = buildThemeCss();
  const rules = rulesOf(css);

  it('genera una regla por tema y esquema admitido, y nada más', () => {
    const expected = THEMES.flatMap((t) => t.schemes.map((s) => themeSelector(t.id, s)));
    expect(expected).toEqual([
      '[data-theme="fotos"][data-scheme="light"]',
      '[data-theme="fotos"][data-scheme="dark"]',
      '[data-theme="ps3"][data-scheme="dark"]',
    ]);
    expect(rules.map((r) => r.selector)).toEqual(expected);
    expect(css.match(/\{/g)?.length).toBe(expected.length);
  });

  it('cada regla declara todos los tokens --g-* una vez y color-scheme', () => {
    for (const { selector, body } of rules) {
      const scheme = /data-scheme="([^"]+)"/.exec(selector)?.[1];
      expect(body).toContain(`color-scheme: ${scheme};`);
      const names = [...body.matchAll(/--g-([a-z0-9-]+):/g)].map((m) => m[1]);
      expect(names).toEqual([...TOKEN_NAMES]);
    }
  });

  it('usa los valores de los tokens', () => {
    expect(css).toContain('--g-accent: #005FB8;');
    expect(css).toContain('--g-accent: #60CDFF;');
    expect(css).toContain("--g-font-sans: 'Nunito Variable', sans-serif;");
    expect(css).not.toMatch(/Segoe|SF Pro|San Francisco|Helvetica/);
  });

  it('falla si un esquema admitido no tiene tokens o falta un token', () => {
    const fotos = getThemeDefinition('fotos');
    const broken: ThemeDefinition = { ...fotos, tokens: { light: fotos.tokens.light } };
    expect(() => buildThemeCss([broken])).toThrow(/no tiene sus tokens/);
    const partial = { ...fotos.tokens.light, accent: '' } as never;
    expect(() => buildThemeRule('fotos', 'light', partial)).toThrow(/Falta el token accent/);
  });

  it('rechaza valores que podrían cerrar la regla', () => {
    const tokens = { ...getThemeDefinition('fotos').tokens.dark, text: 'red; } body {' } as never;
    expect(() => buildThemeRule('fotos', 'dark', tokens)).toThrow(/no válido/);
  });
});

describe('resolveTheme (§15.4, §15.9, §15.10)', () => {
  const base = {
    global: { pickerThemeId: 'fotos', colorScheme: 'light' },
    profileTheme: { themeId: null, colorScheme: null },
    systemDark: false,
  } as const;

  it('el selector `fluent` fuerza el fondo oscuro aunque el esquema sea claro', () => {
    expect(resolveTheme({ ...base, scope: 'picker' }).scheme).toBe('dark');
    expect(resolveTheme({ ...base, scope: 'profile' }).scheme).toBe('light');
  });

  it('el perfil hereda el global con null y lo sustituye si tiene su tema', () => {
    const inherit = resolveTheme({ ...base, scope: 'profile' });
    expect(inherit.def.id).toBe('fotos');
    const own = resolveTheme({
      ...base,
      scope: 'profile',
      profileTheme: { themeId: 'ps3', colorScheme: null },
    });
    expect(own.def.id).toBe('ps3');
    // ps3 solo admite oscuro: el primero de sus esquemas.
    expect(own.scheme).toBe('dark');
    // En el selector manda siempre el global.
    expect(
      resolveTheme({
        ...base,
        scope: 'picker',
        profileTheme: { themeId: 'ps3', colorScheme: null },
      }).def.id,
    ).toBe('fotos');
  });

  it('`system` sigue al sistema', () => {
    const input = {
      ...base,
      scope: 'profile',
      global: { pickerThemeId: 'fotos', colorScheme: 'system' },
    } as const;
    expect(resolveTheme({ ...input, systemDark: true }).scheme).toBe('dark');
    expect(resolveTheme({ ...input, systemDark: false }).scheme).toBe('light');
    expect(resolveTheme(input).schemePref).toBe('system');
  });

  it('un tema no implementado usa el predeterminado', () => {
    expect(getThemeDefinition('album').id).toBe('fotos');
    expect(
      resolveTheme({
        ...base,
        scope: 'picker',
        global: { pickerThemeId: 'xbox', colorScheme: 'dark' },
      }).def.id,
    ).toBe('fotos');
  });
});
