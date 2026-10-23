// Contraste WCAG 2.x (docs/DESIGN.md §15.11). Puro: lo usan los tokens (extremos del fondo) y
// tests/unit/renderer/theme-contrast.test.ts. Las superficies translúcidas se componen sobre el
// fondo antes de medir.
import type { ColorScheme } from '@shared/themes';
import type { ThemeDefinition } from './theme-types';

export interface Rgba {
  r: number;
  g: number;
  b: number;
  /** 0–1. */
  a: number;
}

/** Texto normal (AA). */
export const AA_TEXT = 4.5;
/** Componentes de interfaz y foco (AA, 1.4.11). */
export const AA_UI = 3;

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const RGB = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*(\d*\.?\d+)\s*)?\)$/i;

export function parseColor(input: string): Rgba {
  const s = input.trim();
  const hex = HEX.exec(s);
  if (hex) {
    let h = hex[1] as string;
    if (h.length === 3) h = [...h].map((c) => c + c).join('');
    const n = Number.parseInt(h.slice(0, 6), 16);
    const a = h.length === 8 ? Number.parseInt(h.slice(6), 16) / 255 : 1;
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a };
  }
  const rgb = RGB.exec(s);
  if (rgb) {
    const [r, g, b] = [rgb[1], rgb[2], rgb[3]].map((v) => Number(v));
    const a = rgb[4] === undefined ? 1 : Number(rgb[4]);
    if ([r, g, b].some((v) => (v as number) > 255) || a > 1) {
      throw new RangeError(`Color fuera de rango: ${input}`);
    }
    return { r: r as number, g: g as number, b: b as number, a };
  }
  throw new RangeError(`Color no admitido: ${input}`);
}

/** `top` (con su alfa) sobre `bottom`. */
export function composite(top: Rgba, bottom: Rgba): Rgba {
  const a = top.a + bottom.a * (1 - top.a);
  if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
  const ch = (t: number, b: number): number => (t * top.a + b * bottom.a * (1 - top.a)) / a;
  return { r: ch(top.r, bottom.r), g: ch(top.g, bottom.g), b: ch(top.b, bottom.b), a };
}

export function toHex(c: Rgba): string {
  const h = (v: number): string =>
    Math.round(Math.min(255, Math.max(0, v)))
      .toString(16)
      .padStart(2, '0');
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`.toUpperCase();
}

/** `over` con opacidad `amount` sobre `base` (opaco), en hexadecimal. */
export function mix(base: string, over: string, amount: number): string {
  return toHex(composite({ ...parseColor(over), a: amount }, parseColor(base)));
}

function channel(v: number): number {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function luminance(c: Rgba): number {
  return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
}

/** Relación de contraste entre dos colores opacos. */
export function contrastRatio(a: string | Rgba, b: string | Rgba): number {
  const ca = typeof a === 'string' ? parseColor(a) : a;
  const cb = typeof b === 'string' ? parseColor(b) : b;
  if (ca.a < 1 || cb.a < 1) throw new RangeError('El contraste solo se mide entre colores opacos');
  const la = luminance(ca);
  const lb = luminance(cb);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export interface ContrastCheck {
  label: string;
  ratio: number;
  min: number;
}

/**
 * Parejas de §15.11 más las que usa la interfaz de F1 (botones de peligro, texto sobre el fondo del
 * selector, aviso). Cada superficie translúcida se compone sobre el fondo y sobre los dos extremos.
 */
export function themeContrastChecks(def: ThemeDefinition, scheme: ColorScheme): ContrastCheck[] {
  const t = def.tokens[scheme];
  const extremes = def.bgExtremes[scheme];
  if (!t || !extremes) throw new RangeError(`${def.id} no admite el esquema ${scheme}`);
  const out: ContrastCheck[] = [];
  const check = (label: string, fg: string | Rgba, bg: string | Rgba, min: number): void => {
    out.push({ label, ratio: contrastRatio(fg, bg), min });
  };

  // §15.11
  check('text/bg', t.text, t.bg, AA_TEXT);
  check('text/surface', t.text, t.surface, AA_TEXT);
  check('text-muted/surface', t['text-muted'], t.surface, AA_TEXT);
  check('text-on-accent/accent', t['text-on-accent'], t.accent, AA_TEXT);
  check('danger-text/surface', t['danger-text'], t.surface, AA_TEXT);
  check('focus-ring/bg', t['focus-ring'], t.bg, AA_UI);
  check('focus-ring/surface', t['focus-ring'], t.surface, AA_UI);
  check('border-strong/surface', t['border-strong'], t.surface, AA_UI);
  check('accent/surface', t.accent, t.surface, AA_UI);

  // Lo que usa la interfaz de F1.
  check('text/bg-elevated', t.text, t['bg-elevated'], AA_TEXT);
  check('text-muted/bg', t['text-muted'], t.bg, AA_TEXT);
  check('text-muted/bg-elevated', t['text-muted'], t['bg-elevated'], AA_TEXT);
  check('text/surface-2', t.text, t['surface-2'], AA_TEXT);
  check('text/surface-hover', t.text, t['surface-hover'], AA_TEXT);
  check('text/surface-pressed', t.text, t['surface-pressed'], AA_TEXT);
  check('text-on-accent/accent-hover', t['text-on-accent'], t['accent-hover'], AA_TEXT);
  check('text-on-accent/accent-pressed', t['text-on-accent'], t['accent-pressed'], AA_TEXT);
  check('text-on-accent/danger', t['text-on-accent'], t.danger, AA_TEXT);
  check('danger-text/bg-elevated', t['danger-text'], t['bg-elevated'], AA_TEXT);
  check('warning/bg-elevated', t.warning, t['bg-elevated'], AA_UI);
  check('warning/surface', t.warning, t.surface, AA_UI);
  check('accent/bg', t.accent, t.bg, AA_UI);
  check('accent/bg-elevated', t.accent, t['bg-elevated'], AA_UI);
  check('border-strong/bg-elevated', t['border-strong'], t['bg-elevated'], AA_UI);
  check('focus-ring/bg-elevated', t['focus-ring'], t['bg-elevated'], AA_UI);

  // El fondo pinta cualquier color entre los dos extremos: el texto y el foco van directamente
  // encima en el selector y en la barra de título.
  const glassAlpha = parseColor(t['surface-alpha']);
  for (const [i, extreme] of [t.bg, extremes[0], extremes[1]].entries()) {
    const name = i === 0 ? 'bg' : `bgExtreme${i}`;
    if (i > 0) {
      check(`text/${name}`, t.text, extreme, AA_TEXT);
      check(`text-muted/${name}`, t['text-muted'], extreme, AA_TEXT);
      check(`focus-ring/${name}`, t['focus-ring'], extreme, AA_UI);
      check(`accent/${name}`, t.accent, extreme, AA_UI);
    }
    const glass = composite(glassAlpha, parseColor(extreme));
    check(`text/surface-alpha∘${name}`, t.text, glass, AA_TEXT);
    check(`text-muted/surface-alpha∘${name}`, t['text-muted'], glass, AA_TEXT);
    check(`focus-ring/surface-alpha∘${name}`, t['focus-ring'], glass, AA_UI);
    check(`accent/surface-alpha∘${name}`, t.accent, glass, AA_UI);
  }
  return out;
}
