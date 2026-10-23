// Hoja de tokens y atributos de <html> (docs/DESIGN.md §15.4). La hoja se añade con
// `new CSSStyleSheet()` + `replaceSync()` + `document.adoptedStyleSheets` (la CSP lo permite con
// style-src 'unsafe-inline') antes del primer render.
import { buildThemeCss } from './build-css';
import type { ResolvedTheme } from './registry';

let installed = false;

export function installThemeSheet(): void {
  if (installed) return;
  installed = true;
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(buildThemeCss());
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
}

/** data-theme, data-scheme y data-reduced-motion en <html>. */
export function applyDocumentTheme(theme: ResolvedTheme, reducedMotion: boolean): void {
  const html = document.documentElement;
  html.dataset.theme = theme.def.id;
  html.dataset.scheme = theme.scheme;
  html.dataset.reducedMotion = reducedMotion ? 'true' : 'false';
}
