// Tipos del sistema de temas (docs/DESIGN.md §15.1 y §15.3). Solo tipos y la lista de tokens: lo
// usan los tokens, el registro, build-css y los tests de contraste (sin React ni DOM).
import type { ColorScheme, ThemeId } from '@shared/themes';

/** Tokens de color de §15.3 (los que comprueba el test de contraste). */
export const COLOR_TOKEN_NAMES = [
  'bg',
  'bg-elevated',
  'surface',
  'surface-2',
  'surface-hover',
  'surface-pressed',
  'surface-alpha',
  'border',
  'border-strong',
  'text',
  'text-muted',
  'text-on-accent',
  'accent',
  'accent-hover',
  'accent-pressed',
  'accent-muted',
  'focus-ring',
  'selection',
  'selection-border',
  'danger',
  'danger-text',
  'warning',
  'success',
  'scrim',
  'tile-placeholder',
] as const;

/** Resto de grupos de §15.3: tipografía, forma, elevación, espaciado y movimiento. */
export const OTHER_TOKEN_NAMES = [
  'font-sans',
  'font-display',
  'font-hand',
  'text-xs',
  'text-sm',
  'text-base',
  'text-lg',
  'text-xl',
  'text-2xl',
  'text-3xl',
  'weight-regular',
  'weight-strong',
  'tracking-display',
  'radius-sm',
  'radius-md',
  'radius-lg',
  'radius-tile',
  'radius-avatar',
  'border-width',
  'shadow-sm',
  'shadow-md',
  'shadow-lg',
  'blur-surface',
  'saturate-surface',
  'space-unit',
  'tile-gap',
  'nav-width',
  'dur-fast',
  'dur-normal',
  'dur-slow',
  'ease-standard',
  'ease-emphasized',
  'ease-decelerate',
  'focus-scale',
  'hover-scale',
] as const;

export const TOKEN_NAMES = [...COLOR_TOKEN_NAMES, ...OTHER_TOKEN_NAMES] as const;

export type ColorTokenName = (typeof COLOR_TOKEN_NAMES)[number];
export type OtherTokenName = (typeof OTHER_TOKEN_NAMES)[number];
export type TokenName = (typeof TOKEN_NAMES)[number];

/** Valores de un tema y esquema: cada token se emite como `--g-<nombre>`. */
export type ThemeTokens = Readonly<Record<TokenName, string>>;
export type ColorTokens = Readonly<Record<ColorTokenName, string>>;
export type SharedTokens = Readonly<Record<OtherTokenName, string>>;

export interface MotionPreset {
  fastMs: number;
  normalMs: number;
  slowMs: number;
  ease: { standard: string; emphasized: string; decelerate: string };
  focusScale: number;
  hoverScale: number;
  staggerMs: number;
}

export type ShellKind = 'sidebar' | 'pivot' | 'xmb' | 'vibrancy' | 'topbar';
export type TitlebarKind = 'fluent' | 'xbox' | 'xmb' | 'traffic-lights' | 'album';
export type BackgroundKind = 'mica' | 'solid' | 'waves' | 'wallpaper' | 'paper';
export type TileKind = 'rounded' | 'flat' | 'xmb' | 'vibrancy' | 'polaroid';
export type PickerKind = 'fluent' | 'tiles' | 'xmb-row' | 'login' | 'polaroid';

/** §15.1. Los esquemas que el tema no admite no tienen tokens ni extremos. */
export interface ThemeDefinition {
  id: ThemeId;
  /** Nombre neutro visible (D10). */
  displayName: string;
  /** Admitidos; el primero es el predeterminado. */
  schemes: readonly ColorScheme[];
  tokens: Readonly<Partial<Record<ColorScheme, ThemeTokens>>>;
  shell: ShellKind;
  titlebar: TitlebarKind;
  background: BackgroundKind;
  tile: TileKind;
  picker: PickerKind;
  motion: MotionPreset;
  /** Colores extremos que puede pintar el fondo (test de contraste, §15.11). */
  bgExtremes: Readonly<Partial<Record<ColorScheme, readonly [string, string]>>>;
}

/** Tokens de movimiento en CSS a partir del preset (una sola fuente de verdad). */
export function motionTokens(
  m: MotionPreset,
): Pick<
  SharedTokens,
  | 'dur-fast'
  | 'dur-normal'
  | 'dur-slow'
  | 'ease-standard'
  | 'ease-emphasized'
  | 'ease-decelerate'
  | 'focus-scale'
  | 'hover-scale'
> {
  return {
    'dur-fast': `${m.fastMs}ms`,
    'dur-normal': `${m.normalMs}ms`,
    'dur-slow': `${m.slowMs}ms`,
    'ease-standard': m.ease.standard,
    'ease-emphasized': m.ease.emphasized,
    'ease-decelerate': m.ease.decelerate,
    'focus-scale': String(m.focusScale),
    'hover-scale': String(m.hoverScale),
  };
}
