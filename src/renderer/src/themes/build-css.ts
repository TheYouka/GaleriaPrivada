// Reglas CSS de los tokens (docs/DESIGN.md §15.4): una regla
// `[data-theme="<id>"][data-scheme="<s>"] { --g-…: …; }` por tema y esquema admitido. Puro: lo
// usa ThemeProvider (adoptedStyleSheets) y tests/unit/renderer/build-css.test.ts. Los selectores no
// llevan `:root`, así que también valen dentro de un contenedor (ThemePreview).
import type { ColorScheme } from '@shared/themes';
import { THEMES } from './registry';
import { TOKEN_NAMES, type ThemeDefinition, type ThemeTokens } from './theme-types';

/** Un valor nunca puede cerrar la declaración ni la regla. */
const UNSAFE_VALUE = /[;{}<>\\]|\/\*|\*\//;

export function themeSelector(id: string, scheme: ColorScheme): string {
  return `[data-theme="${id}"][data-scheme="${scheme}"]`;
}

export function buildThemeRule(id: string, scheme: ColorScheme, tokens: ThemeTokens): string {
  const lines = [`  color-scheme: ${scheme};`];
  for (const name of TOKEN_NAMES) {
    const value = tokens[name];
    if (typeof value !== 'string' || value.trim() === '') {
      throw new RangeError(`Falta el token ${name} en ${id}/${scheme}`);
    }
    if (UNSAFE_VALUE.test(value))
      throw new RangeError(`Valor no válido en ${id}/${scheme}: ${name}`);
    lines.push(`  --g-${name}: ${value};`);
  }
  return `${themeSelector(id, scheme)} {\n${lines.join('\n')}\n}`;
}

/** Todas las reglas de los temas dados (por defecto, los implementados). */
export function buildThemeCss(themes: readonly ThemeDefinition[] = THEMES): string {
  const rules: string[] = [];
  for (const def of themes) {
    for (const scheme of def.schemes) {
      const tokens = def.tokens[scheme];
      if (!tokens) throw new RangeError(`${def.id} admite ${scheme} pero no tiene sus tokens`);
      rules.push(buildThemeRule(def.id, scheme, tokens));
    }
  }
  return `${rules.join('\n\n')}\n`;
}
